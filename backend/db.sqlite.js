import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DB_PATH = resolve('data', 'rio.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_conversations_user
    ON conversations(user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    emotion TEXT,
    intent TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_user
    ON messages(user_id, created_at);

  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    fact TEXT NOT NULL,
    importance INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memories_user
    ON memories(user_id, importance DESC, created_at DESC);

  CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    friend_email TEXT NOT NULL,
    friend_name TEXT,
    created_at INTEGER NOT NULL,
    last_alerted_at INTEGER,
    UNIQUE(user_id, friend_email)
  );
  CREATE INDEX IF NOT EXISTS idx_friends_user
    ON friends(user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS email_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    friend_id INTEGER,
    friend_email TEXT,
    sent_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_email_log_account
    ON email_log(account_id, sent_at);

  CREATE TABLE IF NOT EXISTS login_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_login_codes_email
    ON login_codes(email, created_at DESC);

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user
    ON sessions(user_id);
`);

// Online migration for existing dbs created before email/verified_at columns existed.
{
  const cols = db.prepare(`PRAGMA table_info(users)`).all().map((r) => r.name);
  if (!cols.includes('email')) db.exec(`ALTER TABLE users ADD COLUMN email TEXT`);
  if (!cols.includes('verified_at')) db.exec(`ALTER TABLE users ADD COLUMN verified_at INTEGER`);
  // SQLite can't add a UNIQUE constraint via ALTER; emulate it with a unique index.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL`);
}

