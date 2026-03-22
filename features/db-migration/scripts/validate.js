const { MongoClient } = require('mongodb');

const uri = 'mongodb+srv://Webcalc:Oraib%40123@webcalc.7y26uqv.mongodb.net/?retryWrites=true&w=majority&appName=Webcalc';
const client = new MongoClient(uri);

async function runValidation() {
    try {
        console.log('[VALIDATE] Verifying schema integrity...');
        await client.connect();
        const db = client.db('agent_test_db');
        const collection = db.collection('test_data');

        const doc = await collection.findOne({ type: 'schema_tracker' });

        if (doc && doc._agent_migrated) {
            console.log(`[VALIDATE] SUCCESS - Database integrity confirmed at ${doc.last_migration}`);
        } else {
            throw new Error('Migration missing or corrupted.');
        }
    } catch (e) {
        console.error('[VALIDATE] FAILED:', e.message);
        process.exit(1);
    } finally {
        await client.close();
    }
}
runValidation();
