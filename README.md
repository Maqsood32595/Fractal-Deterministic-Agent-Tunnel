# Fractal Deterministic Agent Tunnel

> **⚠️ EXPERIMENTAL & TESTING PHASE**
> This project is a proof-of-concept for infrastructure-level AI policy enforcement. It is currently in the experimental testing phase. It relies on regular expressions for command validation, which can be brittle at enterprise scale without further hardening. It requires rigorous security penetration testing before being deployed to protect production environments. **Use at your own risk.**

The **Fractal Deterministic Agent Tunnel** solves the "Governance-Containment Gap" in AI Agents. Currently, organizations can monitor AI agents (like LangChain or CrewAI), but they cannot physically block them from hallucinating or executing dangerous commands if the LLM goes rogue. Prompt engineering is not enough.

This architecture acts as a **mathematical security guard** at the infrastructure level. The agent can use natural language to decide what to do, but it is physically blocked from executing any command that does not match strict whitelist policies defined in a dynamic manifest.

## 🚀 How It Works: The "Law Book" vs. The "Police"

To understand why this system guarantees deterministic outputs, you must understand the separation between the **Rules** and the **Engine**:

1.  **The Law Book (The `feature.manifest.json`)**: This file holds the static rules. It defines the agent's identity and provides a strict regex whitelist of what shell commands the agent is actually allowed to trigger.
2.  **The Police Officer (The Gateway & Kernel Engine)**: If you just take the JSON file and use it with a standard LLM, it provides zero security—the LLM will ignore it. **Our Gateway Engine** sits in front of the terminal. It intercepts every command the LLM tries to run, tests it against the manifest's regex, and drops the request with a `403 Forbidden` if it dares to deviate. 

*Intelligence comes from the LLM. Security comes from the Gateway.*

---

## 🧠 Agent Memory Architecture

A core innovation of this repository is splitting AI "Memory" into two distinct, manageable layers. 

### 1. Genetic Memory / Identity Memory (`feature.manifest.json`)
*   **What it is:** The agent's permanent identity, allowed commands, forbidden keywords, and security boundaries.
*   **Why it matters:** In traditional systems, policy is scattered across databases and YAML files. Here, the manifest **is** the agent's genetic memory.
*   **Universal Portability:** Drop the `gcp-iam-provisioning` folder into any compatible engine across any repository or language (Python, Go, Node), and the agent instantly "remembers" its exact purpose and strict security boundaries.

### 2. Working Memory (Audit Log & Pipeline State)
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
