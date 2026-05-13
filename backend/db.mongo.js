import { MongoClient, ObjectId } from 'mongodb';
import dns from 'node:dns';

// Atlas SRV lookups can fail on Windows when Node's c-ares resolver
// picks up an empty/stub DNS list. Force public DNS to make the connection
// resilient to local resolver weirdness.
dns.setServers(['8.8.8.8', '1.1.1.1']);

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'rio';

if (!uri || uri.includes('paste') || uri.includes('YOUR-')) {
  throw new Error(
    'MongoDB not configured. Set MONGODB_URI in backend/.env (and optionally MONGODB_DB).'
  );
}

// Lazy connection — failed to connect at startup used to crash the whole
// process before Express bound to its port. With this, the server starts
// regardless and chat endpoints return a clean 503 with a fix hint until
// the connection is healthy.
let _db = null;
let _connecting = null;

function friendlyMongoError(err) {
  const msg = (err?.message ?? String(err)).split('\n')[0];
  if (msg.includes('tlsv1 alert internal error') || msg.toLowerCase().includes('tls')) {
    return 'MongoDB Atlas refused the TLS handshake — usually means your current IP is not on the Atlas Network Access allowlist. Add it at https://cloud.mongodb.com → Network Access, then retry.';
  }
  if (msg.includes('ENOTFOUND') || msg.includes('querySrv')) {
    return 'Could not resolve MongoDB Atlas hostname. Check your network / DNS, or the MONGODB_URI in backend/.env.';
  }
  if (msg.includes('ECONNREFUSED')) {
    return 'MongoDB connection refused. The cluster may be paused or your firewall is blocking 27017.';
  }
  if (msg.toLowerCase().includes('authentication failed') || msg.includes('bad auth')) {
    return 'MongoDB rejected the username/password in MONGODB_URI. Check the credentials.';
  }
  if (msg.includes('Server selection timed out')) {
    return 'MongoDB Atlas connection timed out. Either your IP is not allowlisted, or the cluster is paused.';
  }
  return `MongoDB connection failed: ${msg}`;
}

async function getDb() {
  if (_db) return _db;
  if (_connecting) return _connecting;
  _connecting = (async () => {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    try {
      await client.connect();
      const db = client.db(dbName);
      // Best-effort index creation — never fails the connect on this.
      try {
        await Promise.all([
          db.collection('messages').createIndex({ user_id: 1, created_at: 1 }),
          db.collection('memories').createIndex({ user_id: 1, importance: -1, created_at: -1 }),
        ]);
      } catch (idxErr) {
        console.warn('[mongo] index init warning:', idxErr?.message ?? idxErr);
      }
      _db = db;
      console.log(`[mongo] connected to ${dbName}`);
      return _db;
    } catch (err) {
      _connecting = null; // allow retry on next call
      const friendly = friendlyMongoError(err);
      console.error('[mongo] connect failed:', friendly);
      const e = new Error(friendly);
      e.status = 503;
      e.cause = err;
      throw e;
    }
  })();
  return _connecting;
}

async function col(name) {
  const db = await getDb();
  return db.collection(name);
}

function toObjectId(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id)) return new ObjectId(id);
  return id;
}

function shapeMessage(doc) {
  return {
    id: doc._id?.toString?.() ?? doc._id,
    role: doc.role,
    content: doc.content,
    emotion: doc.emotion ?? null,
    intent: doc.intent ?? null,
    created_at: doc.created_at,
  };
}

function shapeMemory(doc) {
  return {
    id: doc._id?.toString?.() ?? doc._id,
    fact: doc.fact,
    importance: doc.importance,
    created_at: doc.created_at,
  };
}

export async function ensureUser(userId) {
  const users = await col('users');
  await users.updateOne(
    { _id: userId },
    { $setOnInsert: { _id: userId, created_at: Date.now() } },
    { upsert: true }
  );
}

export async function saveMessage({ userId, role, content, emotion = null, intent = null }) {
  const messages = await col('messages');
  await messages.insertOne({
    user_id: userId,
    role,
    content,
    emotion,
    intent,
    created_at: Date.now(),
  });
}

export async function getRecentMessages(userId, limit = 10) {
  const messages = await col('messages');
  const docs = await messages
    .find({ user_id: userId })
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray();
  return docs.reverse().map(shapeMessage);
}

export async function getAllMessages(userId, limit = 50) {
  const messages = await col('messages');
  const docs = await messages
    .find({ user_id: userId })
    .sort({ created_at: 1 })
    .limit(limit)
    .toArray();
  return docs.map(shapeMessage);
}

export async function saveMemory({ userId, fact, importance }) {
  const memories = await col('memories');
  await memories.insertOne({
    user_id: userId,
    fact,
    importance,
    created_at: Date.now(),
  });
}

export async function getTopMemories(userId, limit = 15) {
  const memories = await col('memories');
  const docs = await memories
    .find({ user_id: userId })
    .sort({ importance: -1, created_at: -1 })
    .limit(limit)
    .toArray();
  return docs.map(shapeMemory);
}

export async function deleteMemory(id) {
  const memories = await col('memories');
  await memories.deleteOne({ _id: toObjectId(id) });
}

export const driver = 'mongodb';
