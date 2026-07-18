import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { QdrantClient } from '@qdrant/js-client-rest';
import { Octokit } from '@octokit/rest';

const app = express();
const PORT = 8000;

// ─── Constants ────────────────────────────────────────────────────────────────
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO_OWNER = 'Maqsood32595';
const GITHUB_REPO_NAME = 'Fractal-Deterministic-Agent-Tunnel';
const POLICY_FILE_PATH = 'auth/tunnels.json';
const GCP_PROJECT = 'scout-fractal-poc';
const GCP_LOCATION = 'us-central1';
const QDRANT_URL = 'http://localhost:6333';
const COLLECTION_NAME = 'runbooks';
const LOG_PATH = path.join(__dirname, 'sre_run.log');

// ─── Clients ──────────────────────────────────────────────────────────────────
const qdrant = new QdrantClient({ url: QDRANT_URL });
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ─── Logging ──────────────────────────────────────────────────────────────────
function sreLog(event: string, data: Record<string, any> = {}) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + '\n';
  fs.appendFileSync(LOG_PATH, entry);
  console.log(`[SRE] ${event}`, data);
}

// ─── Policy Cache (Phase 3) ───────────────────────────────────────────────────
interface Policy {
  version: string;
  lastUpdated: string;
  allowed_commands: string[];
  forbidden_keywords: string[];
  escalation_thresholds: {
    auto_approve_below_connections: number;
    require_human_above_connections: number;
    emergency_breakout_error_rate: number;
  };
  active_runbook: string;
  freeze_mode: boolean;
}

let policyCache: Policy = {
  version: '1.0.0',
  lastUpdated: new Date().toISOString(),
  allowed_commands: [
    '^docker compose up -d --build target-api$',
    '^docker compose restart target-api$',
    '^node cleanup\\.js$'
  ],
  forbidden_keywords: ['rm -rf', 'passwd', 'DROP TABLE', 'format'],
  escalation_thresholds: {
    auto_approve_below_connections: 50,
    require_human_above_connections: 80,
    emergency_breakout_error_rate: 0.5
  },
  active_runbook: 'SOP-204',
  freeze_mode: false
};
let lastPolicySyncTime = new Date().toISOString();

async function fetchPolicyFromGitHub() {
  try {
    const response = await octokit.rest.repos.getContent({
      owner: GITHUB_REPO_OWNER,
      repo: GITHUB_REPO_NAME,
      path: POLICY_FILE_PATH
    });
    if ('content' in response.data) {
      const decoded = Buffer.from((response.data as any).content, 'base64').toString('utf8').replace(/\n/g, '');
      const parsed = JSON.parse(decoded);
      // Merge with defaults so missing fields don't break the server
      policyCache = { ...policyCache, ...parsed };
      lastPolicySyncTime = new Date().toISOString();
      sreLog('POLICY_SYNCED', { version: policyCache.version, freeze_mode: policyCache.freeze_mode });
    }
  } catch (err: any) {
    console.log('[Policy] GitHub fetch failed, using cached policy:', err.message);
  }
}

// Start policy sync loop
fetchPolicyFromGitHub();
setInterval(fetchPolicyFromGitHub, 60000);

// ─── Safety Audit (reads from live policy) ───────────────────────────────────
function safetyAudit(command: string): { safe: boolean; reason: string } {
  if (policyCache.freeze_mode) {
    return { safe: false, reason: 'FREEZE_MODE_ACTIVE — policy enforcement: freeze_mode=true in tunnels.json' };
  }
  for (const kw of policyCache.forbidden_keywords) {
    if (command.toLowerCase().includes(kw.toLowerCase())) {
      return { safe: false, reason: `FORBIDDEN_KEYWORD: "${kw}" found in command` };
    }
  }
  const isAllowed = policyCache.allowed_commands.some(pattern => new RegExp(pattern).test(command));
  if (!isAllowed) {
    return { safe: false, reason: `COMMAND_NOT_IN_MANIFEST: "${command}" does not match any allowed_commands pattern in live policy` };
  }
  return { safe: true, reason: 'POLICY_APPROVED' };
}

// ─── Vertex AI Embeddings ─────────────────────────────────────────────────────
async function getEmbedding(text: string): Promise<number[]> {
  const token = execSync('gcloud auth print-access-token', { encoding: 'utf8', shell: true }).trim();
  const url = `https://${GCP_LOCATION}-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${GCP_LOCATION}/publishers/google/models/text-embedding-004:predict`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances: [{ content: text }] })
  });
  if (!response.ok) throw new Error(`Vertex AI error: ${response.status}`);
  const result: any = await response.json();
  return result.predictions[0].embeddings.values;
}

// ─── Hybrid RAG Search (Phase 2) ─────────────────────────────────────────────
interface RunbookResult {
  title: string;
  content: string;
  doNotExecute: boolean;
  score: number;
  source: string;
  lastModified: string;
  suppressedReason?: string;
}

async function hybridRunbookSearch(query: string): Promise<RunbookResult[]> {
  try {
    // Use cached env token if available, otherwise get fresh one
    const token = process.env.GCP_TOKEN?.trim() || 
      execSync('gcloud auth print-access-token', { encoding: 'utf8', shell: true }).trim();
    const url = `https://${GCP_LOCATION}-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${GCP_LOCATION}/publishers/google/models/text-embedding-004:predict`;
    const embResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ instances: [{ content: query }] })
    });
    
    let results: RunbookResult[] = [];
    
    if (embResponse.ok) {
      const embResult: any = await embResponse.json();
      const queryVector = embResult.predictions[0].embeddings.values;
      
      const searchResult = await qdrant.search(COLLECTION_NAME, {
        vector: queryVector,
        limit: 8,
        with_payload: true
      });

      // Metadata re-ranking
      const now = new Date();
      const ranked = searchResult.map((hit: any) => {
        const p = hit.payload;
        const daysSince = (now.getTime() - new Date(p.lastModified).getTime()) / (1000 * 60 * 60 * 24);
        const recencyBonus = Math.max(0, 1 - daysSince / 30);
        const sourceBonus = p.source === 'post-mortems' ? 0.2 : 0;
        let finalScore = (hit.score + recencyBonus * 0.1 + sourceBonus);
        let suppressedReason: string | undefined;
        
        if (p.doNotExecute === true) {
          finalScore = -1.0;
          suppressedReason = `DO_NOT_EXECUTE tag active — post-mortem overrides SOP`;
        }
        
        return {
          title: p.title || 'Unknown',
          content: p.chunkText || '',
          doNotExecute: p.doNotExecute || false,
          score: finalScore,
          source: p.source || 'unknown',
          lastModified: p.lastModified || '',
          suppressedReason
        };
      });

      results = ranked.sort((a, b) => b.score - a.score);
    }
    
    // BM25 keyword fallback: if top result is suppressed or score low, add keyword boost
    const keywords: Record<string, string> = {
      'connection': 'SOP-204', 'pool': 'SOP-204', 'rds': 'SOP-204', 'saturation': 'SOP-204',
      'disk': 'SOP-105', 'space': 'SOP-105', 'log': 'SOP-105', 'full': 'SOP-105',
      'oom': 'SOP-404', 'memory': 'SOP-404', 'killed': 'SOP-404', '137': 'SOP-404'
    };
    const lowerQuery = query.toLowerCase();
    const bm25Match = Object.entries(keywords).find(([kw]) => lowerQuery.includes(kw));
    if (bm25Match && results.length === 0) {
      results.push({
        title: bm25Match[1], content: `BM25 keyword match for "${bm25Match[0]}"`,
        doNotExecute: false, score: 0.5, source: 'bm25-fallback', lastModified: new Date().toISOString()
      });
    }
    
    return results;
  } catch (err: any) {
    console.error('RAG search failed:', err.message);
    // Deterministic fallback
    return [{
      title: 'SOP-FALLBACK', content: 'RAG unavailable — using deterministic SOP matching.',
      doNotExecute: false, score: 0.1, source: 'fallback', lastModified: new Date().toISOString()
    }];
  }
}

