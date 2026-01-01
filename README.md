Here’s a practical AWS plan to offload ACME Liquors’ overloaded SQL order system using a **non-SQL** backend (centered on **Amazon DynamoDB**) while keeping the business running during migration.

## 1) What’s breaking today (typical symptoms)

When a business expands into new “wet” counties, order volume spikes and SQL systems often choke on:

* Hot tables (orders / order_items) and lock contention
* Bursty traffic (Friday nights, holidays) causing slow queries + timeouts
* Scaling limits (vertical scaling, read replicas still bottleneck on writes)
* Complex joins/reporting competing with OLTP workloads

Goal: **separate “take orders fast” from “analyze/report”**, and scale writes horizontally.

---

## 2) Target AWS architecture (high-level)

### Front door (order intake)

* **API Gateway** (or ALB) + **Lambda** (or ECS/Fargate) for order endpoints
* **WAF** + rate limiting for protection

### System of record (non-SQL)

* **Amazon DynamoDB** as the primary order store (massively scalable, low-latency, managed)

### Reliable processing (async)

* **SQS** (queue) for downstream steps: payment capture, inventory reservation, notifications, fraud checks, etc.
* **Lambda** workers (or ECS consumers) process messages with retries + dead-letter queues

### Event stream (reactive integration)

* **DynamoDB Streams** to publish events on new/updated orders
* Route events to:

  * **EventBridge** (fan-out) for microservices
  * **SNS** for notifications

### Reporting / analytics (separate workload)

* Export events to **S3** (via Firehose/Lambda) → query with **Athena** or load curated datasets to **Redshift**
* This prevents “reports” from slowing order entry.

---

## 3) DynamoDB data model (the part that matters)

Design DynamoDB around *access patterns*, not normalization.

### Core tables

**A) Orders table**

* **PK**: `customer_id` (or `tenant_id#customer_id`)
* **SK**: `order_ts#order_id` (sortable, unique)
* Attributes: status, county_id, store_id, totals, payment_state, etc.

**B) OrderById table** (fast direct lookups)

* **PK**: `order_id`
* Attributes duplicated from Orders (DynamoDB encourages denormalization)

**C) Inventory / Reservations**

* For each SKU + store, keep a stock record and reservation ledger.

### Indexes (GSIs) for common queries

* **GSI1**: by `county_id + order_ts` (county ops dashboards)
* **GSI2**: by `store_id + order_ts` (store fulfillment)
* **GSI3**: by `status + order_ts` (pick/pack queues)

### Performance / cost controls

* Use **On-Demand capacity** initially (easy + bursty), then move to **Provisioned + Auto Scaling** when stable.
* Add **TTL** for ephemeral records (carts, short-lived reservations).
* Consider **DAX** (DynamoDB Accelerator) if you have heavy read bursts.

---

## 4) Workflow design: “fast accept, then process”

Instead of doing everything inside the checkout request:

1. Client submits order → API validates basics
2. Write order to DynamoDB with status `PENDING`
3. Enqueue `order_id` to SQS
4. Background workers:

   * reserve inventory
   * process payment
   * update status (`CONFIRMED` / `FAILED`)
   * emit events for shipping/notifications

This makes the system resilient to spikes: if traffic surges, **queues absorb it**.

---

## 5) Consistency, idempotency, and “no double orders”

This is where many migrations fail—build these in:

* **Idempotency key** (e.g., `client_request_id`) stored with the order
* Use **conditional writes** in DynamoDB:

  * “create only if not exists”
  * “update only if current status is X”
* SQS consumer must be idempotent:

  * safe to retry without double-charging or double-reserving
* Use **transactional writes** (DynamoDB Transactions) where you truly need atomicity (e.g., reserve inventory + create reservation record)

---

## 6) Migration plan (minimal downtime)

### Phase 0 — Inventory access patterns + schema

* Map required queries (by customer, store, county, status, order_id)
* Create DynamoDB tables + GSIs
* Build the new order API in parallel

### Phase 1 — Dual write (safest)

* New order path writes to DynamoDB **and** SQL (temporarily)
* SQL remains the legacy source for some downstream systems until they’re migrated

### Phase 2 — Backfill history

* Use **AWS DMS** or custom batch jobs to copy historical orders into DynamoDB/S3

### Phase 3 — Cut reads over

* Read traffic shifts to DynamoDB (feature flag / gradual rollout)
* Keep SQL for legacy reporting until analytics pipeline is complete

### Phase 4 — Retire SQL from OLTP

* SQL becomes reporting-only (or retired after audit/compliance needs are met)

---

## 7) Security + compliance (alcohol sales reality)

* **IAM least privilege** per service
* **KMS encryption** at rest (DynamoDB + S3)
* **TLS everywhere**
* **Audit trails**: CloudTrail + immutable logs to S3 with Object Lock (if needed)
* PII tokenization strategy if storing customer info (or keep customer PII in a separate secure store)

---

## 8) What ACME gets from this

* Order intake scales automatically (no lock contention)
* Spikes handled via queue buffering
* Faster customer experience (checkout returns quickly)
* Analytics no longer competes with order processing
* Easier multi-county expansion: add capacity without re-architecting

---

If you tell me the top 5 queries ACME runs today (e.g., “orders by county last 24h”, “customer order history”, “store pick list”, etc.), I can propose an exact DynamoDB key/index design and an event flow diagram that matches those access patterns.

