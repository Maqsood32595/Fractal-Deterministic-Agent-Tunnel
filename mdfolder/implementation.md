# FractalSRE — Distributed Intelligence Control Plane
## Implementation Plan (Phase-by-Phase)

---

### Project Identity
- Folder: d:\HiDevs\GitAgents\
- Dashboard Port: 8000 (light themed)
- GCP Project: scout-fractal-poc
- GitHub User: Maqsood32595
- GitHub Token: stored in Windows Credential Manager (gho_ prefix)
- GitHub Repo: Maqsood32595/Fractal-Deterministic-Agent-Tunnel
- Experiment Branch: feature/distributed-control-plane

---

## Phase 1 — Foundation (Docker + Project Setup)

### Goal
Spin up all 5 containers cleanly. Establish the base Node.js project.

### Steps
1. Create docker-compose.yml with 5 services:
   - target-api (custom Node.js on 8080)
   - localstack (AWS simulation on 4566)
   - gitea (self-hosted git on 3005)
   - prometheus (metrics on 9091)
   - qdrant (vector store on 6333)
2. Create target-api/server.js with Prometheus instrumentation
3. Create prometheus.yml scrape config
4. Create package.json with dependencies:
   - express, cors, tsx, typescript
   - @qdrant/js-client-rest
   - @google-cloud/aiplatform (Vertex AI)
   - octokit (GitHub API)
5. Run docker compose up -d and verify all 5 containers healthy

### Success Check
- localhost:8080/db-check returns JSON
- localhost:9091 shows Prometheus UI
- localhost:6333/dashboard shows Qdrant UI
- localhost:3005 shows Gitea

---

## Phase 2 — Hybrid Vector RAG (Knowledge Layer)

### Goal
Replace hardcoded SOP matching with semantic + lexical hybrid search over real runbook documents.

### Steps
1. Create runbooks/ folder with 4 markdown files:
   - SOP-204-db-saturation.md
   - SOP-105-disk-critical.md
   - SOP-404-oomkilled.md
   - POSTMORTEM-2024-07-11-rds-quota.md (tagged do-not-execute)
2. Create ingest_runbooks.ts:
   - Read each markdown file
   - Chunk into 256-token segments with 32-token overlap
   - Call Vertex AI textembedding-gecko@003 for each chunk
   - Upsert to Qdrant collection runbooks with metadata:
     { title, tags, lastModified, source, doNotExecute }
3. Add hybrid search function to server.ts:
   - BM25 lexical pass (keyword match on error tokens)
   - Qdrant vector search (top 5 results)
   - Merge and de-duplicate
   - Metadata re-ranker:
     * do-not-execute tag -> score = -1.0
     * recency bonus = max(0, 1 - daysSinceModified/30)
   - Return top-ranked runbook to Commander

### Success Check
- Query "db connection pool exhausted" returns SOP-204
- Query "disk full no space" returns SOP-105
- Query "OOMKilled exit 137" returns SOP-404
- Query "rds upgrade us-east-1" returns POSTMORTEM with score -1.0 (suppressed)

---

## Phase 3 — GitOps Live Policy Distribution (Governance Layer)

### Goal
Replace hardcoded safety audit regex with live policy fetched from GitHub every 60 seconds.

### Steps
1. Populate auth/tunnels.json on Fractal-Deterministic-Agent-Tunnel repo:
   - allowed_commands array with exact regex patterns
   - forbidden_keywords array
   - escalation_thresholds object
   - active_runbook field
   - freeze_mode boolean
2. Add to server.ts:
   - fetchPolicyFromGitHub() function using stored gho_ token
   - In-memory policyCache variable
   - On startup: fetch and cache
   - setInterval every 60000ms: re-fetch and update cache
3. Replace safety audit if/else with policy cache reader:
   - Check command against allowed_commands (regex match)
   - Check command against forbidden_keywords
   - Read escalation_thresholds for HITL decision
4. Add live policy panel to dashboard UI showing current policy state

### Success Check
- Push commit adding "rm -rf" to forbidden_keywords
- Within 60s, server log shows "Policy re-synced from GitHub"
- Next agent run blocks "rm -rf" even if it was previously allowed
- Dashboard shows current policy version + last sync timestamp

---

## Phase 4 — Agent-to-Git PR Commit Flow (Execution Layer)

### Goal
Agent proposes fixes as GitHub Pull Requests instead of direct disk writes.

### Steps
1. Add GitHub API functions to server.ts using gho_ token:
   - createBranch(branchName, baseSha)
   - commitFile(branch, path, content, message)
   - openPullRequest(branch, title, body)
   - mergePullRequest(prNumber)
   - getPRStatus(prNumber)
