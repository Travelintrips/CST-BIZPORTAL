# Fleet Intelligence standalone extraction

This directory is a **non-production extraction workspace** for separating Fleet Intelligence from BizPortal safely.

## Safety
- Production BizPortal behavior is unchanged.
- Existing Fleet routes remain the source of truth during extraction.
- No DNS, database, deployment, or production credential is changed here.
- Do not cut over `fleet.cstlogistic.co.id` until DEV validation passes.
- Central Finance stays external; Fleet must integrate through an explicit contract/API.

## Target
- PROD: `fleet.cstlogistic.co.id`
- DEV: `dev-fleet.cstlogistic.co.id`
- API: same-origin under `/api`
- Future repo: `Travelintrips/Fleet-Intelligence`
- BizPortal remains launcher/integration hub.
