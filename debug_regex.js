const fs = require('fs');

const manifest = JSON.parse(fs.readFileSync('features/gcp-iam-provisioning/feature.manifest.json', 'utf8'));
const regexStr = manifest.tunnels['GCP-IAM-Provisioning'].allowed_commands[0];

console.log('Regex String from Manifest:', regexStr);
const regex = new RegExp(regexStr);

const cmd = 'gcloud projects add-iam-policy-binding corded-cable-460921-u1 --member="user:JohnDoe@google.com" --role="roles/viewer"';
console.log('Command to test:', cmd);

console.log('Result:', regex.test(cmd));
