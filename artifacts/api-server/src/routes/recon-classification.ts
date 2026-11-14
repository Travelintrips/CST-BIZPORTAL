import { Router } from "express";
import { pool } from "@workspace/db";
import { evaluateReconRules, validateReconRule, type ReconRule } from "../lib/reconciliation/reconRuleEngine.js";

const router = Router();

const parsePositiveInt = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

const companyId = (req: any) =>
  parsePositiveInt(req.query.company_id ?? req.body?.company_id);

const reconciliationAccountId = (req: any) =>
  parsePositiveInt(req.query.bank_account_id ?? req.body?.bank_account_id);

const actionFlowForTargetType = (targetType: unknown): string | null => {
  switch (String(targetType ?? "").trim().toLowerCase()) {
    case "internal_transfer":
    case "intercompany_transfer":
      return "INTERNAL_TRANSFER";
    case "income":
      return "INCOME_ALLOCATION";
    case "expense":
      return "ROUTINE_EXPENSE_ALLOCATION";
    default:
      return null;
  }
};

const targetTypeForInput = (body: any): string => {
  // Action Flow is the editable UI source of truth. When editing an existing
  // rule, the form also carries the previous target_type. If that stale value
  // wins here, changing Routine Expense -> Internal Transfer appears to save
  // but reloads as Routine Expense again.
  switch (String(body?.action_flow ?? "").trim().toUpperCase()) {
    case "INTERNAL_TRANSFER":
      return "internal_transfer";
    case "INCOME_ALLOCATION":
      return "income";
    case "ROUTINE_EXPENSE_ALLOCATION":
      return "expense";
  }

  // Preserve specialized canonical target types (payroll, employee_advance,
  // etc.) for forms that do not expose a generic Action Flow.
  const explicit = String(body?.target_type ?? "").trim().toLowerCase();
  if (explicit) return explicit;

  return String(body?.direction ?? "").trim().toUpperCase() === "IN"
    ? "income"
    : "expense";
};

const mapRule = (r: any) => ({
  ...r,
  confidence: Number(r.confidence_score ?? 0) / 100,
  conditions: r.conditions_json ?? [],
  action_flow: r.action_flow ?? actionFlowForTargetType(r.target_type),
  action_coa_code: r.target_coa_code,
  action_coa_name: r.target_coa_name ?? null,
  source: "public.recon_rules",
});

async function validateReconciliationAccount(
  companyIdValue: number,
  bankAccountIdValue: number,
): Promise<boolean> {
  const result = await pool.query(
    `select 1
       from public.bank_sheet_configs config
       join public.company_bank_accounts account
         on account.id = config.bank_account_id
        and account.company_id = config.company_id
        and coalesce(account.is_active, true) = true
      where config.company_id = $1
        and config.bank_account_id = $2
        and config.is_active = true
      limit 1`,
    [companyIdValue, bankAccountIdValue],
  );
  return (result.rowCount ?? 0) > 0;
}

router.get("/recon-classification/coa-options", async (req, res) => {
  const cid = companyId(req);
  if (!cid) {
    res.status(400).json({ error: "company_id wajib" });
    return;
  }

  const q = await pool.query(
    `select distinct on (c.code)
       c.id,
       c.company_id as "companyId",
       c.code,
       c.name,
       c.type::text as type,
       c.normal_balance as "normalBalance",
       c.parent_id as "parentId",
       coalesce(c.is_active,true) as "isActive",
       coalesce(c.is_postable,not coalesce(c.is_header,false)) as "isPostable",
       coalesce(c.is_header,false) as "isHeader"
     from public.chart_of_accounts c
     where c.company_id=$1 or c.company_id is null
     order by c.code,(c.company_id=$1) desc,c.id desc`,
    [cid],
  );
  res.json({ data: q.rows });
});

