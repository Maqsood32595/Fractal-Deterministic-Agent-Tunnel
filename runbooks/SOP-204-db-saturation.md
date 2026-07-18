# SOP-204: DB Connection Pool Exhaustion

**tags:** db, rds, connections, saturation
**lastModified:** 2024-06-15
**source:** infrastructure-runbooks
**doNotExecute:** false

## Trigger Conditions
- Active DB connections exceed 90% of max pool limit
- PagerDuty alert: `DB_CONNECTION_POOL_EXHAUSTED`
- HTTP 503 errors spiking above 50%

## Root Cause
Connection pool exhaustion occurs when the number of concurrent database connections exceeds the configured maximum. Common causes: traffic spike, connection leak in application code, undersized RDS instance class.

## Remediation Steps

### Step 1: Verify the connection count
Query Prometheus: `db_active_connections / db_max_connections > 0.9`

### Step 2: Upgrade RDS instance class
Patch the docker-compose environment variable:
```
INSTANCE_CLASS=db.r6g.large
MAX_CONNECTIONS=500
```
Then rebuild the container.

### Step 3: Verify recovery
- Active connections should drop below 50% of new max
- HTTP error rate should return below 1%
- Latency should normalize below 100ms

## Rollback
Revert INSTANCE_CLASS to db.t3.medium if costs spike unexpectedly.

## Escalation
If connections remain saturated after upgrade, escalate to DB team (Tier 3).
