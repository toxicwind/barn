---
id: "ADR-003"
code: "ADR-003"
title: "Strict High-Precision Decimal Representation for Monetary Amounts"
status: "ACCEPTED"
rule_type: "SCHEMA_FIELD_CONSTRAINT"
target_property: "data_type"
expected_value: "Decimal128"
governs_target: "transaction_amount"
author_handle: "priya_fin"
---

# ADR-003: Strict High-Precision Decimal Representation for Monetary Amounts

## Status
ACCEPTED (Active & Enforced)

## Context
IEEE 754 standard floating-point types (`Float`, `Double`, `float32`, `float64`) inherently suffer from binary rounding errors when representing base-10 fractions (e.g., `0.1 + 0.2 = 0.30000000000000004`). In financial ledger systems, even minute rounding discrepancies accumulate across millions of daily transactions, leading to reconciliation mismatches, tax audit failures, and regulatory compliance breaches.

## Decision
All monetary values, fee calculations, balances, and transaction amounts (specifically `transaction_amount`) MUST be modeled using fixed-point precision or arbitrary-precision decimal representations:
- Database column and API contract `data_type` MUST be `Decimal128` (or integer minor units / cents if explicitly annotated).
- The use of `Float`, `Double`, or standard JS/Python floating point representations for `transaction_amount` is strictly prohibited.
- Serialized JSON schemas must encode decimal amounts as exact numeric strings or dedicated high-precision decimal objects to avoid client-side deserialization truncation.

## Consequences
- **Positive:** Exact mathematical precision across all currency operations, compliant with GAAP, IFRS, and SOX financial audit standards.
- **Negative:** Requires specialized mathematical libraries for arithmetic operations (e.g., `decimal.js` or `bignumber.js`) rather than native CPU floating-point instructions.