router.get("/recon-classification/ai-rules", async (req, res) => {
  const cid = companyId(req);
  const bankAccountId = reconciliationAccountId(req);
  if (!cid || !bankAccountId) {
    res.status(400).json({
      error: "company_id dan bank_account_id Akun Rekonsiliasi wajib",
    });
    return;
  }
  if (!(await validateReconciliationAccount(cid, bankAccountId))) {
    res.status(400).json({ error: "Akun Rekonsiliasi tidak valid atau tidak aktif" });
    return;
  }

  const q = await pool.query(
    `select r.*, c.name target_coa_name
       from public.recon_rules r
       left join public.chart_of_accounts c
         on c.code = r.target_coa_code
        and (c.company_id = r.company_id or c.company_id is null)
      where r.company_id = $1
        and r.bank_account_id = $2
      order by r.is_active desc, r.priority desc, r.id`,
    [cid, bankAccountId],
  );
  res.json({ data: q.rows.map(mapRule) });
});

router.post("/recon-classification/ai-rules", async (req, res) => {
  const cid = companyId(req);
  const bankAccountId = reconciliationAccountId(req);
  if (!cid || !bankAccountId) {
    res.status(400).json({
      error: "company_id dan bank_account_id Akun Rekonsiliasi wajib",
    });
    return;
  }
  if (!(await validateReconciliationAccount(cid, bankAccountId))) {
    res.status(400).json({ error: "Akun Rekonsiliasi tidak valid atau tidak aktif" });
    return;
  }

  const b = req.body ?? {};
  const conf = Math.round(Number(b.confidence ?? 0.8) * 100);
  const q = await pool.query(
    `insert into public.recon_rules(
       company_id,name,description,priority,is_active,direction,bank_account_id,
       condition_field,condition_operator,condition_value,target_type,target_id,
       target_coa_code,confidence_score,stop_processing,created_by,conditions_json,
       logic,specificity,amount_tolerance,reference_amount,requires_document_upload,
       tax_type,candidate_requirement
     )
     values(
       $1,$2,$3,$4,true,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'bizportal',
       $15::jsonb,$16,$17,$18,$19,$20,$21,$22
     )
     returning *`,
    [
      cid,
      b.name ?? "Rule AI",
      b.description ?? null,
      b.priority ?? 50,
      b.direction ?? null,
      bankAccountId,
      b.condition_field ?? "description",
      b.condition_operator ?? "contains",
      b.condition_value ?? "",
      targetTypeForInput(b),
      b.target_id ?? null,
      b.action_coa_code ?? b.target_coa_code ?? null,
      conf,
      b.stop_processing ?? true,
      JSON.stringify(b.conditions ?? []),
      b.logic ?? "AND",
      b.specificity ?? 1,
      b.amount_tolerance ?? 0,
      b.reference_amount ?? null,
      !!b.requires_document_upload,
      b.tax_type ?? "none",
      b.candidate_requirement ?? "not_required",
    ],
  );
  res.status(201).json({ data: mapRule(q.rows[0]) });
});

