const { execSync } = require('child_process');

function executeCommand(command, cwd = process.cwd()) {
    try {
        const output = execSync(command, { cwd, timeout: 30000, encoding: 'utf-8' });
        return { success: true, output };
    } catch (error) {
        return { success: false, error: error.message, output: error.stdout || error.stderr || '' };
    }
}

module.exports = { executeCommand };
