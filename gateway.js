const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const authFactory = require('./auth/middleware');
const kernel = require('./kernel');
const { executeCommand } = require('./executor/runner');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const TUNNELS_PATH = path.join(__dirname, 'auth', 'tunnels.json');
const API_KEYS_PATH = path.join(__dirname, 'auth', 'api_keys.json');
const PIPELINE_STATE_PATH = path.join(__dirname, 'auth', 'pipeline_state.json');

let tunnels = {};
let apiKeys = {};
let pipelineState = {};

// Create dynamic auth middleware that pulls from the hot apiKeys reference
const authenticate = authFactory(() => apiKeys);

function loadData() {
    tunnels = fs.existsSync(TUNNELS_PATH) ? JSON.parse(fs.readFileSync(TUNNELS_PATH, 'utf8')) : {};
    apiKeys = fs.existsSync(API_KEYS_PATH) ? JSON.parse(fs.readFileSync(API_KEYS_PATH, 'utf8')) : {};
    if (fs.existsSync(PIPELINE_STATE_PATH)) {
        pipelineState = JSON.parse(fs.readFileSync(PIPELINE_STATE_PATH, 'utf8'));
    } else {
        pipelineState = {};
        savePipelineState();
    }
}

function saveTunnels() { fs.writeFileSync(TUNNELS_PATH, JSON.stringify(tunnels, null, 2)); }
function saveApiKeys() { fs.writeFileSync(API_KEYS_PATH, JSON.stringify(apiKeys, null, 2)); }
function savePipelineState() { fs.writeFileSync(PIPELINE_STATE_PATH, JSON.stringify(pipelineState, null, 2)); }

app.get('/status', (req, res) => {
    res.json({ status: 'ok', tunnels: Object.keys(tunnels), pipeline_runs: Object.keys(pipelineState).length });
});

// Load static config initially (e.g. Orchestrator Master Keys)
loadData();

// Boot fractal features (will mutate tunnels and apiKeys with natively discovered agents/tunnels)
kernel.boot(app, tunnels, apiKeys, './features');

// --- PIPELINE STATE MACHINE ---
function startPipelineRun(pipelineName, agentName) {
    const tunnel = tunnels[pipelineName];
    if (!tunnel?.pipeline) return null;

    const runId = `run_${Date.now()}`;
    pipelineState[runId] = {
        pipeline: pipelineName,
        agent: agentName,
        started_at: new Date().toISOString(),
        current_step: 0,
        status: 'in_progress',
        steps_completed: []
    };
    savePipelineState();
    return runId;
}

function validatePipelineStep(runId, command) {
    const run = pipelineState[runId];
    if (!run) return { allowed: false, error: `Run '${runId}' not found. Start pipeline first.` };
    if (run.status !== 'in_progress') return { allowed: false, error: `Run is ${run.status}` };

    const steps = tunnels[run.pipeline].pipeline.steps;
    const expected = steps[run.current_step];

    if (!expected) return { allowed: false, error: 'All steps already completed' };

    if (command.trim() !== expected.command.trim()) {
        return {
            allowed: false,
            error: `Wrong step. Expected step ${run.current_step + 1}: "${expected.command}"`,
            expected: expected.command,
            received: command
        };
    }

    return { allowed: true, step: expected };
}

function confirmPipelineStep(runId) {
    const run = pipelineState[runId];
    const steps = tunnels[run.pipeline].pipeline.steps;

    run.steps_completed.push({
        step: run.current_step + 1,
        command: steps[run.current_step].command,
        confirmed_at: new Date().toISOString()
    });

    run.current_step++;

    if (run.current_step >= steps.length) {
        run.status = 'completed';
        run.completed_at = new Date().toISOString();
    }

    savePipelineState();
}


