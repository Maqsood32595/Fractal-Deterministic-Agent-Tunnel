# POSTMORTEM-2024-07-11: RDS Instance Class Upgrade Failure (us-east-1)

**tags:** db, rds, connections, saturation, upgrade, quota
**lastModified:** 2024-07-11
**source:** post-mortems
**doNotExecute:** true
**severity:** P1
**affectedRegion:** us-east-1

## ⚠️ DO NOT EXECUTE: RDS Instance Class Upgrade in us-east-1

**This post-mortem supersedes SOP-204 for the us-east-1 region.**

## Incident Summary
On 2024-07-11, an automated SRE agent attempted to upgrade the RDS instance class from db.t3.medium to db.r6g.large in response to a DB connection pool exhaustion alert in us-east-1.

The upgrade failed because the AWS account had exhausted its quota for db.r6g instance types in the us-east-1 region. The failed upgrade caused a 23-minute outage as the RDS instance was stuck in MODIFYING state and could not accept connections.

## Root Cause
AWS Service Quota: `L-952B80B8` (db.r6g.large On-Demand DB Instances) was at 100% utilization across us-east-1.

## What Went Wrong
The SRE automation followed SOP-204 without checking regional quota first. The instance upgrade failed partway through, leaving the DB in an unmodifiable state. Manual intervention was required to roll back.

## Correct Remediation for us-east-1 DB Saturation
Instead of upgrading instance class, use READ REPLICA routing:
1. Enable the existing read replica endpoint in the application config
2. Route 70% of read queries to the replica
3. This reduces primary connection pressure without touching instance class
4. Request quota increase for db.r6g via AWS Support (24-48h SLA)

## Action Items
- [ ] Add quota pre-check before any RDS upgrade automation
- [ ] Update SOP-204 to include regional quota validation step
- [ ] This post-mortem must be checked before executing SOP-204 in us-east-1

## Tags for Automated Retrieval
rds upgrade us-east-1 db.r6g quota exhausted do-not-execute connection pool
