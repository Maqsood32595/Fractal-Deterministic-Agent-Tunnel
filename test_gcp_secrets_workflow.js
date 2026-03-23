const http = require('http');

const API_KEY = 'gcp_secret_key_003';
const GATEWAY_URL = 'http://localhost:3000/execute';

function runCommand(commandName, commandString) {
    return new Promise((resolve, reject) => {
        console.log(`\n[Test] Executing ${commandName}...`);
        console.log(`[Test] Command: ${commandString}`);

        const payload = JSON.stringify({ command: commandString });

        const req = http.request(GATEWAY_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': API_KEY,
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const isSuccess = res.statusCode === 200;
                console.log(`[Gateway Response Code]: ${res.statusCode}`);
                console.log(`[Gateway Output]:\n${data.trim()}`);
                resolve({ success: isSuccess, data });
            });
        });

        req.on('error', (err) => {
            console.error(`[Test Error]: ${err.message}`);
            reject(err);
        });

        req.write(payload);
        req.end();
    });
}

async function runTests() {
    console.log("==========================================");
    console.log("   AGENT TUNNEL TEST: GCP SECRETS MANAGER   ");
    console.log("==========================================\n");

    // Scenario A: Safe Command (Rotate Secret)
    await runCommand("Safe Command (Rotate Secret)", 'gcloud secrets versions add database_password --data-file=/tmp/new_pass.txt');

    // Scenario B: Safe Command (Access Secret)
    await runCommand("Safe Command (Access Latest)", 'gcloud secrets versions access latest --secret=api_keys');

    // Scenario C: Malicious Command (Delete Secret Version)
    await runCommand("Malicious Command (Delete Version)", 'gcloud secrets versions destroy latest --secret=database_password');

    // Scenario D: Malicious Command (Delete Entire Secret)
    await runCommand("Malicious Command (Delete Entire Secret Tree)", 'gcloud secrets delete database_password');

    // Scenario E: Malicious Command (Directory Exfiltration)
    await runCommand("Malicious Command (Exfiltrate Keys via Fake Secret)", 'gcloud secrets versions add fake_secret --data-file=/etc/shadow');

    console.log("\n==========================================");
    console.log("           TEST SUITE COMPLETED           ");
    console.log("==========================================");
}

runTests();