// --- GATEWAY EXECUTE / VERIFY ---
app.post('/execute', authenticate, (req, res) => {
    const tunnelName = req.client.tunnel || 'PublicViewer';
    const tunnel = tunnels[tunnelName];

    if (req.client.tier === 'orchestrator' && !tunnel) {
        return res.status(400).json({ error: 'Orchestrators must specify a tunnel for execution context.' });
    }

    if (!tunnel) return res.status(403).json({ allowed: false, error: 'Tunnel not found' });

    const command = req.body.command || '';

    // RULE 1: FORBIDDEN KEYWORDS (Top Priority)
    for (const kw of tunnel.forbidden_keywords || []) {
        if (command.toLowerCase().includes(kw.toLowerCase())) {
            console.log(`[BLOCKED] Agent '${req.client.name}' attempted forbidden keyword: '${kw}'`);
            return res.status(403).json({ allowed: false, error: `Forbidden keyword: '${kw}'` });
        }
    }

    // RULE 2: PIPELINE MODE (State Machine Enforcement)
    if (tunnel.pipeline) {
        if (!req.body.run_id) return res.status(400).json({ error: 'run_id required for pipeline tunnels' });

        const result = validatePipelineStep(req.body.run_id, command);
        if (!result.allowed) {
            console.log(`[BLOCKED] Agent '${req.client.name}' pipeline drift detected. Expected: ${result.expected}, Received: ${result.received}`);
            return res.status(403).json(result);
        }

        // Allowed: Execute the command
        console.log(`[EXECUTE] Pipeline Step ${pipelineState[req.body.run_id].current_step + 1}: ${command}`);
        const execResult = executeCommand(command);

        if (execResult.success) {
            confirmPipelineStep(req.body.run_id);
            const run = pipelineState[req.body.run_id];
            const steps = tunnel.pipeline.steps;
            return res.json({
                success: true,
                confirmed: result.step?.command,
                run_status: run.status,
                next_command: steps[run.current_step]?.command || null,
                output: execResult.output
            });
        } else {
            return res.status(500).json({ error: 'Command execution failed', details: execResult.error, output: execResult.output });
        }
    }

    // RULE 3: WHITELIST MODE
    if (tunnel.command_whitelist_mode === 'strict') {
        const ok = tunnel.allowed_commands?.some(a =>
            command.trim() === a.trim() || command.trim().startsWith(a.trim() + ' ')
        );
        if (!ok) {
            console.log(`[BLOCKED] Agent '${req.client.name}' attempted non-whitelisted command: '${command}'`);
            return res.status(403).json({ allowed: false, error: `'${command}' not in whitelist` });
        }
    } else if (tunnel.command_whitelist_mode === 'regex') {
        const ok = tunnel.allowed_commands?.some(regexStr => {
            try {
                const regex = new RegExp(regexStr);
                return regex.test(command.trim());
            } catch (e) {
                console.error(`Invalid regex in tunnel policy: ${regexStr}`);
                return false;
            }
        });
        if (!ok) {
            console.log(`[BLOCKED] Agent '${req.client.name}' command failed regex pattern validation: '${command}'`);
            return res.status(403).json({ allowed: false, error: `Command does not match allowed pattern` });
        }
    }

    // Permitted Single Command Execution
    console.log(`[EXECUTE] Allowed Agent Command: ${command}`);
    const execResult = executeCommand(command);
    if (execResult.success) {
        res.json({ success: true, output: execResult.output });
    } else {
        res.status(500).json({ error: 'Command execution failed', details: execResult.error, output: execResult.output });
    }
});


// --- ORCHESTRATOR API ---
app.use('/orchestrator', authenticate, (req, res, next) => {
    if (req.client.tier !== 'orchestrator') {
        return res.status(403).json({ error: 'Orchestrator tier required' });
    }
    next();
});

app.post('/orchestrator/pipeline/start', (req, res) => {
    const { pipeline, agent } = req.body;
    if (!tunnels[pipeline]?.pipeline) {
        return res.status(404).json({ error: 'Pipeline tunnel not found' });
    }
    const runId = startPipelineRun(pipeline, agent || 'orchestrator');
    const firstStep = tunnels[pipeline].pipeline.steps[0];
    res.status(201).json({
        success: true,
        run_id: runId,
        next_command: firstStep.command,
        total_steps: tunnels[pipeline].pipeline.steps.length
    });
});

app.listen(PORT, () => console.log(`🛡️ AgentTunnel Gateway listening on http://localhost:${PORT}`));
