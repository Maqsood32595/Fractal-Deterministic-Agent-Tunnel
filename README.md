# Fractal Deterministic Agent Tunnel

> **⚠️ EXPERIMENTAL & TESTING PHASE**
> This project is a proof-of-concept for infrastructure-level AI policy enforcement. It is currently in the experimental testing phase. It relies on regular expressions for command validation, which can be brittle at enterprise scale without further hardening. It requires rigorous security penetration testing before being deployed to protect production environments. **Use at your own risk.**

The **Fractal Deterministic Agent Tunnel** solves the "Governance-Containment Gap" in AI Agents. Currently, organizations can monitor AI agents (like LangChain or CrewAI), but they cannot physically block them from hallucinating or executing dangerous commands if the LLM goes rogue. Prompt engineering is not enough.

This architecture implements **deterministic policy enforcement** at the infrastructure level. The agent utilizes natural language for decision-making, but is physically restricted by a strict whitelist policy defined in an immutable access manifest.

## ⚙️ Core Architecture: Policy vs. Enforcement

To understand why this system guarantees deterministic outputs, you must understand the separation between the **Rules** and the **Engine**:

1.  **The Access Manifest (The `feature.manifest.json`)**: This file defines the static security policy. It establishes the agent's identity and provides a strict regex whitelist of the exact shell commands permitted for execution.
2.  **The Enforcement Gateway (The Gateway & Kernel Engine)**: Static policy alone provides no protection if the LLM deviates. Our **Enforcement Gateway** sits directly at the shell boundary. It intercepts every command request, validates it against the manifest's regex, and rejects any unauthorized action with a `403 Forbidden` response. 

*Reasoning capability stems from the LLM; Security enforcement is guaranteed by the Gateway.*

---

## 🧠 Agent Memory Architecture

A core innovation of this repository is splitting AI "Memory" into two distinct, manageable layers. 

### 1. Static Policy / Identity Profile (`feature.manifest.json`)
*   **What it is:** The agent's permanent identity, allowed commands, forbidden keywords, and security boundaries.
*   **Why it matters:** Conventional systems often scatter security logic across databases and YAML configurations. In this model, the manifest serves as the agent's **immutable security identity**.
*   **Universal Portability:** Drop the `gcp-iam-provisioning` folder into any compatible engine across any repository or language (Python, Go, Node), and the agent instantly "remembers" its exact purpose and strict security boundaries.

### 2. Runtime Context (Audit Log & Execution State)
*   **What it is:** The real-time record of what steps the agent successfully executed 5 minutes ago.
*   **Why it matters:** LLMs lose track of context during 30-step autonomous tasks. By maintaining a Pipeline State Machine, the LLM only needs to read the immediate previous step to decide the next action. It is forced to be locally rational and cannot skip critical quality gates.

---

## 🏆 Verified Security Test Suite (4-Phase Audit)

We have conducted a rigorous 4-phase security audit to prove that the AgentTunnel provides **mathematical containment** against rogue AI behavior. 

| Phase | Test Scenario | Vector Defended | Status |
| :--- | :--- | :--- | :--- |
| **1** | **Remote SSH Telemetry** | Parameter Injection (`-o`) & Shell Chaining | ✅ Proven |
| **2** | **PostgreSQL Tuning** | Destructive SQL (`DROP`, `DELETE`) | ✅ Proven |
| **3** | **GCP Secrets Rotation** | Unauthorized Deletion & Exfiltration | ✅ Proven |
| **4** | **Self-Healing Server** | Global OS Shutdown (`shutdown -h now`) | ✅ Proven |

### 📖 Documentation & Logs
*   **Reproduce the Tests:** [TESTING_GUIDE.md](./TESTING_GUIDE.md)
*   **Technical Audit Logs:** [mdfolder/tasksexplanation.md](./mdfolder/tasksexplanation.md)

---

## 📁 Repository Structure (The "Fractal" Design)

The architecture is built on a **Fractal** folder structure. Agents are 100% decoupled. You can drop a new folder into `features/` and the Kernel will instantly auto-discover it, mount its security tunnel, and register its API keys without touching any core code.

```
/fractal-agent-tunnel
  ├── kernel.js           # The engine that auto-discovers agents from folders
  ├── gateway.js          # The security door blocking unauthorized commands
  ├── executor/           # The pipeline runner for multi-step tasks
  └── features/           # The Agents (Drop-in folders)
      ├── gcp-iam-provisioning/
      │   ├── feature.manifest.json  # The Agent's Genetic Memory
      │   └── (agent assets)
      ├── db-migration/
      └── (future agents go here)
```

## 🛠️ How to Replicate and Run

### 1. Installation
Clone the repository and install the standard dependencies:
```bash
git clone https://github.com/Maqsood32595/Fractal-Deterministic-Agent-Tunnel.git
cd Fractal-Deterministic-Agent-Tunnel
npm install express
```

### 2. Start the Secure Gateway
Start the engine. Watch as the Kernel dynamically discovers the agents from the `features/` folder and mounts their secure tunnels:
```bash
node gateway.js
```
*Expected Output:*
```
[Kernel] Discovered feature: gcp-iam-provisioning
[Kernel] Mounted tunnel: GCP-IAM-Provisioning
[Gateway] Running on port 3000
```

### 3. Test the Deterministic Boundaries
In a separate terminal, try to trigger the GCP IAM Agent. 

**✅ The Safe Command (Passes the Regex)**
Use the provided simulation wrapper that attempts to assign a safe `roles/viewer` permission:
```bash
node test_gcp_workflow.js "Alex Smith"
```
The Gateway validates the pattern against the `feature.manifest.json` and allows the execution.

**❌ The Rogue Command (Blocked)**
If you were to modify the script (or if an LLM hallucinates) to attempt to grant `roles/owner` instead:
```bash
# Gateway Output:
[SECURITY] Blocked execution. Command matches forbidden keyword: 'owner'.
[SECURITY] Blocked execution. Command does not match whitelist pattern.
```
The request is killed before it ever reaches the shell.
