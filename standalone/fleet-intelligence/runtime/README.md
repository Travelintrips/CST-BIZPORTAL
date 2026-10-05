# Standalone runtime boundary

This runtime scaffold is intentionally isolated from the production BizPortal app.

It establishes three mandatory boundaries before extraction proceeds:

1. **Environment guard** — rejects obvious DEV/PROD database cross-wiring.
2. **Central Finance client** — Fleet accounting writes must leave Fleet over an idempotent integration contract, not direct writes to Central Finance tables.
3. **WA Gateway client** — new standalone Fleet uses CST WA Gateway, not direct Fonnte calls.

`health-server.mjs` is only a deployment/boot scaffold. It does not expose Fleet business APIs yet.