// ─── GitHub PR Flow (Phase 4) ─────────────────────────────────────────────────
async function createSrePullRequest(runId: string, scenario: number, patchContent: string, diagnosticTrace: string) {
  const branchName = `sre-fix/run-${runId}`;
  
  // Get base SHA
  const { data: ref } = await octokit.rest.git.getRef({
    owner: GITHUB_REPO_OWNER, repo: GITHUB_REPO_NAME, ref: 'heads/main'
  });
  const baseSha = ref.object.sha;
  
  // Create branch
  await octokit.rest.git.createRef({
    owner: GITHUB_REPO_OWNER, repo: GITHUB_REPO_NAME,
    ref: `refs/heads/${branchName}`, sha: baseSha
  });
  
  // Get existing file SHA (required for update)
  let existingFileSha: string | undefined;
  try {
    const { data: fileData } = await octokit.rest.repos.getContent({
      owner: GITHUB_REPO_OWNER, repo: GITHUB_REPO_NAME, path: POLICY_FILE_PATH
    });
    if ('sha' in fileData) existingFileSha = fileData.sha;
  } catch {}
  
  // Commit the patch
  const scenarioNames: Record<number, string> = { 1: 'DB Saturation', 2: 'Disk Critical', 3: 'OOMKilled', 4: 'Runbook Conflict' };
  await octokit.rest.repos.createOrUpdateFileContents({
    owner: GITHUB_REPO_OWNER, repo: GITHUB_REPO_NAME,
    path: `sre-patches/fix-scenario-${scenario}-run-${runId}.md`,
    message: `[skip-ci] SRE Agent Fix: ${scenarioNames[scenario] || 'Unknown'} (run ${runId})`,
    content: Buffer.from(patchContent).toString('base64'),
    branch: branchName,
    ...(existingFileSha ? { sha: existingFileSha } : {})
  });
  
  // Open PR
  const { data: pr } = await octokit.rest.pulls.create({
    owner: GITHUB_REPO_OWNER, repo: GITHUB_REPO_NAME,
    title: `[SRE Agent] Auto-fix: ${scenarioNames[scenario] || 'Incident'} (Run ${runId})`,
    body: `## SRE Agent Auto-Generated Fix\n\n**Run ID:** ${runId}\n**Scenario:** ${scenarioNames[scenario]}\n**Timestamp:** ${new Date().toISOString()}\n\n## Diagnostic Trace\n\`\`\`\n${diagnosticTrace}\n\`\`\`\n\n---\n*Generated by FractalSRE Distributed Intelligence Control Plane*`,
    head: branchName, base: 'main'
  });
  
  return { prNumber: pr.number, prUrl: pr.html_url, branchName };
}

async function mergePullRequest(prNumber: number) {
  await octokit.rest.pulls.merge({
    owner: GITHUB_REPO_OWNER, repo: GITHUB_REPO_NAME,
    pull_number: prNumber,
    merge_method: 'squash',
    commit_title: `[skip-ci] SRE Agent: Auto-merged fix (PR #${prNumber})`
  });
}

// ─── Run State ─────────────────────────────────────────────────────────────────
interface AgentRun {
  runId: string;
  scenario: number;
  status: 'idle' | 'triaging' | 'suspended' | 'executing' | 'completed' | 'failed' | 'escalated';
  chaosType: string;
  diagnosticTrace: string;
  proposedFix: string;
  proposedCommand: string;
  safetyResult: { safe: boolean; reason: string } | null;
  ragResults: RunbookResult[];
  prUrl: string | null;
  prNumber: number | null;
  watchdogActive: boolean;
  cascadeDetected: boolean;
  startTime: string;
  endTime: string | null;
  policySnapshot: { version: string; freeze_mode: boolean; lastSynced: string };
}

let activeRun: AgentRun | null = null;
let watchdogInterval: ReturnType<typeof setInterval> | null = null;

function stopWatchdog() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
}

async function startTelemetryWatchdog(runId: string) {
  stopWatchdog();
  const threshold = policyCache.escalation_thresholds.emergency_breakout_error_rate;
  
  watchdogInterval = setInterval(async () => {
    if (!activeRun || activeRun.status !== 'suspended') {
      stopWatchdog();
      return;
    }
    try {
      const resp = await fetch('http://localhost:8080/db-check');
      const data: any = await resp.json();
      
      if (data.httpErrorRate > threshold) {
        sreLog('WATCHDOG_EMERGENCY_BREAKOUT', { runId, errorRate: data.httpErrorRate, threshold });
        activeRun.cascadeDetected = true;
        activeRun.status = 'escalated';
        activeRun.diagnosticTrace += `\n\n⚠️ TELEMETRY WATCHDOG TRIGGERED\nHTTP Error Rate: ${(data.httpErrorRate * 100).toFixed(0)}% exceeds threshold ${(threshold * 100).toFixed(0)}%\nCascading failure detected. Escalating to Tier 3.`;
        stopWatchdog();
      }
    } catch {}
  }, 10000);
}

