import { Router } from "express";
import { pool } from "@workspace/db";

const router = Router();
const companyId = (req:any) => {
  const n=Number(req.query.company_id ?? req.body?.company_id);
  return Number.isSafeInteger(n)&&n>0?n:null;
};
const mapRule=(r:any)=>({...r,confidence:Number(r.confidence_score??0)/100,conditions:r.conditions_json??[],action_coa_code:r.target_coa_code,action_coa_name:r.target_coa_name??null,source:"public.recon_rules"});

router.get("/recon-classification/coa-options",async(req,res)=>{
  const cid=companyId(req); if(!cid){res.status(400).json({error:"company_id wajib"});return;}
  const q=await pool.query(
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
  res.json({data:q.rows});
});

router.get("/recon-classification/ai-rules",async(req,res)=>{
  const cid=companyId(req); if(!cid){res.status(400).json({error:"company_id wajib"});return;}
  const q=await pool.query(`select r.*,c.name target_coa_name from public.recon_rules r left join public.chart_of_accounts c on c.code=r.target_coa_code and (c.company_id=r.company_id or c.company_id is null) where r.company_id=$1 order by r.is_active desc,r.priority desc,r.id`,[cid]);
  res.json({data:q.rows.map(mapRule)});
});
router.post("/recon-classification/ai-rules",async(req,res)=>{
  const cid=companyId(req); if(!cid){res.status(400).json({error:"company_id wajib"});return;}
  const b=req.body??{}, conf=Math.round(Number(b.confidence??0.8)*100);
  const q=await pool.query(`insert into public.recon_rules(company_id,name,description,priority,is_active,direction,bank_account_id,condition_field,condition_operator,condition_value,target_type,target_id,target_coa_code,confidence_score,stop_processing,created_by,conditions_json,logic,specificity,amount_tolerance,reference_amount,requires_document_upload,tax_type,candidate_requirement)
 values($1,$2,$3,$4,true,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'bizportal', $15::jsonb,$16,$17,$18,$19,$20,$21,$22) returning *`,[cid,b.name??"Rule AI",b.description??null,b.priority??50,b.direction??null,b.bank_account_id??null,b.condition_field??"description",b.condition_operator??"contains",b.condition_value??"",b.target_type??null,b.target_id??null,b.action_coa_code??b.target_coa_code??null,conf,b.stop_processing??true,JSON.stringify(b.conditions??[]),b.logic??"AND",b.specificity??1,b.amount_tolerance??0,b.reference_amount??null,!!b.requires_document_upload,b.tax_type??"none",b.candidate_requirement??"not_required"]);
  res.status(201).json({data:mapRule(q.rows[0])});
});
router.patch("/recon-classification/ai-rules/:id",async(req,res)=>{
  const cid=companyId(req),id=Number(req.params.id); if(!cid||!Number.isSafeInteger(id)){res.status(400).json({error:"ID/company tidak valid"});return;}
  const b=req.body??{},conf=Math.round(Number(b.confidence??0.8)*100);
  const q=await pool.query(`update public.recon_rules set name=$3,description=$4,priority=$5,direction=$6,bank_account_id=$7,condition_field=$8,condition_operator=$9,condition_value=$10,target_type=$11,target_id=$12,target_coa_code=$13,confidence_score=$14,stop_processing=$15,conditions_json=$16::jsonb,logic=$17,specificity=$18,amount_tolerance=$19,reference_amount=$20,requires_document_upload=$21,tax_type=$22,candidate_requirement=$23,updated_at=now() where id=$1 and company_id=$2 returning *`,[id,cid,b.name,b.description??null,b.priority??50,b.direction??null,b.bank_account_id??null,b.condition_field,b.condition_operator,b.condition_value,b.target_type??null,b.target_id??null,b.action_coa_code??b.target_coa_code??null,conf,b.stop_processing??true,JSON.stringify(b.conditions??[]),b.logic??"AND",b.specificity??1,b.amount_tolerance??0,b.reference_amount??null,!!b.requires_document_upload,b.tax_type??"none",b.candidate_requirement??"not_required"]);
  if(!q.rowCount){res.status(404).json({error:"Rule tidak ditemukan"});return;} res.json({data:mapRule(q.rows[0])});
});
router.post("/recon-classification/ai-rules/:id/activate",async(req,res)=>{
  const cid=companyId(req),id=Number(req.params.id);
  if(!cid||!Number.isSafeInteger(id)){res.status(400).json({error:"ID/company tidak valid"});return;}
  const q=await pool.query("update public.recon_rules set is_active=true,updated_at=now() where id=$1 and company_id=$2 returning id,is_active",[id,cid]);
  if(!q.rowCount){res.status(404).json({error:"Rule tidak ditemukan"});return;}
  res.json({ok:true,data:q.rows[0]});
});
router.delete("/recon-classification/ai-rules/:id",async(req,res)=>{
  const cid=companyId(req),id=Number(req.params.id);if(!cid||!Number.isSafeInteger(id)){res.status(400).json({error:"ID/company tidak valid"});return;}
  const q=await pool.query("update public.recon_rules set is_active=false,updated_at=now() where id=$1 and company_id=$2 returning id",[id,cid]);if(!q.rowCount){res.status(404).json({error:"Rule tidak ditemukan"});return;}res.json({ok:true});
});
router.post("/recon-classification/ai-rules/preview",async(req,res)=>{
  res.json({matched:false,preview:true,message:"Preview tersimpan di UI; evaluasi produksi menggunakan engine Rule AI saat run matching."});
});
export default router;
