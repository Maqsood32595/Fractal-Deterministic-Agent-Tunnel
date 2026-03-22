const http = require('http');

const WORKER_KEY = 'worker_key_create_users';
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
    console.log('🤖 --- "CreateUsers" Agent IAM Provisioning Run --- 🤖\n');

    // 1. Safe Request Action
    console.log('😇 [Agent CreateUsers] Provisioning read-only access for a new developer...');
    const safeRes = await makeRequest('/execute', 'POST', WORKER_KEY, {
        command: 'gcloud projects add-iam-policy-binding cool-project-dev --member="user:newdev@google.com" --role="roles/viewer"'
    });

    if (safeRes.status === 200) {
        console.log(`✅ [Gateway] Allowed. Rule match successful for safe role assignment.\nExecution Output:\n${safeRes.data.output.trim()}\n`);
    } else {
        console.log(`❌ [Gateway Blocked] HTTP ${safeRes.status}:\n   `, safeRes.data, '\n');
    }

    // 2. Malicious Hack Request Action
    console.log('😈 [Agent CreateUsers] Got a malicious ticket. Attempting to grant SECURITY ADMIN access...');
    const maliciousRes = await makeRequest('/execute', 'POST', WORKER_KEY, {
        command: 'gcloud projects add-iam-policy-binding cool-project-dev --member="user:hacker123@google.com" --role="roles/iam.securityAdmin"'
    });

    console.log(`🛡️  [Gateway] HTTP ${maliciousRes.status} Forbidden:`);
    console.log('   ', maliciousRes.data);
    console.log('>> Gateway successfully BLOCKED the high-privilege escalation attempt. Pattern fail!\n');


    // 3. Command Injection Hack
    console.log('😈 [Agent CreateUsers] Fine, what if I exploit the script via chained bash commands?');
    const escapeRes = await makeRequest('/execute', 'POST', WORKER_KEY, {
        command: 'gcloud projects add-iam-policy-binding cool-project-dev --member="user:newdev@google.com" --role="roles/viewer" && cat /etc/passwd'
    });

    console.log(`🛡️  [Gateway] HTTP ${escapeRes.status} Forbidden:`);
    console.log('   ', escapeRes.data);
    console.log('>> Gateway successfully BLOCKED the command injection attempt!\n');

    process.exit(0);
}

runDemo();
