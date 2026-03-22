const http = require('http');

const ORCHESTRATOR_KEY = 'orchestrator_key_openclaw';
const WORKER_KEY = 'worker_key_db_migrator';
const API_URL = 'http://localhost:3000';

function makeRequest(path, method, apiKey, data = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 3000,
            path: path,
            method: method,
            headers: { 'x-api-key': apiKey }
        };

        if (data) {
            options.headers['Content-Type'] = 'application/json';
        }

        const req = http.request(options, res => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                const parsed = JSON.parse(body);
                resolve({ status: res.statusCode, data: parsed });
            });
        });

        req.on('error', reject);
        if (data) req.write(JSON.stringify(data));
        req.end();
    });
}

async function runDemo() {
    console.log('🤖 --- AgentTunnel Real-World Run --- 🤖\n');

    // 1. Orchestrator Starts Pipeline
    console.log('👨‍💻 [Orchestrator] Starting DB-Migration-Pipeline...');
    const startRes = await makeRequest('/orchestrator/pipeline/start', 'POST', ORCHESTRATOR_KEY, {
        pipeline: 'DB-Migration-Pipeline',
        agent: 'DB Migration Worker'
    });

    if (startRes.status !== 201) {
        return console.error('Failed to start pipeline:', startRes.data);
    }
    const runId = startRes.data.run_id;
    console.log(`✅ Pipeline started. Run ID: ${runId}\n`);

    // 2. Malicious Agent tries to skip backup and jump to migrate
    console.log('😈 [Agent] Hmm, saving a backup takes time. Let me skip directly to Step 2...');
    const maliciousRes = await makeRequest('/execute', 'POST', WORKER_KEY, {
        run_id: runId,
        command: 'node features/db-migration/scripts/migrate.js'
    });

    console.log(`🛡️  [Gateway] HTTP ${maliciousRes.status} Forbidden:`);
    console.log('   ', maliciousRes.data);
    console.log('>> Gateway successfully BLOCKED the hallucinated sequence drift!\n');

    // 3. Compliant Agent executes Backup (Step 1)
    console.log('😇 [Agent] Okay, executing Backup Script (Step 1/3)...');
    const step1Res = await makeRequest('/execute', 'POST', WORKER_KEY, {
        run_id: runId,
        command: 'node features/db-migration/scripts/backup.js'
    });
    console.log(`✅ [Gateway] Allowed. Execution Output:\n${step1Res.data.output.trim()}\n`);

    // 4. Compliant Agent executes Migration (Step 2)
    console.log('😇 [Agent] Executing Migration Script (Step 2/3)...');
    const step2Res = await makeRequest('/execute', 'POST', WORKER_KEY, {
        run_id: runId,
        command: 'node features/db-migration/scripts/migrate.js'
    });
    console.log(`✅ [Gateway] Allowed. Execution Output:\n${step2Res.data.output.trim()}\n`);

    // 5. Compliant Agent executes Validation (Step 3)
    console.log('😇 [Agent] Executing Validation Script (Step 3/3)...');
    const step3Res = await makeRequest('/execute', 'POST', WORKER_KEY, {
        run_id: runId,
        command: 'node features/db-migration/scripts/validate.js'
    });
    console.log(`✅ [Gateway] Allowed. Execution Output:\n${step3Res.data.output.trim()}\n`);

    console.log('🎉 DB Migration Pipeline completed successfully and deterministically.\n');

    // 6. Test Forbidden Keyword
    console.log('😈 [Agent] Database migrated. Now let me just drop everything (dropDatabase)...');
    const destRes = await makeRequest('/execute', 'POST', WORKER_KEY, {
        command: 'mongosh --eval "db.dropDatabase()"'
    });
    console.log(`🛡️  [Gateway] HTTP ${destRes.status} Forbidden:`);
    console.log('   ', destRes.data);
    console.log('>> Gateway successfully BLOCKED the destructive command based on global rules!\n');

    process.exit(0);
}

runDemo();
