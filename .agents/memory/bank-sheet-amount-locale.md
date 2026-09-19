---
name: Bank sheet amount locale
description: Locale-sensitive numeric parsing rules for Google Sheet bank mutations.
---

Google Sheets bank values use Indonesian separators: a dot followed by three digits is a thousands grouping, while a comma followed by one or two digits can represent a decimal fraction. Mixed separators should use the last separator as the decimal marker only when its fractional part has at most two digits.

**Why:** A formatted value such as `685.170` was parsed as `685.17`, creating a duplicate mutation with a nominal one thousand times smaller than the canonical row.

**How to apply:** Keep parser tests for Indonesian thousands, Indonesian decimals, and mixed locale formats whenever Sheet synchronization changes.