# SOP-404: Container OOMKilled

**tags:** memory, oom, container, kubernetes, docker
**lastModified:** 2024-07-05
**source:** infrastructure-runbooks
**doNotExecute:** false

## Trigger Conditions
- Pod/container terminated with Exit Code 137
- Kubernetes event: `OOMKilled`
- Alert: `CONTAINER_MEMORY_LIMIT_EXCEEDED`

## Root Cause
OOMKilled occurs when a container exceeds its configured memory limit. The Linux kernel's OOM killer terminates the process to protect the host. Common causes: memory leak, undersized memory limit, traffic spike causing in-memory cache growth.

## Remediation Steps

### Step 1: Confirm OOMKill
Check pod status for Exit Code 137 and reason OOMKilled.
Verify: `kubectl describe pod <pod-name>` or check container state via API.

### Step 2: Double the memory limit
Patch the container configuration:
```
mem_limit: 256m  →  mem_limit: 512m
```
Rebuild and restart the container.

### Step 3: Verify recovery
- Container should restart cleanly with Running state
- Exit Code 137 should not recur in next 10 minutes
- Memory usage should stabilize below 80% of new limit

## Long-Term Fix
If OOMKills recur after doubling, instrument the application with heap profiling to identify the memory leak root cause.

## Rollback
Revert mem_limit to 256m only if the increased memory causes host-level resource pressure.

## Escalation
If container OOMKills 3 times within 1 hour, escalate to application team.
