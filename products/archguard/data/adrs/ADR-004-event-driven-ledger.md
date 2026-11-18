---
id: "ADR-004"
code: "ADR-004"
title: "Strict Backward Compatibility on Ledger Ingestion Contracts"
status: "ACCEPTED"
rule_type: "CONTRACT_COMPATIBILITY"
target_property: "contract_policy"
expected_value: "backward_compatible"
governs_target: "/v1/ledger/entries"
author_handle: "priya_fin"
---

# ADR-004: Strict Backward Compatibility on Ledger Ingestion Contracts

## Status
ACCEPTED (Active & Enforced)

## Context
The double-entry ledger endpoint `/v1/ledger/entries` is FinCore's central source of truth, consumed by over 14 distinct downstream systems including reconciliation, taxation, analytics, compliance reporting, and merchant settlement. In past quarters, unannounced field removals or non-additive schema modifications broke downstream batch pipelines and caused multi-hour data voids.

## Decision
All changes to `/v1/ledger/entries` MUST enforce strict backward compatibility:
- `contract_policy` MUST be `backward_compatible`.
- Existing fields cannot be removed or renamed without a minimum 6-month deprecation cycle with zero active consumers.
- New fields MUST be optional (nullable or equipped with safe defaults).
- Any breaking schema modification proposed without a version bump (e.g. `/v2/`) will be automatically rejected.

## Consequences
- **Positive:** Complete stability for mission-critical downstream reporting, auditing, and financial settlement pipelines.
- **Negative:** Schema evolution requires additive modifications and maintaining deprecated fields over long deprecation windows.