2. On HITL approve:
   - Instead of fs.writeFileSync + exec()
   - Create branch: sre-fix/run-{runId}
   - Commit the patched file with [skip-ci] in message
   - Open PR with full diagnostic trace as body
   - Return PR URL to dashboard
3. Dashboard shows:
   - PR link (clickable)
   - PR status (OPEN / MERGED / FAILED)
   - Approve button triggers PR merge via API
4. Post-merge: verify target-api health, update status to RESOLVED

### Loop Prevention
- All agent commits include [skip-ci] in message
- Policy sync ignores commits where author = sre-agent[bot]
- Policy sync ignores branches with prefix sre-fix/

### Success Check
- Approve click creates visible PR on GitHub
- PR body contains full diagnostic trace
- Merge button in dashboard merges the PR
- Container rebuilds after merge

---

## Phase 5 — Telemetry Watchdog (Safety Layer)

### Goal
Detect cascading failures during HITL suspension without blocking the main thread.

### Steps
1. Add watchdog to server.ts:
   - On status = suspended: start setInterval every 10000ms
   - On status != suspended: clear the interval
2. Watchdog polls:
   - localhost:9091/api/v1/query?query=http_requests_total (Prometheus)
   - localhost:8080/db-check (target-api)
3. Evaluate thresholds from live policy cache:
   - error_rate > escalation_thresholds.emergency_breakout_error_rate
   - active_connections > 90% of max
4. On EMERGENCY_BREAKOUT:
   - Cancel current suspended run
   - Set status = escalated
   - Spawn new Commander with cascadeContext appended
   - Dashboard shows red alert banner: CASCADING FAILURE DETECTED
   - New diagnosis runs automatically

### Success Check
- Trigger scenario, wait for HITL suspension
- Manually call /api/trigger-cascade endpoint (new endpoint to simulate)
- Within 10 seconds, watchdog detects and fires EMERGENCY_BREAKOUT
- Dashboard shows escalation banner and new diagnostic trace

---

## Phase 6 — Dashboard + Scenarios (Presentation Layer)

### Goal
Update dashboard to show all new components and add Scenario 4.

### New UI Panels
- Live Policy Panel: current tunnels.json state, last sync time, freeze_mode toggle
- PR Status Panel: branch name, PR link, status badge, merge button
- Watchdog Status: green MONITORING / red BREAKOUT
- RAG Trace Panel: which runbook was retrieved, its score, why POSTMORTEM was suppressed

### New Scenario
- Scenario 4: Runbook Conflict
  - Same chaos as Scenario 1 (DB saturation)
  - RAG retrieves both SOP-204 and POSTMORTEM
  - Dashboard shows both documents and their scores
  - Agent correctly suppresses upgrade path
  - Proposes read-replica routing instead

### Success Check
- All 4 scenarios run end-to-end without errors
- PR is created on GitHub for each scenario
- Watchdog fires correctly on cascade simulation
- sre_run.log captures full trace for all runs

---

## Phase 7 — GitHub Branch + Final Validation

### Goal
Create experiment branch, push all code, run end-to-end test, record video.

### Steps
1. git init in d:\HiDevs\GitAgents\
2. git remote add origin https://github.com/Maqsood32595/Fractal-Deterministic-Agent-Tunnel
3. git checkout -b feature/distributed-control-plane
4. git add . && git commit -m "feat: distributed intelligence control plane implementation"
5. git push origin feature/distributed-control-plane
6. Run docker compose up -d
7. Run npx tsx ingest_runbooks.ts (one-time Qdrant seeding)
8. Run npx tsx server.ts
9. Open browser to localhost:8000
10. Record all 4 scenarios
11. Fill implementationcomplete.md with full documentation

---

## Dependencies

| Package | Purpose |
|:---|:---|
| express | Dashboard HTTP server |
| @qdrant/js-client-rest | Qdrant vector store client |
| @google-cloud/aiplatform | Vertex AI embeddings |
| @octokit/rest | GitHub API (branches, PRs, merges) |
| tsx | TypeScript execution |
| cors | CORS middleware |

---

## Environment Variables Needed

| Variable | Value | Source |
|:---|:---|:---|
| GITHUB_TOKEN | gho_*** | Windows Credential Manager |
| GCP_PROJECT | scout-fractal-poc | gcloud config |
| GITHUB_REPO | Maqsood32595/Fractal-Deterministic-Agent-Tunnel | hardcoded |
| GITHUB_BRANCH | main | policy source |
| QDRANT_URL | http://localhost:6333 | local Docker |