router.patch("/recon-classification/ai-rules/:id", async (req, res) => {
  const cid = companyId(req);
  const id = parsePositiveInt(req.params.id);
  const bankAccountId = reconciliationAccountId(req);
  if (!cid || !id || !bankAccountId) {
    res.status(400).json({
      error: "ID, company_id, dan bank_account_id Akun Rekonsiliasi wajib",
    });
    return;
  }
  if (!(await validateReconciliationAccount(cid, bankAccountId))) {
    res.status(400).json({ error: "Akun Rekonsiliasi tidak valid atau tidak aktif" });
    return;
  }

  const current = await pool.query<{ bank_account_id: number | null }>(
    `select bank_account_id
       from public.recon_rules
      where id = $1 and company_id = $2
      limit 1`,
    [id, cid],
  );
  if (!current.rowCount) {
    res.status(404).json({ error: "Rule tidak ditemukan" });
    return;
  }
  const currentBankAccountId = current.rows[0]?.bank_account_id == null
    ? null
    : Number(current.rows[0].bank_account_id);
  if (currentBankAccountId !== bankAccountId) {
    res.status(409).json({
      error: "Rule AI tidak boleh dipindahkan ke Akun Rekonsiliasi lain. Buat rule baru pada akun tujuan.",
    });
    return;
  }

  const b = req.body ?? {};
  const conf = Math.round(Number(b.confidence ?? 0.8) * 100);
  const q = await pool.query(
    `update public.recon_rules
        set name=$3,
            description=$4,
            priority=$5,
            direction=$6,
            condition_field=$7,
            condition_operator=$8,
            condition_value=$9,
            target_type=$10,
            target_id=$11,
            target_coa_code=$12,
            confidence_score=$13,
            stop_processing=$14,
            conditions_json=$15::jsonb,
            logic=$16,
            specificity=$17,
            amount_tolerance=$18,
            reference_amount=$19,
            requires_document_upload=$20,
            tax_type=$21,
            candidate_requirement=$22,
            updated_at=now()
      where id=$1
        and company_id=$2
        and bank_account_id=$23
      returning *`,
    [
      id,
      cid,
      b.name,
      b.description ?? null,
      b.priority ?? 50,
      b.direction ?? null,
      b.condition_field,
      b.condition_operator,
      b.condition_value,
      targetTypeForInput(b),
      b.target_id ?? null,
      b.action_coa_code ?? b.target_coa_code ?? null,
      conf,
      b.stop_processing ?? true,
      JSON.stringify(b.conditions ?? []),
      b.logic ?? "AND",
      b.specificity ?? 1,
      b.amount_tolerance ?? 0,
      b.reference_amount ?? null,
      !!b.requires_document_upload,
      b.tax_type ?? "none",
      b.candidate_requirement ?? "not_required",
      bankAccountId,
    ],
  );
  if (!q.rowCount) {
    res.status(404).json({ error: "Rule tidak ditemukan pada Akun Rekonsiliasi ini" });
    return;
  }
  res.json({ data: mapRule(q.rows[0]) });
});

router.post("/recon-classification/ai-rules/:id/activate", async (req, res) => {
  const cid = companyId(req);
  const id = parsePositiveInt(req.params.id);
  const bankAccountId = reconciliationAccountId(req);
  if (!cid || !id || !bankAccountId) {
    res.status(400).json({ error: "ID, company_id, dan bank_account_id Akun Rekonsiliasi wajib" });
    return;
  }
  const q = await pool.query(
    `update public.recon_rules
        set is_active=true,updated_at=now()
      where id=$1 and company_id=$2 and bank_account_id=$3
      returning id,is_active`,
    [id, cid, bankAccountId],
  );
  if (!q.rowCount) {
    res.status(404).json({ error: "Rule tidak ditemukan pada Akun Rekonsiliasi ini" });
    return;
  }
  res.json({ ok: true, data: q.rows[0] });
});

router.delete("/recon-classification/ai-rules/:id", async (req, res) => {
  const cid = companyId(req);
  const id = parsePositiveInt(req.params.id);
  const bankAccountId = reconciliationAccountId(req);
  if (!cid || !id || !bankAccountId) {
    res.status(400).json({ error: "ID, company_id, dan bank_account_id Akun Rekonsiliasi wajib" });
    return;
  }
  const q = await pool.query(
    `update public.recon_rules
        set is_active=false,updated_at=now()
      where id=$1 and company_id=$2 and bank_account_id=$3
      returning id`,
    [id, cid, bankAccountId],
  );
  if (!q.rowCount) {
    res.status(404).json({ error: "Rule tidak ditemukan pada Akun Rekonsiliasi ini" });
    return;
  }
  res.json({ ok: true });
});

