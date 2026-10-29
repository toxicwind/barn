---
id: "ADR-002"
code: "ADR-002"
title: "Asynchronous Queue Processing for External Payment Webhooks"
status: "ACCEPTED"
rule_type: "ENDPOINT_EXECUTION_MODE"
target_property: "execution_mode"
expected_value: "async_queue"
governs_target: "/v1/webhooks/payment"
author_handle: "sam_platform"
---

# ADR-002: Asynchronous Queue Processing for External Payment Webhooks

## Status
ACCEPTED (Active & Enforced)

## Context
During Q3, a sudden partner gateway outage resulted in thousands of webhooks being retried concurrently. Our `/v1/webhooks/payment` endpoint was implemented synchronously, opening long-lived database transactions while awaiting downstream fulfillment responses. 

This tied up the entire Node.js event loop and exhausted the HTTP worker connection pool, cascading into total platform unavailability for 47 minutes (Incident INC-2023-88).

## Decision
The `/v1/webhooks/payment` endpoint MUST operate in `async_queue` execution mode:
1. Upon receiving an inbound HTTP POST webhook payload, the gateway must perform signature verification and immediately push the raw event onto a persistent queue (RabbitMQ / Redis Streams / Kafka).
2. The endpoint MUST return an immediate `202 Accepted` response within `< 50ms`.
3. Downstream processing workers consume events asynchronously from the queue with an exponential backoff Dead Letter Queue (DLQ) policy.
4. **Prohibition:** Synchronous RPC processing or inline ledger commits on inbound webhook ingress paths are strictly forbidden.

## Consequences
- **Positive:** Guarantees ingress resilience; external partner retries cannot overwhelm core services or exhaust database connection pools.
- **Negative:** Eventual consistency across payment ledger states; requires idempotent consumers with deduplication windows.