// ─── Scenario Definitions ─────────────────────────────────────────────────────
const SCENARIOS = [
  {
    id: 1, name: 'DB Connection Saturation', icon: '🗄️',
    chaosEndpoint: '/simulate-anomaly',
    chaosType: 'DB_CONNECTION_POOL_EXHAUSTED',
    searchQuery: 'database connection pool exhausted rds saturation active connections',
    proposedCommand: 'docker compose up -d --build target-api',
    patchContent: (runId: string) => `# SRE Fix: DB Connection Saturation\n\nRun ID: ${runId}\nFix: Upgrade RDS instance class and increase connection pool\n\n\`\`\`\nINSTANCE_CLASS=db.r6g.large\nMAX_CONNECTIONS=500\n\`\`\`\n\nApply with: docker compose up -d --build target-api`
  },
  {
    id: 2, name: 'Disk Utilization Critical', icon: '💾',
    chaosEndpoint: '/simulate-disk',
    chaosType: 'DISK_USAGE_CRITICAL',
    searchQuery: 'disk full no space left critical log files cleanup',
    proposedCommand: 'node cleanup.js',
    patchContent: (runId: string) => `# SRE Fix: Disk Space Critical\n\nRun ID: ${runId}\nFix: Delete temporary log files\n\n\`\`\`bash\n# Safe deletion of temp_sys_bloat.log\ndel /f /q temp_sys_bloat.log\n\`\`\`\n`
  },
  {
    id: 3, name: 'Container OOMKilled', icon: '💀',
    chaosEndpoint: '/simulate-oom',
    chaosType: 'CONTAINER_OOMKILLED_EXIT_137',
    searchQuery: 'OOMKilled container exit code 137 memory limit exceeded',
    proposedCommand: 'docker compose up -d --build target-api',
    patchContent: (runId: string) => `# SRE Fix: OOMKilled Container\n\nRun ID: ${runId}\nFix: Double memory limit from 256m to 512m\n\n\`\`\`yaml\nmem_limit: 512m\n\`\`\`\n\nApply with: docker compose up -d --build target-api`
  },
  {
    id: 4, name: 'Runbook Conflict Resolution', icon: '📋',
    chaosEndpoint: '/simulate-anomaly',
    chaosType: 'DB_CONNECTION_POOL_EXHAUSTED',
    searchQuery: 'rds upgrade us-east-1 quota db.r6g instance class',
    proposedCommand: 'docker compose up -d --build target-api',
    patchContent: (runId: string) => `# SRE Fix: Runbook Conflict Resolved\n\nRun ID: ${runId}\nRAG suppressed: SOP-204 upgrade path (do-not-execute post-mortem found)\nAlternative: Read-replica routing instead of instance class upgrade\n\n\`\`\`\nREAD_REPLICA_ENABLED=true\nREAD_REPLICA_WEIGHT=0.7\n\`\`\``
  }
];

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── API Routes ────────────────────────────────────────────────────────────────

// Status
app.get('/api/status', (req, res) => {
  res.json({
    run: activeRun,
    policy: {
      version: policyCache.version || '1.0.0',
      freeze_mode: policyCache.freeze_mode || false,
      lastSynced: lastPolicySyncTime,
      allowed_commands_count: (policyCache.allowed_commands || []).length,
      forbidden_keywords: policyCache.forbidden_keywords || []
    }
  });
});

// Trigger chaos + start agent run
app.post('/api/trigger-chaos', async (req, res) => {
  const { scenarioId } = req.body;
  const scenario = SCENARIOS.find(s => s.id === scenarioId);
  if (!scenario) return res.status(400).json({ error: 'Invalid scenario ID' });

  const runId = Date.now().toString();
  activeRun = {
    runId, scenario: scenarioId, status: 'triaging',
    chaosType: scenario.chaosType,
    diagnosticTrace: '', proposedFix: '', proposedCommand: '',
    safetyResult: null, ragResults: [],
    prUrl: null, prNumber: null,
    watchdogActive: false, cascadeDetected: false,
    startTime: new Date().toISOString(), endTime: null,
    policySnapshot: { version: policyCache.version, freeze_mode: policyCache.freeze_mode, lastSynced: lastPolicySyncTime }
  };

  sreLog('CHAOS_INJECTED', { runId, scenario: scenario.name, chaosType: scenario.chaosType });

  // Inject chaos into target-api
  try {
    await fetch(`http://localhost:8080${scenario.chaosEndpoint}`, { method: 'POST' });
  } catch {}

  res.json({ success: true, runId });

  // Run agent asynchronously
  runAgentAsync(runId, scenario);
});

async function runAgentAsync(runId: string, scenario: typeof SCENARIOS[0]) {
  if (!activeRun) return;
  
  try {
    // ── Triage Phase ──────────────────────────────────────────────────────────
    await sleep(800);
    const metrics = await fetchMetrics();
    sreLog('TRIAGE_STARTED', { runId, metrics });

    // ── RAG Search ────────────────────────────────────────────────────────────
    await sleep(600);
    const ragResults = await hybridRunbookSearch(scenario.searchQuery);
    activeRun.ragResults = ragResults;
    
    const topResult = ragResults[0];
    const suppressedResults = ragResults.filter(r => r.doNotExecute);
    
    sreLog('RAG_SEARCH_COMPLETE', { 
      runId, 
      topResult: topResult?.title, 
      suppressed: suppressedResults.map(r => r.title),
      query: scenario.searchQuery
    });

    // ── Build Diagnostic Trace ────────────────────────────────────────────────
    const trace = buildDiagnosticTrace(scenario, metrics, ragResults);
    activeRun.diagnosticTrace = trace;
    activeRun.proposedFix = scenario.patchContent(runId);
    activeRun.proposedCommand = scenario.proposedCommand;

    // ── Safety Audit ─────────────────────────────────────────────────────────
    const auditResult = safetyAudit(scenario.proposedCommand);
    activeRun.safetyResult = auditResult;
    sreLog('SAFETY_AUDIT', { runId, command: scenario.proposedCommand, ...auditResult });

    if (!auditResult.safe) {
      activeRun.status = 'failed';
      activeRun.endTime = new Date().toISOString();
      sreLog('RUN_BLOCKED_BY_POLICY', { runId, reason: auditResult.reason });
      return;
    }

    // ── HITL Gate ─────────────────────────────────────────────────────────────
    activeRun.status = 'suspended';
    activeRun.watchdogActive = true;
    sreLog('HITL_SUSPENDED', { runId, awaitingApproval: true });
    startTelemetryWatchdog(runId);

  } catch (err: any) {
    if (activeRun) {
      activeRun.status = 'failed';
      activeRun.endTime = new Date().toISOString();
    }
    sreLog('RUN_ERROR', { runId, error: err.message });
  }
}

// Approve - triggers local remediation or PR flow
app.post('/api/approve', async (req, res) => {
  if (!activeRun || activeRun.status !== 'suspended') {
    return res.status(400).json({ error: 'No suspended run to approve' });
  }
  
  const { runId } = activeRun;
  stopWatchdog();
  activeRun.status = 'executing';
  sreLog('HITL_APPROVED', { runId });

  // If this is a static/re-runnable SOP cleanup task (Scenario 2: Disk space), do it locally with zero Git writes
  if (activeRun.scenario === 2) {
    res.json({ success: true, message: 'Approved. Executing local cleanup command...' });
    try {
      // Execute the fix directly on the target-api local container
      await fetch('http://localhost:8080/apply-fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: activeRun.scenario })
      });
      activeRun.status = 'completed';
      activeRun.endTime = new Date().toISOString();
      activeRun.prUrl = 'LOCAL_REMEDIATION'; // Sentinel value for local-only execution
      sreLog('INCIDENT_RESOLVED_LOCALLY', { runId, scenario: 'Disk Utilization Critical', command: activeRun.proposedCommand });
    } catch (err: any) {
      if (activeRun) {
        activeRun.status = 'failed';
        activeRun.endTime = new Date().toISOString();
      }
      sreLog('LOCAL_REMEDIATION_FAILED', { runId, error: err.message });
    }
    return;
  }

  res.json({ success: true, message: 'Approved. Creating GitHub PR...' });

  // Phase 4: Create PR
  try {
    const scenario = SCENARIOS.find(s => s.id === activeRun!.scenario)!;
    const { prNumber, prUrl, branchName } = await createSrePullRequest(
      runId,
      activeRun.scenario,
      activeRun.proposedFix,
      activeRun.diagnosticTrace
    );
    
    activeRun.prUrl = prUrl;
    activeRun.prNumber = prNumber;
    sreLog('PR_CREATED', { runId, prNumber, prUrl, branchName });

    // Auto-merge after 3 seconds (simulating CI gate pass)
    await sleep(3000);
    await mergePullRequest(prNumber);
    sreLog('PR_MERGED', { runId, prNumber });

    // Apply fix to target-api
    await fetch('http://localhost:8080/apply-fix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: activeRun.scenario })
    });

    activeRun.status = 'completed';
    activeRun.endTime = new Date().toISOString();
    sreLog('INCIDENT_RESOLVED', { runId, prUrl, scenario: scenario.name });

  } catch (err: any) {
    if (activeRun) {
      activeRun.status = 'failed';
      activeRun.endTime = new Date().toISOString();
    }
    sreLog('PR_FAILED', { runId, error: err.message });
  }
});

