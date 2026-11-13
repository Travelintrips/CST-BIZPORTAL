# DEV Marketplace Vendor Invoice/AP — restore canonical upstream services

## What this change does (no rewrite)
This patch restores the upstream `mktVendorInvoiceService` and `mktApPreparationService` with their exact existing Drizzle schema, log/notification helpers, token upload route, magic-byte validation and Supabase private Storage implementation. The only upstream business-route hardening rejects legacy vendor PO tokens whose PO has no positive company/vendor identity. An additional standalone admin adapter **calls** these existing services; it does not implement duplicate invoice, 3-way match, AP or GL SQL.

It is stacked on the DEV-only read/finance-readiness bridge (PR #297). It does not modify Customer Portal's current RFQ/PO or shipment writer and adds **no Accounting posting** function.

## Release flags (default OFF)
Only in BizPortal standalone **DEV**:
- `APP_ENV=development`; `NODE_ENV` must not be `production`.
- `BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV=true` enables authorized admin match/AP actions.
- `BIZPORTAL_MARKETPLACE_VENDOR_INVOICE_ENABLED_DEV=true` enables the existing token-scoped vendor invoice upload/list/submit route.

Leave both OFF on all PROD and unverified runtimes. Never set them before the approved CI, Storage and dedicated DB credential checks. `resolveDatabaseUrl()` independently verifies the project reference is DEV `xssrfshdrtdfupgqwfdw`, rejecting PROD `nzdweipzckfszczzqtuw`.

## Security and lifecycle
- Admin actions use a verified signed BizPortal OTP session; role must be `super_admin` during initial DEV activation (fail closed for other roles until tenant-scoped Marketplace authorization is separately certified). No forged Customer Portal cookie or caller-supplied role is accepted.
- Vendor invoice creation stays behind the original 64-hex PO vendor token with expiry, file size/type/magic validation and private bucket uploads. Legacy PO with null company/vendor is explicitly rejected.
- Admin actions reject nonempty mutation payloads and validate company, PO, supplier and receipt alignment. Finance-review/waiting-payment also validate linked `ready_for_ap` vendor invoice and `passed` 3-way match.
- Existing service uses row locks, duplicate/transition protection and canonical AP invoice-reference uniqueness. Payment execution, journal posting and bank settlement are **outside** these routes and remain under the existing Finance/Accounting modules.
- Do not use historical PO 2 (`company_id` NULL), expired vendor token, or payment 245 (`exim_service` missing COA) as a financial success fixture. Do not reassign history or blindly replay.

## Evidence on isolated worktree (not live Hostinger DEV)
- `tsc` library/API PASS; API build PASS.
- Route regression tests 36/36 PASS (including existing read routes).
- Isolated real Node API bound only to `127.0.0.1:18977`: unsigned admin requests returned 401; malformed vendor token returned 400 TOKEN_INVALID; vendor OPTIONS route registered, no financial writes performed.
- The token and AP tests use isolated mocks and do not prove real invoice upload, payment, or Accounting E2E.

## Runtime activation gates
1. Review the stacked PR, preserve the existing DEV Reader PR, run full API/DB CI and perform release-diff review.
2. Confirm **only BizPortal standalone** owns Marketplace vendor-invoice/AP writes; Customer Portal retains its RFQ/PO/shipment writer, with no second vendor/AP writer.
3. Configure DEV-only Supabase Storage service-role and isolated database credentials via secret manager. Verify bucket `private-uploads`, file upload and cleanup, and do not send secrets in logs or Git.
4. Deploy to DEV in a reversible release, with flags initially OFF. Confirm liveness, readiness, unchanged RFQ/PO and Payroll/Accounting routes.
5. Enable flags only for a controlled session. Test valid company-scoped fresh PO → delivered shipment/accepted GR → vendor PDF upload → invoice match → AP `waiting_payment`. Repeat same requests, verify no duplicate invoice, AP or queue event and verify tenant isolation.
6. Payment module and Accounting posting require separate approval and end-to-end evidence (including COA mapping and period locks). Do **not** mark Accounting E2E PASS from this AP wiring.

## Rollback
Set both `BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV` and `BIZPORTAL_MARKETPLACE_VENDOR_INVOICE_ENABLED_DEV` to false and restart **DEV only**. Existing read routes and RFQ/PO flow remain untouched. Never delete previously posted financial records as part of rollback.
