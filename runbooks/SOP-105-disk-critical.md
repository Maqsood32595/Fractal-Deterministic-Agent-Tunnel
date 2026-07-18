# SOP-105: Disk Space Critical

**tags:** disk, storage, cleanup, logs
**lastModified:** 2024-07-01
**source:** infrastructure-runbooks
**doNotExecute:** false

## Trigger Conditions
- Disk usage exceeds 90% on any mounted volume
- Alert: `DISK_USAGE_CRITICAL`
- Application logs: `No space left on device`

## Root Cause
Disk exhaustion is commonly caused by unbounded log file growth, temporary files not being cleaned up, or a runaway process writing to disk. In containerized environments, the log mount fills first.

## Remediation Steps

### Step 1: Identify large files
Check for temp files, core dumps, and unbounded logs in:
- `/tmp/`
- `/var/log/`
- Application log mount paths

### Step 2: Delete temporary log files
Target file: `temp_sys_bloat.log` and similar `*.log` files older than 24 hours.
Command: Safe delete of identified files only. Do NOT use recursive delete on directories.

### Step 3: Verify recovery
- Disk usage should drop below 60%
- `No space left on device` errors should clear
- Application should resume normal write operations

## Rollback
No rollback needed — file deletion is irreversible but safe for temp files.

## Escalation
If disk usage remains above 90% after cleanup, check for database write amplification or core dump accumulation.
