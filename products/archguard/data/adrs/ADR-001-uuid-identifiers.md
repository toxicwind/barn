---
id: "ADR-001"
code: "ADR-001"
title: "Mandate UUIDv4 For User Identifier Schemas"
status: "ACCEPTED"
rule_type: "SCHEMA_FIELD_CONSTRAINT"
target_property: "data_type"
expected_value: "UUIDv4"
governs_target: "user_id"
author_handle: "alex_lead"
---

# ADR-001: Mandate UUIDv4 For User Identifier Schemas

## Status
ACCEPTED (Active & Enforced)

## Context
Historically, early legacy prototypes at FinCore used sequential 64-bit integers (`Int64` / `BIGINT`) for user identifiers. As our microservice footprint grew across auth, billing, and checkout domains, sequential IDs introduced critical security and operational vulnerabilities:
1. **Enumeration Attacks:** Predictable sequence IDs exposed total user volume and made horizontal privilege escalation vulnerabilities easier to exploit.
2. **Database Sharding Conflicts:** Merging partitioned databases and replicating distributed records across multi-region clusters caused primary key collision storms.
3. **Cross-Service Coupling:** Downstream consumers relied on the assumption that IDs were monotonic, breaking distributed event ordering.

## Decision
All schema definitions, API request/response payloads, and database columns representing `user_id` MUST use RFC 4122 compliant **UUIDv4** represented as canonical lowercase strings or native UUID types.

- `data_type` MUST be `UUIDv4`.
- Under NO circumstance may a service alter `user_id` to `Int64`, `BigInt`, or sequential integer types.
- Legacy migrations must follow an approved episodic compromise pattern (such as shadow dual-write columns).

## Consequences
- **Positive:** Immune to enumeration attacks, collision-free distributed generation across edge auth clusters without centralized lock contention.
- **Negative:** Slightly higher storage footprint (128 bits vs 64 bits) and potential index fragmentation in standard B-Trees if not paired with appropriate clustering keys.