// Read-only preview of the *unsaved editor draft*. Reuse the operational
// evaluator; never create candidates, modify rules, or approve/post journals.
router.post("/recon-classification/ai-rules/preview", async (req, res) => {
  const cid = companyId(req);
  const bankAccountId = reconciliationAccountId(req);
  if (!cid || !bankAccountId) {
    res.status(400).json({ error: "company_id dan bank_account_id wajib" });
    return;
  }
  if (!(await validateReconciliationAccount(cid, bankAccountId))) {
    res.status(400).json({ error: "Akun Rekonsiliasi tidak valid atau tidak aktif" });
    return;
  }

  const b = req.body ?? {};
  const description = String(b.description ?? "").trim();
  const conditions = b.conditions;
  if (!description || !Array.isArray(conditions) || conditions.length === 0 ||
      conditions.length > 30 || conditions.some((c: any) =>
        !c || typeof c.field !== "string" || typeof c.operator !== "string" ||
        typeof c.value !== "string" || !c.value.trim())) {
    res.status(400).json({ error: "Deskripsi dan kondisi rule yang valid wajib diisi" });
    return;
  }
  const amount = b.amount == null || b.amount === "" ? 0 : Number(b.amount);
  const referenceAmount = b.reference_amount == null || b.reference_amount === ""
    ? null : Number(b.reference_amount);
  const tolerance = Number(b.amount_tolerance ?? 0);
  const confidence = Number(b.confidence ?? 0.8);
  if (!Number.isFinite(amount) || amount < 0 ||
      (referenceAmount !== null && (!Number.isFinite(referenceAmount) || referenceAmount < 0)) ||
      !Number.isFinite(tolerance) || tolerance < 0 ||
      (tolerance > 0 && referenceAmount === null) ||
      !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    res.status(400).json({ error: "Nominal, toleransi, atau confidence tidak valid" });
    return;
  }

  const flow = String(b.action_flow ?? "").toUpperCase();
  // The UI must supply an explicit direction where available. For the current
  // editor (which has no direction field), infer the preview direction from flow.
  const direction = b.direction === "IN" || b.direction === "OUT"
    ? b.direction : flow === "INCOME_ALLOCATION" ? "IN" : "OUT";
  const targetType = targetTypeForInput(b) as ReconRule["targetType"];
  const draft: ReconRule = {
    id: -1, companyId: cid, name: String(b.rule_name ?? "Draft rule"),
    description: null, priority: Number(b.priority ?? 50), isActive: true,
    direction, bankAccountId, conditionType: "COMPOUND",
    conditionField: conditions[0].field,
    conditionOperator: conditions[0].operator,
    conditionValue: conditions[0].value,
    conditionsJson: conditions, logic: b.logic === "OR" ? "OR" : "AND",
    specificity: Number(b.specificity ?? conditions.length),
    amountTolerance: tolerance, referenceAmount,
    candidateRequirement: b.candidate_requirement === "required" ? "required" : "not_required",
    requiresDocumentUpload: Boolean(b.requires_document_upload),
    taxType: b.tax_type === "ppn_input" || b.tax_type === "ppn_output" ? b.tax_type : "none",
    targetType, targetId: null,
    targetCoaCode: b.action_coa_code ?? null,
    confidenceScore: Math.round(confidence * 100),
    stopProcessing: true, matchCount: 0, lastMatchedAt: null,
    createdBy: null, createdAt: "", updatedAt: "",
  };
  const errors = validateReconRule(draft);
  if (errors.length) {
    res.status(400).json({ error: errors.join("; ") });
    return;
  }
  const result = evaluateReconRules([draft], {
    description, amount, direction, bankAccountId, companyId: cid,
    reference: b.reference ? String(b.reference) : null,
    hasDocumentUpload: Boolean(b.has_document_upload),
  });
  res.json({
    preview: true, previewScope: "draft_only",
    matched: result.matched,
    ambiguityCode: result.ambiguityCode ?? null,
    ambiguityReason: result.ambiguityReason ?? null,
    documentRequired: result.documentRequired ?? null,
    evaluated: result.evaluated,
    matchedConditions: result.reasons ?? [],
    rule: result.matched ? {
      id: draft.id, name: draft.name, targetType: result.targetType,
      targetCoaCode: result.targetCoaCode, confidence: result.confidence,
      candidateRequirement: draft.candidateRequirement,
    } : null,
  });
});

export default router;
