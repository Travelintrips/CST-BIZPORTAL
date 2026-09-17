---
name: General ledger filter test harness
description: Why General Ledger filter tests use a lightweight Select test double instead of Radix's portal implementation.
---

General Ledger filter behavior tests should replace the Radix Select UI with a minimal controlled test double and assert the page's real request and rendered ledger values.

**Why:** Under the current React/jsdom dependency combination, Radix Select's portal focus-scope timers can dispatch after the test interaction and hang or throw during teardown. This is unrelated to General Ledger filter logic.

**How to apply:** Keep the production Select implementation unchanged; mock only `@/components/ui/select` in focused page tests, and retain assertions for request parameters, debit, credit, and running balance.