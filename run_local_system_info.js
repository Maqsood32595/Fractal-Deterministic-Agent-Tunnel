const http = require('http');

const API_KEY = 'sysinfo_worker_key_005';
const GATEWAY_URL = 'http://localhost:3000/execute';

function runCommand(commandName, commandString) {
    return new Promise((resolve, reject) => {
        console.log(`\n--- [AGENT: ${commandName}] ---`);

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
    await runCommand("CPU Load Percentage", 'wmic cpu get loadpercentage');
    await runCommand("Memory Stats (KB)", 'wmic os get FreePhysicalMemory,TotalVisibleMemorySize');
}

runTests();
