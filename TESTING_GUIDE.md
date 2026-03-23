# AgentTunnel Security Testing Guide

This guide provides the necessary procedures to reproduce the **4-Phase Security Audit**, verifying the AgentTunnel's deterministic enforcement and defense-in-depth architecture.

## System Configuration

1.  **Start the Gateway:**
    ```bash
    node gateway.js
    ```
2.  **Authentication:** All tests utilize pre-configured API keys defined in the respective feature manifests.

---

## Test Execution Procedures

### 1. Remote SSH Telemetry (Phase 1)
Validates cross-server telemetry polling and ensures prevention of parameter injection (e.g., unauthorized `-o` configuration flags).
*   **Command:** `node test_ssh_workflow.js`
*   **Expected Results:** 
    *   `Authorized Execution`: HTTP 200 OK
    *   `Injection Attempt`: HTTP 403 Forbidden (Logic Blocked)

### 2. PostgreSQL Tuning (Phase 2)
Verifies database-level optimization capabilities while preventing unauthorized destructive SQL operations (e.g., `DROP TABLE`).
*   **Command:** `node test_pg_workflow.js`
*   **Expected Results:**
    *   `Authorized Index/Explain`: HTTP 200 OK
    *   `Unauthorized Operation`: HTTP 403 Forbidden (Logic Blocked)

### 3. GCP Secrets Management (Phase 3)
Tests automated secret rotation and prevents unauthorized resource deletion or data exfiltration.
*   **Command:** `node test_gcp_secrets_workflow.js`
*   *Requirement: Authenticated `gcloud` environment with appropriate permissions.*
*   **Expected Results:**
    *   `Authorized Rotation`: HTTP 200 OK
    *   `Unauthorized Deletion`: HTTP 403 Forbidden (Logic Blocked)

### 4. Self-Healing Server (Phase 4)
Validates autonomous process management (`pm2`) while prohibiting global system-level commands (e.g., OS shutdown).
*   **Command:** `node test_healing_workflow.js`
*   **Expected Results:**
    *   `Authorized Restart`: HTTP 200 OK
    *   `System Shutdown Attempt`: HTTP 403 Forbidden (Logic Blocked)

---

## Technical Audit Logs
For a comprehensive architectural analysis and line-by-line breakdown of these test results, refer to the technical execution log:
[**mdfolder/tasksexplanation.md**](./mdfolder/tasksexplanation.md)
