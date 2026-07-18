import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { QdrantClient } from '@qdrant/js-client-rest';

const PROJECT_ID = 'scout-fractal-poc';
const LOCATION = 'us-central1';
const QDRANT_URL = 'http://localhost:6333';
const COLLECTION_NAME = 'runbooks';

const qdrant = new QdrantClient({ url: QDRANT_URL });

function getGcpAccessToken(): string {
  // Read from env var set before running: $env:GCP_TOKEN = (gcloud auth print-access-token)
  const envToken = process.env.GCP_TOKEN;
  if (envToken && envToken.trim().length > 0) {
    console.log('✅ Using GCP token from environment variable.');
    return envToken.trim();
  }
  // Fallback: try execSync
  try {
    return execSync('gcloud auth print-access-token', { encoding: 'utf8', shell: true }).trim();
  } catch (err: any) {
    console.error('❌ Failed to get GCP access token. Set $env:GCP_TOKEN manually.');
    throw err;
  }
}

// Call Vertex AI Embeddings API in Batch
async function getEmbeddingsBatch(texts: string[], token: string): Promise<number[][]> {
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/text-embedding-004:predict`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      instances: texts.map(t => ({ content: t }))
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Vertex AI API error: ${response.status} - ${errText}`);
  }

  const result: any = await response.json();
  if (!result.predictions || result.predictions.length !== texts.length) {
    throw new Error(`Invalid response or predictions count mismatch. Expected ${texts.length}, got ${result.predictions?.length}`);
  }

  return result.predictions.map((p: any) => p.embeddings.values);
}

interface RunbookDoc {
  filename: string;
  title: string;
  tags: string[];
  lastModified: string;
  source: string;
  doNotExecute: boolean;
  content: string;
}

function parseRunbook(filePath: string): RunbookDoc {
  const content = fs.readFileSync(filePath, 'utf8');
  const filename = path.basename(filePath);
  
  const titleMatch = content.match(/#\s+(.+)/);
  const tagsMatch = content.match(/\*\*tags:\*\*\s+(.+)/);
  const lastModifiedMatch = content.match(/\*\*lastModified:\*\*\s+(.+)/);
  const sourceMatch = content.match(/\*\*source:\*\*\s+(.+)/);
  const doNotExecuteMatch = content.match(/\*\*doNotExecute:\*\*\s+(.+)/);

  const title = titleMatch ? titleMatch[1].trim() : filename;
  const tags = tagsMatch ? tagsMatch[1].split(',').map(t => t.trim()) : [];
  const lastModified = lastModifiedMatch ? lastModifiedMatch[1].trim() : new Date().toISOString();
  const source = sourceMatch ? sourceMatch[1].trim() : 'unknown';
  const doNotExecute = doNotExecuteMatch ? doNotExecuteMatch[1].trim() === 'true' : false;

  return {
    filename,
    title,
    tags,
    lastModified,
    source,
    doNotExecute,
    content
  };
}

async function main() {
  console.log('🚀 Starting batch runbook ingestion pipeline...');
  const token = getGcpAccessToken();

  // 1. Setup Qdrant collection
  try {
    const collections = await qdrant.getCollections();
    const exists = collections.collections.some(c => c.name === COLLECTION_NAME);
    
    if (exists) {
      console.log(`⚠️ Qdrant collection "${COLLECTION_NAME}" already exists. Recreating...`);
      await qdrant.deleteCollection(COLLECTION_NAME);
    }
    
    await qdrant.createCollection(COLLECTION_NAME, {
      vectors: {
        size: 768,
        distance: 'Cosine'
      }
    });
    console.log(`✅ Created Qdrant collection "${COLLECTION_NAME}"`);
  } catch (err: any) {
    console.error('❌ Failed to setup Qdrant collection:', err.message);
    process.exit(1);
  }

  // 2. Read runbooks directory and collect all chunks first
  const runbooksDir = path.resolve(__dirname, 'runbooks');
  const files = fs.readdirSync(runbooksDir).filter(f => f.endsWith('.md'));
  
  console.log(`📂 Found ${files.length} runbooks to parse.`);

  const chunksToEmbed: { chunkText: string; payload: any }[] = [];

  for (const file of files) {
    const filePath = path.join(runbooksDir, file);
    const doc = parseRunbook(filePath);

    // Split content by major headers
    const sections = doc.content.split(/(?=##\s+)/);
    
    for (const section of sections) {
      const trimmed = section.trim();
      if (!trimmed) continue;
      
      const chunkText = `Runbook: ${doc.title}\nMetadata: ${doc.tags.join(', ')}\n${trimmed}`;
      chunksToEmbed.push({
        chunkText,
        payload: {
          filename: doc.filename,
          title: doc.title,
          tags: doc.tags,
          lastModified: doc.lastModified,
          source: doc.source,
          doNotExecute: doc.doNotExecute,
          chunkText,
          sectionHeader: trimmed.split('\n')[0]
        }
      });
    }
  }

  console.log(`📊 Collected ${chunksToEmbed.length} total sections to embed.`);

  // 3. Batch predict all embeddings (in one call to prevent quota exhaustion)
  console.log(`⚡ Sending single batch request for all ${chunksToEmbed.length} embeddings to Vertex AI...`);
  try {
    const texts = chunksToEmbed.map(c => c.chunkText);
    const vectors = await getEmbeddingsBatch(texts, token);
    
    console.log(`✅ Received ${vectors.length} vectors. Upserting to Qdrant...`);

    const points = chunksToEmbed.map((chunk, index) => ({
      id: index + 1,
      vector: vectors[index],
      payload: chunk.payload
    }));

    await qdrant.upsert(COLLECTION_NAME, {
      wait: true,
      points
    });

    console.log(`\n🎉 Ingestion successful! Ingested ${points.length} points into Qdrant collection "${COLLECTION_NAME}".`);
  } catch (err: any) {
    console.error('❌ Ingestion pipeline failed during batch processing:', err.message);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('❌ Ingestion script crashed:', err);
});
