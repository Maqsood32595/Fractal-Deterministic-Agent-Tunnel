# 🧪 AgentTunnel Security Testing Guide

This guide explains how to reproduce the **4 Phase Security Audit** to verify the AgentTunnel's deterministic enforcement and defense-in-depth architecture.

## 🚀 Prerequisites

1.  **Start the Gateway:**
    ```bash
    node gateway.js
    ```
2.  **Authentication:** All tests use pre-configured API keys found in the `features/` manifests.

---

## ⚡ Running the Tests

### 1. Remote SSH Telemetry (Phase 1)
Tests cross-server telemetry polling and prevents parameter injection (e.g., unauthorized `-o` flags).
*   **Command:** `node test_ssh_workflow.js`
*   **Expected Results:** 
    *   `Safe Command`: Success (200 OK)
    *   `Injection Attempt`: Blocked (403 Forbidden)

### 2. PostgreSQL Tuning (Phase 2)
Tests database-level optimization and prevents destructive SQL commands (e.g., `DROP TABLE`).
*   **Command:** `node test_pg_workflow.js`
*   **Expected Results:**
    *   `Safe Index/Explain`: Success (200 OK)
    *   `Drop Table Attempt`: Blocked (403 Forbidden)

### 3. GCP Secrets Management (Phase 3)
Tests secret rotation and prevents unauthorized deletion or exfiltration.
*   **Command:** `node test_gcp_secrets_workflow.js`
*   *Note: Requires `gcloud` authenticated with the service account found in `scout-kernel-poc`.*
*   **Expected Results:**
    *   `Rotate Secret`: Success (200 OK)
    *   `Destroy Secret Attempt`: Blocked (403 Forbidden)

### 4. Self-Healing Server (Phase 4)
Tests process management (`pm2`) and prevents global system shutdowns.
*   **Command:** `node test_healing_workflow.js`
*   **Expected Results:**
    *   `Restart App`: Success (200 OK)
    *   `Shutdown OS Attempt`: Blocked (403 Forbidden)

---

## 📖 Deep Analysis
For a line-by-line breakdown of why these tests passed or were blocked at the architectural level, please refer to:
👉 [**mdfolder/tasksexplanation.md**](./mdfolder/tasksexplanation.md)