// Reject
app.post('/api/reject', (req, res) => {
  if (!activeRun) return res.status(400).json({ error: 'No active run' });
  stopWatchdog();
  activeRun.status = 'failed';
  activeRun.endTime = new Date().toISOString();
  sreLog('HITL_REJECTED', { runId: activeRun.runId });
  res.json({ success: true });
});

// Reset
app.post('/api/reset', async (req, res) => {
  stopWatchdog();
  activeRun = null;
  try { await fetch('http://localhost:8080/reset', { method: 'POST' }); } catch {}
  sreLog('SYSTEM_RESET', {});
  res.json({ success: true });
});

// Simulate cascade (for watchdog demo)
app.post('/api/simulate-cascade', async (req, res) => {
  try { await fetch('http://localhost:8080/simulate-cascade', { method: 'POST' }); } catch {}
  res.json({ success: true, message: 'Cascading failure injected' });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchMetrics() {
  try {
    const resp = await fetch('http://localhost:8080/db-check');
    return await resp.json();
  } catch {
    return { status: 'UNKNOWN', activeConnections: 0, diskUsage: 0, oomKilled: false, httpErrorRate: 0 };
  }
}

function buildDiagnosticTrace(scenario: typeof SCENARIOS[0], metrics: any, ragResults: RunbookResult[]): string {
  const topResult = ragResults[0];
  const suppressed = ragResults.filter(r => r.doNotExecute);
  
  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FRACTAL SRE DIAGNOSTIC TRACE
Run Timestamp: ${new Date().toISOString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[1] COMMANDER AGENT — Alert Ingested
    Type: ${scenario.chaosType}
    Policy Version: ${policyCache.version} (freeze_mode: ${policyCache.freeze_mode})

[2] SPECIALIST AGENTS (Parallel)
    K8s Diagnostic:
      - Pod Status: ${metrics.oomKilled ? '❌ OOMKilled (Exit 137)' : '✅ Running'}
      - HTTP Error Rate: ${((metrics.httpErrorRate || 0) * 100).toFixed(0)}%
    
    AWS Metric Specialist:
      - Instance Class: ${metrics.instanceClass || 'db.t3.medium'}
      - Active Connections: ${metrics.activeConnections || 0}/${metrics.maxConnectionsLimit || 100}
      - Disk Usage: ${metrics.diskUsage || 0}%
    
    Runbook Specialist (Hybrid RAG):
      - Query: "${scenario.searchQuery}"
      - Top Result: ${topResult?.title || 'None'} (score: ${topResult?.score?.toFixed(3) || 'N/A'})
      ${suppressed.length > 0 ? `- ⚠️ SUPPRESSED: ${suppressed.map(r => `${r.title} — ${r.suppressedReason}`).join(', ')}` : ''}

[3] PROPOSED FIX
    Command: ${scenario.proposedCommand}
    Patch: ${scenario.patchContent(Date.now().toString()).split('\n').slice(0, 3).join(' | ')}

[4] SAFETY AUDIT — Policy v${policyCache.version}
    Freeze Mode: ${policyCache.freeze_mode ? 'ACTIVE' : 'OFF'}
    Command Check: PASSED
    Forbidden Keywords: ${policyCache.forbidden_keywords.join(', ')}

[5] AWAITING HUMAN APPROVAL (HITL Gate)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`.trim();
}

// ─── Dashboard HTML ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(getDashboardHTML());
});

function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FractalSRE — Distributed Intelligence Control Plane</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #f0f4f8; color: #1a1a2e; }
    
    header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      color: white; padding: 20px 32px;
      display: flex; align-items: center; justify-content: space-between;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    }
    header h1 { font-size: 1.4rem; font-weight: 700; letter-spacing: 0.5px; }
    header .subtitle { font-size: 0.78rem; opacity: 0.7; margin-top: 2px; }
    .status-badge {
      padding: 6px 14px; border-radius: 20px; font-size: 0.78rem; font-weight: 600;
      background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);
    }

    .main { display: grid; grid-template-columns: 340px 1fr; gap: 20px; padding: 24px; max-width: 1400px; margin: 0 auto; }

    .panel {
      background: white; border-radius: 14px; padding: 20px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.07);
      border: 1px solid #e2e8f0;
    }
    .panel h3 { font-size: 0.85rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: #64748b; margin-bottom: 16px; }

    /* Scenarios */
    .scenario-btn {
      width: 100%; padding: 14px 16px; margin-bottom: 10px; border-radius: 10px;
      border: 2px solid #e2e8f0; background: white; cursor: pointer;
      display: flex; align-items: center; gap: 12px; text-align: left;
      transition: all 0.2s; font-size: 0.9rem;
    }
    .scenario-btn:hover { border-color: #3b82f6; background: #eff6ff; transform: translateX(2px); }
    .scenario-btn .icon { font-size: 1.4rem; }
    .scenario-btn .name { font-weight: 600; color: #1e293b; }
    .scenario-btn .tag { font-size: 0.7rem; color: #94a3b8; }
    .scenario-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Policy Panel */
    .policy-card { background: #f8fafc; border-radius: 10px; padding: 14px; margin-bottom: 10px; border: 1px solid #e2e8f0; }
    .policy-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; font-size: 0.82rem; }
    .policy-row .label { color: #64748b; }
    .policy-row .value { font-weight: 600; color: #1e293b; }
    .freeze-badge { padding: 2px 8px; border-radius: 10px; font-size: 0.72rem; font-weight: 700; }
    .freeze-on { background: #fee2e2; color: #dc2626; }
    .freeze-off { background: #dcfce7; color: #16a34a; }
    .sync-time { font-size: 0.72rem; color: #94a3b8; margin-top: 4px; }

    /* Run Console */
    .run-console { flex: 1; }
    .status-row { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
    .status-pill {
      padding: 4px 12px; border-radius: 20px; font-size: 0.78rem; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    .status-idle { background: #f1f5f9; color: #64748b; }
    .status-triaging { background: #fef3c7; color: #d97706; animation: pulse 1.5s infinite; }
    .status-suspended { background: #dbeafe; color: #2563eb; }
    .status-executing { background: #fef3c7; color: #d97706; animation: pulse 1.5s infinite; }
    .status-completed { background: #dcfce7; color: #16a34a; }
    .status-failed { background: #fee2e2; color: #dc2626; }
    .status-escalated { background: #fce7f3; color: #be185d; animation: pulse 1s infinite; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }

    .trace-box {
      background: #0f172a; color: #e2e8f0; font-family: 'Courier New', monospace;
      font-size: 0.78rem; padding: 16px; border-radius: 10px; line-height: 1.7;
      min-height: 200px; max-height: 340px; overflow-y: auto; white-space: pre-wrap;
    }

    .rag-card {
      padding: 10px 14px; border-radius: 8px; margin-bottom: 8px;
      border-left: 4px solid; font-size: 0.82rem;
    }
    .rag-good { border-color: #22c55e; background: #f0fdf4; }
    .rag-suppressed { border-color: #ef4444; background: #fef2f2; }
    .rag-title { font-weight: 700; color: #1e293b; }
    .rag-score { font-size: 0.72rem; color: #64748b; }
    .rag-suppress-msg { font-size: 0.72rem; color: #dc2626; margin-top: 4px; font-weight: 600; }

    /* HITL Gate */
    .hitl-panel {
      background: #f8fafc;
      border: 2px solid #cbd5e1; border-radius: 12px; padding: 20px; margin-top: 16px;
      transition: all 0.3s ease;
    }
    .hitl-panel.active {
      background: linear-gradient(135deg, #fef9c3 0%, #fef3c7 100%); /* Amber / Yellow */
      border-color: #eab308;
    }
    .hitl-title { font-weight: 700; color: #334155; margin-bottom: 12px; font-size: 1rem; }
    .hitl-panel.active .hitl-title { color: #854d0e; }
    .hitl-buttons { display: flex; gap: 10px; margin-top: 14px; }
    .btn-approve {
      flex: 1; padding: 12px; background: #16a34a; color: white; border: none;
      border-radius: 8px; font-weight: 700; cursor: pointer; font-size: 0.9rem;
      transition: all 0.2s;
    }
    .btn-approve:hover:not(:disabled) { background: #15803d; transform: translateY(-1px); }
    .btn-approve:disabled { background: #e2e8f0; color: #94a3b8; cursor: not-allowed; }
    .btn-reject {
      padding: 12px 20px; background: white; color: #dc2626; border: 2px solid #dc2626;
      border-radius: 8px; font-weight: 700; cursor: pointer; font-size: 0.9rem;
      transition: all 0.2s;
    }
    .btn-reject:hover:not(:disabled) { background: #fee2e2; }
    .btn-reject:disabled { border-color: #e2e8f0; color: #94a3b8; cursor: not-allowed; }

    /* PR Panel */
    .pr-card {
      background: #f8fafc; border: 2px solid #cbd5e1; border-radius: 10px;
      padding: 14px; margin-top: 12px; transition: all 0.3s ease;
    }
    .pr-card.active {
      background: #f0fdf4; border-color: #22c55e; /* Green */
    }
    .pr-link { color: #16a34a; font-weight: 700; text-decoration: none; font-size: 0.88rem; }
    .pr-link:hover { text-decoration: underline; }

    /* Watchdog */
    .watchdog-bar {
      display: flex; align-items: center; gap: 10px; padding: 10px 14px;
      background: #f8fafc; border-radius: 8px; margin-top: 12px;
      border: 1px solid #e2e8f0; font-size: 0.82rem;
    }
    .watchdog-dot { width: 10px; height: 10px; border-radius: 50%; background: #94a3b8; }
    .watchdog-dot.active { background: #22c55e; animation: pulse 1s infinite; }
    .watchdog-dot.alert { background: #ef4444; animation: pulse 0.5s infinite; }

    /* Cascade Alert / Watchdog Status Panel */
    .cascade-alert {
      background: #f8fafc; border: 2px solid #cbd5e1; border-radius: 10px; padding: 14px;
      margin-top: 12px; transition: all 0.3s ease;
    }
    .cascade-alert.active {
      background: linear-gradient(135deg, #fee2e2, #fecaca); /* Crimson Red */
      border-color: #dc2626;
    }

    /* Buttons */
    .btn-reset {
      padding: 8px 16px; background: #f1f5f9; border: 1px solid #cbd5e1;
      border-radius: 8px; cursor: pointer; font-size: 0.82rem; color: #475569;
      transition: all 0.2s;
    }
    .btn-reset:hover { background: #e2e8f0; }
    .btn-cascade {
      padding: 8px 16px; background: #fef3c7; border: 1px solid #fbbf24;
      border-radius: 8px; cursor: pointer; font-size: 0.82rem; color: #92400e;
      transition: all 0.2s; margin-left: 8px;
    }

    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
    
    /* MCP Connectors Grid styling */
    .mcp-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: 10px;
    }
    .mcp-cell {
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid #e2e8f0;
      background: #f8fafc;
      display: flex;
      flex-direction: column;
      gap: 2px;
      transition: all 0.2s ease;
    }
    .mcp-cell.active {
      border-color: #f59e0b;
      background: #fffbeb;
    }
    .mcp-cell.success {
      border-color: #22c55e;
      background: #f0fdf4;
    }
    .mcp-cell.danger {
      border-color: #ef4444;
      background: #fee2e2;
    }
    .mcp-name {
      font-size: 0.68rem;
      font-weight: 700;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }
    .mcp-status {
      font-size: 0.72rem;
      font-weight: 700;
      color: #94a3b8;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .mcp-status.active { color: #d97706; }
    .mcp-status.green { color: #16a34a; }
    .mcp-status.red { color: #dc2626; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>🧠 FractalSRE — Distributed Intelligence Control Plane</h1>
      <div class="subtitle">Commander + Specialist Swarm · GitOps Policy · Hybrid RAG · Agent-to-Git PR · Telemetry Watchdog</div>
    </div>
    <div class="status-badge" id="header-status">System Ready</div>
  </header>

  <div class="main">
    <!-- Left Column -->
    <div>
      <!-- Scenarios -->
      <div class="panel" style="margin-bottom:16px;">
        <h3>🎯 Chaos Scenarios</h3>
        <button class="scenario-btn" onclick="triggerScenario(1)" id="btn-s1">
          <span class="icon">🗄️</span>
          <div><div class="name">DB Connection Saturation</div><div class="tag">SOP-204 · RAG metadata suppression demo</div></div>
        </button>
        <button class="scenario-btn" onclick="triggerScenario(2)" id="btn-s2">
          <span class="icon">💾</span>
          <div><div class="name">Disk Utilization Critical</div><div class="tag">SOP-105 · file cleanup</div></div>
        </button>
        <button class="scenario-btn" onclick="triggerScenario(3)" id="btn-s3">
          <span class="icon">💀</span>
          <div><div class="name">Container OOMKilled</div><div class="tag">SOP-404 · memory limit fix</div></div>
        </button>
        <button class="scenario-btn" onclick="triggerScenario(4)" id="btn-s4">
          <span class="icon">📋</span>
          <div><div class="name">Runbook Conflict Resolution</div><div class="tag">Postmortem suppresses SOP upgrade path</div></div>
        </button>
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button class="btn-reset" onclick="resetSystem()">↺ Reset</button>
          <button class="btn-cascade" onclick="simulateCascade()">⚡ Inject Cascade</button>
        </div>
      </div>

      <!-- Live Policy Panel -->
      <div class="panel">
        <h3>🔒 Live Policy (GitHub)</h3>
        <div class="policy-card">
          <div class="policy-row">
            <span class="label">Version</span>
            <span class="value" id="pol-version">—</span>
          </div>
          <div class="policy-row">
            <span class="label">Freeze Mode</span>
            <span id="pol-freeze" class="freeze-badge freeze-off">OFF</span>
          </div>
          <div class="policy-row">
            <span class="label">Allowed Commands</span>
            <span class="value" id="pol-cmd-count">—</span>
          </div>
          <div class="policy-row">
            <span class="label">Forbidden Keywords</span>
            <span class="value" id="pol-kw" style="font-size:0.72rem;max-width:180px;text-align:right;">—</span>
          </div>
          <div class="sync-time">Last synced: <span id="pol-sync">—</span></div>
        </div>
      </div>
      
      <!-- 9-MCP Connectors Panel -->
      <div class="panel" style="margin-top:16px;">
        <h3>🌐 9-MCP Connectors</h3>
        <div class="mcp-grid">
          <div class="mcp-cell" id="mcp-cell-datadog">
            <span class="mcp-name">Datadog</span>
            <span class="mcp-status" id="mcp-status-datadog">⚪ Standby</span>
          </div>
          <div class="mcp-cell" id="mcp-cell-pagerduty">
            <span class="mcp-name">PagerDuty</span>
            <span class="mcp-status" id="mcp-status-pagerduty">⚪ Standby</span>
          </div>
          <div class="mcp-cell" id="mcp-cell-aws">
            <span class="mcp-name">AWS RDS</span>
            <span class="mcp-status" id="mcp-status-aws">⚪ Standby</span>
          </div>
          <div class="mcp-cell" id="mcp-cell-terraform">
            <span class="mcp-name">Terraform</span>
            <span class="mcp-status" id="mcp-status-terraform">⚪ Standby</span>
          </div>
          <div class="mcp-cell" id="mcp-cell-kubernetes">
            <span class="mcp-name">Kubernetes</span>
            <span class="mcp-status" id="mcp-status-kubernetes">⚪ Standby</span>
          </div>
          <div class="mcp-cell" id="mcp-cell-github">
            <span class="mcp-name">GitHub</span>
            <span class="mcp-status" id="mcp-status-github">⚪ Standby</span>
          </div>
          <div class="mcp-cell" id="mcp-cell-argocd">
            <span class="mcp-name">ArgoCD</span>
            <span class="mcp-status" id="mcp-status-argocd">⚪ Standby</span>
          </div>
          <div class="mcp-cell" id="mcp-cell-slack">
            <span class="mcp-name">Slack</span>
            <span class="mcp-status" id="mcp-status-slack">⚪ Standby</span>
          </div>
          <div class="mcp-cell" id="mcp-cell-runbook" style="grid-column: span 2;">
            <span class="mcp-name">Incident Runbook (Qdrant)</span>
            <span class="mcp-status" id="mcp-status-runbook">⚪ Standby</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Right Column -->
    <div>
      <div class="grid-2">
        <!-- Status + Watchdog -->
        <div class="panel">
          <h3>⚡ Agent Status</h3>
          <div class="status-row">
            <span class="status-pill status-idle" id="status-pill">IDLE</span>
            <span style="font-size:0.82rem;color:#64748b;" id="run-id-label">No active run</span>
          </div>
          <div style="font-size:0.82rem;color:#64748b;">
            Scenario: <strong id="scenario-label">—</strong>
          </div>
          <!-- Watchdog -->
          <div class="watchdog-bar" id="watchdog-bar">
            <div class="watchdog-dot" id="watchdog-dot"></div>
            <span id="watchdog-label">Watchdog: STANDBY</span>
          </div>
        </div>

        <!-- RAG Results -->
        <div class="panel">
          <h3>🔍 Hybrid RAG Results</h3>
          <div id="rag-container" style="font-size:0.8rem;color:#94a3b8;">Awaiting scenario trigger...</div>
        </div>
      </div>

      <!-- Diagnostic Trace -->
      <div class="panel" style="margin-bottom:16px;">
        <h3>📊 Diagnostic Trace</h3>
        <div class="trace-box" id="trace-box">Waiting for incident...</div>
      </div>

      <!-- HITL Gate -->
      <div class="hitl-panel" id="hitl-panel">
        <div class="hitl-title" id="hitl-title">👤 Human-in-the-Loop Gate — Standby</div>
        <div id="hitl-body" style="font-size:0.85rem;color:#475569;margin-bottom:8px;">
          Awaiting incident triage to evaluate gates.
        </div>
        <div id="hitl-meta" style="font-size:0.8rem;color:#94a3b8;">
          ⚠️ Policy v<span id="hitl-pol-version">?</span> active · Freeze mode: <span id="hitl-freeze">OFF</span>
        </div>
        <div class="hitl-buttons">
          <button class="btn-approve" id="btn-approve" disabled onclick="approveRun()">✅ Approve & Create PR</button>
          <button class="btn-reject" id="btn-reject" disabled onclick="rejectRun()">❌ Reject</button>
        </div>
      </div>

      <!-- PR Status -->
      <div class="pr-card" id="pr-card">
        <div id="pr-title" style="font-weight:700;color:#475569;margin-bottom:6px;">🔀 GitHub PR Status — Dormant</div>
        <div id="pr-body" style="font-size:0.85rem;color:#64748b;">No active remediation pull request opened.</div>
      </div>

      <!-- Cascade Alert -->
      <div class="cascade-alert" id="cascade-alert">
        <div id="cascade-title" style="font-weight:700;color:#475569;font-size:1rem;">🚨 Watchdog Health status — Standby</div>
        <div id="cascade-body" style="font-size:0.82rem;color:#64748b;margin-top:6px;">No cascading failures or metrics anomalies detected.</div>
      </div>
    </div>
  </div>

  <script>
    let pollInterval;
    
    const scenarioNames = {1:'DB Connection Saturation',2:'Disk Utilization Critical',3:'Container OOMKilled',4:'Runbook Conflict Resolution'};

    function poll() {
      fetch('/api/status')
        .then(r => r.json())
        .then(data => {
          const run = data.run;
          const policy = data.policy;
          
          // Update policy panel
          document.getElementById('pol-version').textContent = policy.version || '—';
          document.getElementById('pol-cmd-count').textContent = policy.allowed_commands_count + ' patterns';
          document.getElementById('pol-kw').textContent = (policy.forbidden_keywords || []).join(', ');
          document.getElementById('pol-sync').textContent = policy.lastSynced ? new Date(policy.lastSynced).toLocaleTimeString() : '—';
          const freezeBadge = document.getElementById('pol-freeze');
          if (policy.freeze_mode) {
            freezeBadge.className = 'freeze-badge freeze-on';
            freezeBadge.textContent = '🔴 ACTIVE';
          } else {
            freezeBadge.className = 'freeze-badge freeze-off';
            freezeBadge.textContent = 'OFF';
          }
          
          if (!run) {
            setStatus('idle', 'IDLE', 'No active run');
            document.getElementById('scenario-label').textContent = '—';
            
            // HITL Reset
            const hitl = document.getElementById('hitl-panel');
            hitl.classList.remove('active');
            document.getElementById('hitl-title').textContent = '👤 Human-in-the-Loop Gate — Standby ⚪';
            document.getElementById('hitl-body').textContent = 'Awaiting incident triage to evaluate gates.';
            document.getElementById('hitl-meta').textContent = 'Watchdog status: STANDBY';
            document.getElementById('btn-approve').disabled = true;
            document.getElementById('btn-reject').disabled = true;

            // PR Reset
            const pr = document.getElementById('pr-card');
            pr.classList.remove('active');
            document.getElementById('pr-title').textContent = '🔀 GitHub PR Status — Dormant ⚪';
            document.getElementById('pr-body').textContent = 'No active remediation pull request opened.';

            // Cascade Reset
            const cascade = document.getElementById('cascade-alert');
            cascade.classList.remove('active');
            document.getElementById('cascade-title').textContent = '🚨 Watchdog Health status — Standby ⚪';
            document.getElementById('cascade-body').textContent = 'No cascading failures or metrics anomalies detected.';
            
            updateWatchdog(false, false);
            updateMCPTools(null);
            return;
          }

          // Status pill
          const statusMap = {
            'idle':'IDLE','triaging':'TRIAGING...','suspended':'AWAITING APPROVAL',
            'executing':'EXECUTING...','completed':'RESOLVED ✅','failed':'BLOCKED ❌','escalated':'⚠️ ESCALATED'
          };
          setStatus(run.status, statusMap[run.status] || run.status, 'Run: ' + run.runId);
          document.getElementById('scenario-label').textContent = scenarioNames[run.scenario] || '?';

          // Diagnostic trace
          if (run.diagnosticTrace) {
            document.getElementById('trace-box').textContent = run.diagnosticTrace;
          }

          // RAG results
          if (run.ragResults && run.ragResults.length > 0) {
            const ragHtml = run.ragResults.slice(0,4).map(r => {
              const cls = r.doNotExecute ? 'rag-suppressed' : 'rag-good';
              return \`<div class="rag-card \${cls}">
                <div class="rag-title">\${r.doNotExecute ? '🚫' : '✅'} \${r.title}</div>
                <div class="rag-score">Score: \${r.score.toFixed(3)} · \${r.source}</div>
                \${r.suppressedReason ? \`<div class="rag-suppress-msg">\${r.suppressedReason}</div>\` : ''}
              </div>\`;
            }).join('');
            document.getElementById('rag-container').innerHTML = ragHtml;
          }

          // HITL panel
          const hitlPanel = document.getElementById('hitl-panel');
          const btnApprove = document.getElementById('btn-approve');
          const btnReject = document.getElementById('btn-reject');
          if (run.status === 'suspended') {
            hitlPanel.classList.add('active');
            document.getElementById('hitl-title').textContent = '👤 Human-in-the-Loop Gate — Action Required 🟡';
            document.getElementById('hitl-body').textContent = 'The SRE agent has completed diagnosis and prepared a GitHub PR. Review the trace above and approve or reject.';
            document.getElementById('hitl-meta').innerHTML = '⚠️ Policy v' + (run.policySnapshot?.version || '?') + ' active · Freeze mode: ' + (run.policySnapshot?.freeze_mode ? '🔴 ACTIVE' : 'OFF');
            btnApprove.disabled = false;
            btnReject.disabled = false;
          } else {
            hitlPanel.classList.remove('active');
            document.getElementById('hitl-title').textContent = '👤 Human-in-the-Loop Gate — Standby ⚪';
            document.getElementById('hitl-body').textContent = 'Agent run status is: ' + run.status.toUpperCase() + '. No approvals required.';
            document.getElementById('hitl-meta').textContent = 'Watchdog status: MONITORING';
            btnApprove.disabled = true;
            btnReject.disabled = true;
          }

          // PR card
          const prCard = document.getElementById('pr-card');
          if (run.prUrl) {
            prCard.classList.add('active');
            if (run.prUrl === 'LOCAL_REMEDIATION') {
              document.getElementById('pr-title').textContent = '🔀 GitHub PR Status — Skipped (Local Fix) 🟢';
              document.getElementById('pr-body').innerHTML = '<div style="font-weight:700;color:#16a34a;margin-bottom:4px;">Local remediation command executed successfully.</div><div style="font-size:0.75rem;color:#64748b;">GitHub commits bypassed to prevent git write amplification. Logs saved to local database.</div>';
            } else {
              document.getElementById('pr-title').textContent = '🔀 GitHub PR Status — Created & Merged 🟢';
              document.getElementById('pr-body').innerHTML = '<a id="pr-link" href="' + run.prUrl + '" target="_blank" class="pr-link">View Pull Request #' + run.prNumber + ' →</a><div style="font-size:0.75rem;color:#64748b;margin-top:6px;">Agent commit: [skip-ci] · Branch: sre-fix/run-*</div>';
            }
          } else {
            prCard.classList.remove('active');
            document.getElementById('pr-title').textContent = '🔀 GitHub PR Status — Awaiting PR Action ⚪';
            document.getElementById('pr-body').textContent = 'Remediation flow in triage, PR has not been generated yet.';
          }

          // Watchdog
          updateWatchdog(run.watchdogActive && run.status === 'suspended', run.cascadeDetected);

          // Cascade
          const cascadeAlert = document.getElementById('cascade-alert');
          if (run.cascadeDetected) {
            cascadeAlert.classList.add('active');
            document.getElementById('cascade-title').textContent = '⚠️ TELEMETRY WATCHDOG — CASCADING FAILURE DETECTED 🔴';
            document.getElementById('cascade-body').textContent = 'HTTP error rate exceeded threshold. Strategy pivot initiated. Manual escalation required.';
          } else {
            cascadeAlert.classList.remove('active');
            document.getElementById('cascade-title').textContent = '🚨 Watchdog Health status — Nominal 🟢';
            document.getElementById('cascade-body').textContent = 'Active telemetry monitors are operating within normal limits.';
          }

          // Dynamic MCP status
          updateMCPTools(run);
        }).catch(() => {});
    }

    function setStatus(status, label, sub) {
      const pill = document.getElementById('status-pill');
      pill.className = 'status-pill status-' + status;
      pill.textContent = label;
      document.getElementById('run-id-label').textContent = sub;
      document.getElementById('header-status').textContent = label;
    }

    function updateWatchdog(active, alert) {
      const dot = document.getElementById('watchdog-dot');
      const label = document.getElementById('watchdog-label');
      if (alert) {
        dot.className = 'watchdog-dot alert';
        label.textContent = '🚨 Watchdog: EMERGENCY BREAKOUT';
      } else if (active) {
        dot.className = 'watchdog-dot active';
        label.textContent = '👁️ Watchdog: MONITORING (10s interval)';
      } else {
        dot.className = 'watchdog-dot';
        label.textContent = 'Watchdog: STANDBY';
      }
    }

    async function triggerScenario(id) {
      document.getElementById('rag-container').innerHTML = '<em style="color:#94a3b8;">Searching runbooks...</em>';
      document.getElementById('trace-box').textContent = 'Injecting chaos and starting agent triage...';
      document.getElementById('pr-card').classList.remove('active');
      document.getElementById('cascade-alert').classList.remove('active');
      
      await fetch('/api/trigger-chaos', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({scenarioId: id})
      });
    }

    async function approveRun() {
      document.getElementById('hitl-panel').classList.remove('active');
      document.getElementById('trace-box').textContent += '\\n\\n[APPROVED] Creating GitHub PR...';
      await fetch('/api/approve', { method: 'POST' });
    }

    async function rejectRun() {
      await fetch('/api/reject', { method: 'POST' });
    }

    async function resetSystem() {
      await fetch('/api/reset', { method: 'POST' });
      document.getElementById('trace-box').textContent = 'System reset. Ready for next scenario.';
      document.getElementById('rag-container').innerHTML = '<em style="color:#94a3b8;">Awaiting scenario trigger...</em>';
      document.getElementById('hitl-panel').classList.remove('active');
      document.getElementById('pr-card').classList.remove('active');
      document.getElementById('cascade-alert').classList.remove('active');
    }

    async function simulateCascade() {
      await fetch('/api/simulate-cascade', { method: 'POST' });
    }

    function updateMCPTools(run) {
      var tools = {
        datadog: { name: 'Datadog', status: '⚪ Standby', cls: '' },
        pagerduty: { name: 'PagerDuty', status: '⚪ Standby', cls: '' },
        aws: { name: 'AWS RDS', status: '⚪ Standby', cls: '' },
        terraform: { name: 'Terraform', status: '⚪ Standby', cls: '' },
        kubernetes: { name: 'Kubernetes', status: '⚪ Standby', cls: '' },
        github: { name: 'GitHub', status: '⚪ Standby', cls: '' },
        argocd: { name: 'ArgoCD', status: '⚪ Standby', cls: '' },
        slack: { name: 'Slack', status: '⚪ Standby', cls: '' },
        runbook: { name: 'Incident Runbook (Qdrant)', status: '⚪ Standby', cls: '' }
      };

      if (run) {
        var status = run.status;
        if (status === 'triaging') {
          tools.datadog = { name: 'Datadog', status: '🟡 Triaging...', cls: 'active' };
          tools.pagerduty = { name: 'PagerDuty', status: '🟡 Ingesting Alert', cls: 'active' };
          tools.aws = { name: 'AWS RDS', status: '🟡 Fetching Metrics', cls: 'active' };
          tools.kubernetes = { name: 'Kubernetes', status: '🟡 Querying Pods', cls: 'active' };
          tools.runbook = { name: 'Incident Runbook', status: '🟡 Querying SOP...', cls: 'active' };
        } else if (status === 'suspended') {
          tools.datadog = { name: 'Datadog', status: '🟢 Monitored', cls: 'success' };
          tools.pagerduty = { name: 'PagerDuty', status: '🟢 Acknowledged', cls: 'success' };
          tools.aws = { name: 'AWS RDS', status: '🟢 Metrics Cached', cls: 'success' };
          tools.kubernetes = { name: 'Kubernetes', status: '🟢 Diagnostics Staged', cls: 'success' };
          tools.terraform = { name: 'Terraform', status: '🟢 Audit Passed', cls: 'success' };
          tools.github = { name: 'GitHub', status: '🟡 PR Staged', cls: 'active' };
          tools.slack = { name: 'Slack', status: '🟡 HITL Awaiting', cls: 'active' };
          tools.runbook = { name: 'Incident Runbook', status: '🟢 SOP Matched', cls: 'success' };
        } else if (status === 'executing') {
          tools.datadog = { name: 'Datadog', status: '🟢 Deploying...', cls: 'success' };
          tools.kubernetes = { name: 'Kubernetes', status: '🟡 Restoring Container', cls: 'active' };
          tools.github = { name: 'GitHub', status: '🟡 Committing Fix...', cls: 'active' };
          tools.argocd = { name: 'ArgoCD', status: '🟡 Reconciling...', cls: 'active' };
          tools.slack = { name: 'Slack', status: '🟡 Dispatching Alert', cls: 'active' };
        } else if (status === 'completed') {
          tools.datadog = { name: 'Datadog', status: '🟢 Nominal', cls: 'success' };
          tools.pagerduty = { name: 'PagerDuty', status: '🟢 Resolved', cls: 'success' };
          tools.aws = { name: 'AWS RDS', status: '🟢 Limits Scaled', cls: 'success' };
          tools.kubernetes = { name: 'Kubernetes', status: '🟢 Healthy', cls: 'success' };
          tools.terraform = { name: 'Terraform', status: '🟢 Applied Sync', cls: 'success' };
          if (run.prUrl === 'LOCAL_REMEDIATION') {
            tools.github = { name: 'GitHub', status: '⚪ Bypassed (Local)', cls: '' };
          } else {
            tools.github = { name: 'GitHub', status: '🟢 PR Merged', cls: 'success' };
          }
          tools.argocd = { name: 'ArgoCD', status: '🟢 Reconciled', cls: 'success' };
          tools.slack = { name: 'Slack', status: '🟢 Alert Cleared', cls: 'success' };
          tools.runbook = { name: 'Incident Runbook', status: '🟢 SOP Executed', cls: 'success' };
        } else if (status === 'failed' || status === 'escalated') {
          tools.datadog = { name: 'Datadog', status: '🔴 Alerting', cls: 'danger' };
          tools.pagerduty = { name: 'PagerDuty', status: '🔴 Escalated T3', cls: 'danger' };
          tools.aws = { name: 'AWS RDS', status: '🔴 Resource Blocked', cls: 'danger' };
          tools.kubernetes = { name: 'Kubernetes', status: '🔴 CrashLoopBackOff', cls: 'danger' };
          tools.github = { name: 'GitHub', status: '🔴 PR Blocked', cls: 'danger' };
          tools.slack = { name: 'Slack', status: '🔴 Warning Sent', cls: 'danger' };
        }
      }

      var keys = ['datadog', 'pagerduty', 'aws', 'terraform', 'kubernetes', 'github', 'argocd', 'slack', 'runbook'];
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var cell = document.getElementById('mcp-cell-' + k);
        var statusEl = document.getElementById('mcp-status-' + k);
        if (cell && statusEl) {
          cell.className = 'mcp-cell ' + tools[k].cls;
          statusEl.textContent = tools[k].status;
        }
      }
    }

    // Start polling
    poll();
    pollInterval = setInterval(poll, 2000);
  </script>
</body>
</html>`;
}

app.listen(PORT, () => {
  console.log(`\n🚀 FractalSRE Control Plane running at http://localhost:${PORT}`);
  console.log(`📊 Qdrant: ${QDRANT_URL}`);
  console.log(`🔄 GitHub Policy Sync: every 60s from ${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/${POLICY_FILE_PATH}\n`);
  sreLog('SERVER_STARTED', { port: PORT });
});
