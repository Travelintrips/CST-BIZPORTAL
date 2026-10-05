# Safe separation plan

## Phase 1
Create an isolated source snapshot and integration boundary without changing production.

## Phase 2
Bootstrap standalone frontend/server, remove BizPortal-only coupling, add health checks and CI.

## Phase 3
Separate Fleet-owned data access. DEV and PROD credentials must be different. Central Finance remains external and posted journals are immutable.

## Phase 4
Deploy DEV to `dev-fleet.cstlogistic.co.id`, run CSV import, driver/vehicle, outstanding, WA test, accounting preview, reconciliation, auth and company-scope tests.

## Phase 5
Provision `fleet.cstlogistic.co.id`, run read-only parallel validation, then switch BizPortal launcher after approval.

## Phase 6
Only after production sign-off remove duplicated embedded Fleet code from BizPortal.
