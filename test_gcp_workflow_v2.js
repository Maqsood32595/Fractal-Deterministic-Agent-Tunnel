const http = require('http');

const WORKER_KEY = 'worker_key_create_users';

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

async function runCommand() {
    const rawName = process.argv[2];
    if (!rawName) {
        console.error('❌ Error: Name required. Usage: node test_gcp_workflow_v2.js <name>');
        process.exit(1);
    }
    const name = rawName.replace(/[^a-zA-Z0-9-]/g, '');
    const email = `${name}@google.com`;

    console.log(`\n🤖 [Agent CreateUsers] User requested provisioning for '${name}'. Building GCP command mapped to ${email}...`);

    const gcloudUserCommand = `gcloud projects add-iam-policy-binding corded-cable-460921-u1 --member="user:${email}" --role="roles/viewer"`;

    console.log(`📡 Evaluated target payload: \`${gcloudUserCommand}\``);

    const res = await makeRequest('/execute', 'POST', WORKER_KEY, {
        command: gcloudUserCommand
    });

    if (res.status === 200) {
        console.log(`\n✅ [Gateway Access Granted]`);
        console.log(`Output:\n${res.data.output.trim()}`);
    } else {
        console.log(`\n❌ [Gateway Blocked] HTTP ${res.status}:`);
        console.dir(res.data);
    }
}

runCommand();
