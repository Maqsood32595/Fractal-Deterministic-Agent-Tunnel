const { MongoClient } = require('mongodb');
const fs = require('fs');

const uri = process.env.MONGODB_URI || 'REDACTED';
const client = new MongoClient(uri);

async function runBackup() {
    try {
        console.log('[BACKUP] Starting MongoDB backup process...');
        await client.connect();
        const db = client.db('agent_test_db');
        const collection = db.collection('test_data');

        // Fetch up to 100 docs for backup simulation
        const data = await collection.find({}).limit(100).toArray();
        fs.writeFileSync('db_backup.json', JSON.stringify(data, null, 2));

        console.log(`[BACKUP] SUCCESS - Successfully backed up ${data.length} records to db_backup.json`);
    } catch (e) {
        console.error('[BACKUP] FAILED:', e.message);
        process.exit(1);
    } finally {
        await client.close();
    }
}
runBackup();
