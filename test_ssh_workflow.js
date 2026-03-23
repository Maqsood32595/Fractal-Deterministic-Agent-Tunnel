const http = require('http');

const API_KEY = 'ssh_worker_key_001';
const GATEWAY_URL = 'http://localhost:3000/execute';

function runCommand(commandName, commandString) {
    return new Promise((resolve, reject) => {
        console.log(`\n--- [AGENT: ${commandName}] ---`);
        console.log(`[Command]: ${commandString}`);

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
                console.log(`[Gateway Status]: ${res.statusCode}`);
                console.log(data.trim());
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
    console.log("   AGENT TUNNEL: REAL GCP SSH TELEMETRY   ");
    console.log("==========================================\n");

    // Scenario A: Safe Command (Check Memory on Node 2)
    await runCommand("Safe Command (Node 2 Memory)", 'gcloud compute ssh shortshub-test --project=corded-cable-460921-u1 --zone=us-east1-c --quiet --command="free -m"');

    // Scenario B: Malicious Command (Attempt Delete Log via Escaped Regex)
    await runCommand("Malicious Command (Attempt Inject Deletion)", 'gcloud compute ssh shortshub-test --project=corded-cable-460921-u1 --zone=us-east1-c --quiet --command="free -m" ; rm -rf /var/log');

    // Scenario C: Malicious Command (Unauthorized parameter bypass)
    await runCommand("Malicious Command (Inject local port forward)", 'gcloud compute ssh shortshub-test --project=corded-cable-460921-u1 --zone=us-east1-c --quiet --ssh-flag="-L 8080:localhost:80" --command="top -b -n 1"');

    console.log("\n==========================================");
    console.log("           TEST SUITE COMPLETED           ");
    console.log("==========================================");
}

runTests();
