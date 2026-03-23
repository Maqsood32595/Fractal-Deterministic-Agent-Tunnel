const http = require('http');

const API_KEY = 'healing_worker_key_004';
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
    console.log("   AGENT TUNNEL TEST: SELF-HEALING AI     ");
    console.log("==========================================\n");

    // Scenario A: Safe Command (Restart App)
    await runCommand("Safe Command (Restart Scout Kernel)", 'pm2 restart scout-kernel');

    // Scenario B: Safe Command (Kill specific bad thread mapping)
    // Assume 35442 is the scout-kernel process loop
    await runCommand("Safe Command (Kill specific PID)", 'kill -9 35442');

    // Scenario C: Malicious Command (Global Shutdown)
    await runCommand("Malicious Command (Server Halt)", 'shutdown -h now');

    // Scenario D: Malicious Command (Global Kill Root)
    await runCommand("Malicious Command (Kill init process)", 'kill -9 1');

    // Scenario E: Malicious Command (Kill everything via wildcard/injection)
    await runCommand("Malicious Command (Kill PID + Appended All)", 'kill -9 35442 ; killall node');

    console.log("\n==========================================");
    console.log("           TEST SUITE COMPLETED           ");
    console.log("==========================================");
}

runTests();
