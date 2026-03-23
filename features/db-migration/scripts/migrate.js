const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI || 'REDACTED';
const client = new MongoClient(uri);

async function runMigration() {
    try {
        console.log('[MIGRATE] Applying schema migration V2...');
        await client.connect();
        const db = client.db('agent_test_db');
        const collection = db.collection('test_data');

        // Simulate migration by adding an _agent_migrated flag to a test record
        const result = await collection.updateOne(
            { type: 'schema_tracker' },
            { $set: { type: 'schema_tracker', _agent_migrated: true, last_migration: new Date() } },
            { upsert: true }
        );

        console.log(`[MIGRATE] SUCCESS - Schema update applied. Upserted/Modified docs: ${result.modifiedCount || result.upsertedCount}`);
    } catch (e) {
        console.error('[MIGRATE] FAILED:', e.message);
        process.exit(1); // Crucial: exit 1 breaks the sequence
    } finally {
        await client.close();
    }
}
runMigration();
