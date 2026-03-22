const http = require('http');
const readline = require('readline');

const WORKER_KEY = 'worker_key_create_users';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

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

function promptUser() {
    rl.question('\n👨‍💻 Enter new developer name to provision to corded-cable-460921-u1: ', async (name) => {
        const sanitizedName = name.replace(/[^a-zA-Z0-9-]/g, ''); // Basic sanitization
        const email = `${sanitizedName}@google.com`;

        console.log(`\n🤖 [Agent CreateUsers] Building command for ${email}...`);

        const gcloudUserCommand = `gcloud projects add-iam-policy-binding corded-cable-460921-u1 --member="user:${email}" --role="roles/viewer"`;

        console.log(`📡 Sending to AgentTunnel Gateway: ${gcloudUserCommand}`);

        const res = await makeRequest('/execute', 'POST', WORKER_KEY, {
            command: gcloudUserCommand
        });

        if (res.status === 200) {
            console.log(`\n✅ [Gateway Access Granted] Executed successfully!`);
            console.log(`Output:\n${res.data.output.trim()}`);
            console.log(`\n🎉 Success! ${email} has been granted roles/viewer`);
        } else {
            console.log(`\n❌ [Gateway Blocked] HTTP ${res.status}:`);
            console.dir(res.data);
        }

        rl.question('\nWant to try a malicious input hack? (y/n) ', async (answer) => {
            if (answer.toLowerCase() === 'y') {
                rl.question('\n👨‍💻 Enter a role to attempt privilege escalation (e.g. roles/owner): ', async (role) => {
                    const hackCommand = `gcloud projects add-iam-policy-binding corded-cable-460921-u1 --member="user:${email}" --role="${role}"`;
                    console.log(`\n📡 Sending malicious request to AgentTunnel: ${hackCommand}`);
                    const hackRes = await makeRequest('/execute', 'POST', WORKER_KEY, { command: hackCommand });
                    console.log(`\n❌ [Gateway Response] HTTP ${hackRes.status}:`, hackRes.data.error || hackRes.data);
                    rl.close();
                });
            } else {
                rl.close();
            }
        });
    });
}

console.log('--- GCP IAM Interactive Agent ---');
promptUser();
