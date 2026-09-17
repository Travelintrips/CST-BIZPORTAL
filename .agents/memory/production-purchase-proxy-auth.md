---
name: Production purchase proxy authentication
description: Authentication constraint for purchase routes split between the local API and the external upstream service.
---

Production OTP exchange must establish both a signed local session and an upstream session. Protect the purchase prefix before proxy fallback, while leaving unrelated authentication and API routes outside that middleware.

**Why:** Purchase endpoints have split ownership. A local-only session protects local handlers but leaves proxied purchase handlers unauthenticated; root-scoped middleware also blocks unrelated login and API routes.

**How to apply:** When changing production authentication or purchase routing, verify one local purchase endpoint and one proxied purchase endpoint. Both must return 401 anonymously and work with the same OTP-admin login.