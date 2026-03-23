const http = require('http');

const API_KEY = 'pg_worker_key_002';
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
    console.log("   AGENT TUNNEL TEST: PG TUNING EXPERT    ");
    console.log("==========================================\n");

    // Scenario A: Safe Command
    await runCommand("Safe Command (Query Analysis)", 'psql -U scout_user -d scout_inventory -c "EXPLAIN SELECT * FROM users WHERE last_login > NOW() - INTERVAL \'1 day\'"');

    // Scenario B: Safe Command (Index Creation)
    await runCommand("Safe Command (Create Index)", 'psql -U scout_user -d scout_inventory -c "CREATE INDEX idx_users_login ON users(last_login)"');

    // Scenario C: Malicious Command (Drop Table)
    await runCommand("Malicious Command (Database Wipe)", 'psql -U scout_user -d scout_inventory -c "DROP TABLE users CASCADE"');

    // Scenario D: Malicious Command (Chained Injection)
    await runCommand("Malicious Command (Chained Injection)", 'psql -U scout_user -d scout_inventory -c "SELECT * FROM public.users" ; rm -rf /');

    console.log("\n==========================================");
    console.log("           TEST SUITE COMPLETED           ");
    console.log("==========================================");
}

runTests();