// Online migration: add conversation_id to messages and bucket pre-existing
// flat per-user messages into one default "Imported chat" conversation each.
// Idempotent — re-runs are no-ops once every message has a conversation_id.
{
  const msgCols = db.prepare(`PRAGMA table_info(messages)`).all().map((r) => r.name);
  if (!msgCols.includes('conversation_id')) {
    db.exec(`ALTER TABLE messages ADD COLUMN conversation_id INTEGER`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(conversation_id, created_at)`);

  const orphanUsers = db.prepare(
    `SELECT DISTINCT user_id FROM messages WHERE conversation_id IS NULL`
  ).all();
  const insertConv = db.prepare(
    `INSERT INTO conversations (user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`
  );
  const updateOrphans = db.prepare(
    `UPDATE messages SET conversation_id = ? WHERE user_id = ? AND conversation_id IS NULL`
  );
  const minMaxCreated = db.prepare(
    `SELECT MIN(created_at) AS min_t, MAX(created_at) AS max_t FROM messages
     WHERE user_id = ? AND conversation_id IS NULL`
  );
  for (const { user_id } of orphanUsers) {
    const range = minMaxCreated.get(user_id) ?? {};
    const fallback = Date.now();
    const minT = Number(range.min_t ?? fallback);
    const maxT = Number(range.max_t ?? fallback);
    const result = insertConv.run(user_id, 'Imported chat', minT, maxT);
    const convId = Number(result.lastInsertRowid);
    updateOrphans.run(convId, user_id);
  }
}

const stmts = {
  upsertUser: db.prepare(
    `INSERT INTO users (id, created_at) VALUES (?, ?)
     ON CONFLICT(id) DO NOTHING`
  ),
  insertMessage: db.prepare(
    `INSERT INTO messages (user_id, role, content, emotion, intent, created_at, conversation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ),
  recentMessagesByConv: db.prepare(
    `SELECT role, content, emotion, intent, created_at
     FROM messages WHERE user_id = ? AND conversation_id = ?
     ORDER BY created_at DESC LIMIT ?`
  ),
  allMessagesByConv: db.prepare(
    `SELECT id, role, content, emotion, intent, created_at
     FROM messages WHERE user_id = ? AND conversation_id = ?
     ORDER BY created_at ASC LIMIT ?`
  ),
  insertConversation: db.prepare(
    `INSERT INTO conversations (user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`
  ),
  listConversations: db.prepare(
    `SELECT c.id, c.title, c.created_at, c.updated_at,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS msg_count
     FROM conversations c
     WHERE c.user_id = ?
     ORDER BY c.updated_at DESC`
  ),
  getConversation: db.prepare(
    `SELECT id, user_id, title, created_at, updated_at FROM conversations
     WHERE id = ? AND user_id = ?`
  ),
  renameConversation: db.prepare(
    `UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?`
  ),
  bumpConversation: db.prepare(
    `UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?`
  ),
  deleteConversationMessages: db.prepare(
    `DELETE FROM messages WHERE conversation_id = ? AND user_id = ?`
  ),
  deleteConversationRow: db.prepare(
    `DELETE FROM conversations WHERE id = ? AND user_id = ?`
  ),
  insertMemory: db.prepare(
    `INSERT INTO memories (user_id, fact, importance, created_at)
     VALUES (?, ?, ?, ?)`
  ),
  topMemories: db.prepare(
    `SELECT id, fact, importance, created_at
     FROM memories WHERE user_id = ?
     ORDER BY importance DESC, created_at DESC LIMIT ?`
  ),
  deleteMemory: db.prepare(`DELETE FROM memories WHERE id = ? AND user_id = ?`),
  updateMemory: db.prepare(
    `UPDATE memories SET fact = COALESCE(?, fact), importance = COALESCE(?, importance) WHERE id = ? AND user_id = ?`
  ),
  insertFriend: db.prepare(
    `INSERT INTO friends (user_id, friend_email, friend_name, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, friend_email) DO UPDATE SET friend_name = excluded.friend_name`
  ),
  listFriends: db.prepare(
    `SELECT id, user_id, friend_email, friend_name, created_at, last_alerted_at
     FROM friends WHERE user_id = ?
     ORDER BY created_at ASC`
  ),
  countFriends: db.prepare(`SELECT COUNT(*) AS n FROM friends WHERE user_id = ?`),
  deleteFriend: db.prepare(`DELETE FROM friends WHERE id = ? AND user_id = ?`),
  markAlerted: db.prepare(`UPDATE friends SET last_alerted_at = ? WHERE id = ?`),
  emotionCounts: db.prepare(
    `SELECT emotion, COUNT(*) AS n
     FROM messages
     WHERE user_id = ? AND role = 'user' AND emotion IS NOT NULL
       AND created_at >= ?
     GROUP BY emotion`
  ),
  emotionSeries: db.prepare(
    `SELECT emotion, created_at
     FROM messages
     WHERE user_id = ? AND role = 'user' AND emotion IS NOT NULL
       AND created_at >= ?
     ORDER BY created_at ASC`
  ),
  insertEmailLog: db.prepare(
    `INSERT INTO email_log (account_id, friend_id, friend_email, sent_at)
     VALUES (?, ?, ?, ?)`
  ),
  countEmailSendsSince: db.prepare(
    `SELECT COUNT(*) AS n FROM email_log
     WHERE account_id = ? AND sent_at >= ?`
  ),
  findUserByEmail: db.prepare(
    `SELECT id, email, verified_at, created_at FROM users WHERE email = ?`
  ),
  findUserById: db.prepare(
    `SELECT id, email, verified_at, created_at FROM users WHERE id = ?`
  ),
  attachEmail: db.prepare(
    `UPDATE users SET email = ?, verified_at = ? WHERE id = ?`
  ),
  insertUserWithEmail: db.prepare(
    `INSERT INTO users (id, email, verified_at, created_at) VALUES (?, ?, ?, ?)`
  ),
  insertLoginCode: db.prepare(
    `INSERT INTO login_codes (email, code_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?)`
  ),
  latestLoginCode: db.prepare(
    `SELECT id, email, code_hash, expires_at, consumed_at, attempts, created_at
     FROM login_codes
     WHERE email = ? AND consumed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`
  ),
  countCodesSince: db.prepare(
    `SELECT COUNT(*) AS n FROM login_codes
     WHERE email = ? AND created_at >= ?`
  ),
  markCodeConsumed: db.prepare(
    `UPDATE login_codes SET consumed_at = ? WHERE id = ?`
  ),
  bumpCodeAttempts: db.prepare(
    `UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?`
  ),
  insertSession: db.prepare(
    `INSERT INTO sessions (token, user_id, created_at, last_seen_at)
     VALUES (?, ?, ?, ?)`
  ),
  getSession: db.prepare(
    `SELECT token, user_id, created_at, last_seen_at FROM sessions WHERE token = ?`
  ),
  touchSession: db.prepare(
    `UPDATE sessions SET last_seen_at = ? WHERE token = ?`
  ),
  deleteSession: db.prepare(
    `DELETE FROM sessions WHERE token = ?`
  ),
};

export async function ensureUser(userId) {
  stmts.upsertUser.run(userId, Date.now());
}

export async function saveMessage({ userId, role, content, emotion = null, intent = null, conversationId }) {
  if (!conversationId) throw new Error('saveMessage: conversationId is required');
  const numConvId = /^\d+$/.test(String(conversationId)) ? Number(conversationId) : conversationId;
  stmts.insertMessage.run(userId, role, content, emotion, intent, Date.now(), numConvId);
}

export async function getRecentMessages(userId, limit = 10, conversationId) {
  if (!conversationId) return [];
  const numConvId = /^\d+$/.test(String(conversationId)) ? Number(conversationId) : conversationId;
  return stmts.recentMessagesByConv.all(userId, numConvId, limit).reverse();
}

export async function getAllMessages(userId, limit = 50, conversationId) {
  if (!conversationId) return [];
  const numConvId = /^\d+$/.test(String(conversationId)) ? Number(conversationId) : conversationId;
  return stmts.allMessagesByConv.all(userId, numConvId, limit);
}

/* ===== Conversations ===== */

export async function createConversation({ userId, title = 'New chat' }) {
  const now = Date.now();
  const result = stmts.insertConversation.run(userId, String(title).slice(0, 200), now, now);
  return {
    id: Number(result.lastInsertRowid),
    user_id: userId,
    title,
    created_at: now,
    updated_at: now,
    msg_count: 0,
  };
}

export async function listConversations(userId) {
  return stmts.listConversations.all(userId);
}

export async function getConversation(id, userId) {
  const numId = /^\d+$/.test(String(id)) ? Number(id) : id;
  return stmts.getConversation.get(numId, userId) ?? null;
}

export async function renameConversation(id, userId, title) {
  const numId = /^\d+$/.test(String(id)) ? Number(id) : id;
  const result = stmts.renameConversation.run(String(title).slice(0, 200), Date.now(), numId, userId);
  return { changes: Number(result.changes ?? 0) };
}

export async function bumpConversationUpdatedAt(id, userId) {
  const numId = /^\d+$/.test(String(id)) ? Number(id) : id;
  stmts.bumpConversation.run(Date.now(), numId, userId);
}

export async function deleteConversation(id, userId) {
  const numId = /^\d+$/.test(String(id)) ? Number(id) : id;
  // Two-step delete (foreign keys aren't enforced by default in node:sqlite).
  stmts.deleteConversationMessages.run(numId, userId);
  const result = stmts.deleteConversationRow.run(numId, userId);
  return { changes: Number(result.changes ?? 0) };
}

export async function saveMemory({ userId, fact, importance }) {
  stmts.insertMemory.run(userId, fact, importance, Date.now());
}

export async function getTopMemories(userId, limit = 15) {
  return stmts.topMemories.all(userId, limit);
}

export async function deleteMemory(id, userId) {
  // Server may pass either a numeric id (sqlite) or a string id; coerce.
  const numId = /^\d+$/.test(String(id)) ? Number(id) : id;
  const result = stmts.deleteMemory.run(numId, userId);
  return { changes: Number(result.changes ?? 0) };
}

export async function updateMemory(id, { fact, importance } = {}, userId) {
  const numId = /^\d+$/.test(String(id)) ? Number(id) : id;
  const factVal = typeof fact === 'string' && fact.trim() ? fact.trim() : null;
  const impVal =
    Number.isInteger(importance) && importance >= 1 && importance <= 5 ? importance : null;
  if (factVal === null && impVal === null) return { changes: 0 };
  const result = stmts.updateMemory.run(factVal, impVal, numId, userId);
  return { changes: Number(result.changes ?? 0) };
}

export async function addFriend({ userId, email, name }) {
  const friendEmail = String(email).trim().toLowerCase();
  const friendName = name ? String(name).trim() : null;
  stmts.insertFriend.run(userId, friendEmail, friendName, Date.now());
  // The sqlite UNIQUE conflict path doesn't return the row; pull it back by hand.
  const all = stmts.listFriends.all(userId);
  return all.find((f) => f.friend_email === friendEmail) ?? null;
}

export async function listFriends(userId) {
  return stmts.listFriends.all(userId);
}

export async function countFriends(userId) {
  return stmts.countFriends.get(userId)?.n ?? 0;
}

export async function deleteFriend(id, userId) {
  const numId = /^\d+$/.test(String(id)) ? Number(id) : id;
  stmts.deleteFriend.run(numId, userId);
}

export async function markFriendAlerted(id) {
  const numId = /^\d+$/.test(String(id)) ? Number(id) : id;
  stmts.markAlerted.run(Date.now(), numId);
}

export async function getEmotionCounts(userId, sinceMs) {
  return stmts.emotionCounts.all(userId, sinceMs);
}

export async function getEmotionSeries(userId, sinceMs) {
  return stmts.emotionSeries.all(userId, sinceMs);
}

export async function logEmailSend({ accountId, friendId, friendEmail }) {
  stmts.insertEmailLog.run(accountId, friendId ?? null, friendEmail ?? null, Date.now());
}

export async function countEmailSendsSince(accountId, sinceMs) {
  return stmts.countEmailSendsSince.get(accountId, sinceMs)?.n ?? 0;
}

/* ===== Auth ===== */

export async function findUserByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  return stmts.findUserByEmail.get(e) ?? null;
}

export async function findUserById(id) {
  if (!id) return null;
  return stmts.findUserById.get(id) ?? null;
}

export async function attachEmailToUser(userId, email) {
  const e = String(email || '').trim().toLowerCase();
  stmts.attachEmail.run(e, Date.now(), userId);
}

export async function createUserWithEmail({ id, email }) {
  const e = String(email || '').trim().toLowerCase();
  const now = Date.now();
  stmts.insertUserWithEmail.run(id, e, now, now);
}

export async function insertLoginCode({ email, codeHash, expiresAt }) {
  const e = String(email || '').trim().toLowerCase();
  stmts.insertLoginCode.run(e, codeHash, expiresAt, Date.now());
}

export async function latestLoginCodeFor(email) {
  const e = String(email || '').trim().toLowerCase();
  return stmts.latestLoginCode.get(e) ?? null;
}

export async function countCodesSince(email, sinceMs) {
  const e = String(email || '').trim().toLowerCase();
  return stmts.countCodesSince.get(e, sinceMs)?.n ?? 0;
}

export async function markCodeConsumed(id) {
  stmts.markCodeConsumed.run(Date.now(), id);
}

export async function bumpCodeAttempts(id) {
  stmts.bumpCodeAttempts.run(id);
}

export async function createSession(token, userId) {
  const now = Date.now();
  stmts.insertSession.run(token, userId, now, now);
}

export async function getSession(token) {
  if (!token) return null;
  return stmts.getSession.get(token) ?? null;
}

export async function touchSession(token) {
  stmts.touchSession.run(Date.now(), token);
}

export async function deleteSession(token) {
  stmts.deleteSession.run(token);
}

export const driver = 'sqlite';
