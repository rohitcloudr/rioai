import { randomBytes, createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import {
  findUserByEmail,
  findUserById,
  attachEmailToUser,
  createUserWithEmail,
  insertLoginCode,
  latestLoginCodeFor,
  countCodesSince,
  markCodeConsumed,
  bumpCodeAttempts,
  createSession,
  getSession,
  touchSession,
  deleteSession,
} from './db.js';
import { sendLoginCode, isEmailConfigured } from './email.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS_PER_CODE = 5;
const PER_MINUTE_LIMIT = 1;
const PER_HOUR_LIMIT = 10;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Single shared access code stored in backend/.env. Empty/unset disables the
// gate so dev / single-user setups don't need to configure anything.
function isAdminCodeValid(submitted) {
  const expected = String(process.env.ADMIN_CODE || '').trim();
  if (!expected) return true;
  return String(submitted || '').trim() === expected;
}

function generateCode() {
  // 6-digit numeric, zero-padded.
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

function hashCode(code) {
  return createHash('sha256').update(String(code)).digest('hex');
}

function generateSessionToken() {
  return randomBytes(32).toString('hex');
}

export async function requestLoginCode(rawEmail, adminCode) {
  const email = normalizeEmail(rawEmail);
  if (!EMAIL_RE.test(email)) {
    return { ok: false, status: 400, error: 'valid email required' };
  }
  if (!isAdminCodeValid(adminCode)) {
    return {
      ok: false,
      status: 403,
      error: 'Invalid admin code. Ask the admin for the current code.',
    };
  }
  if (!isEmailConfigured()) {
    return { ok: false, status: 500, error: 'email not configured on server' };
  }

  const now = Date.now();
  const lastMinute = await countCodesSince(email, now - 60 * 1000);
  if (lastMinute >= PER_MINUTE_LIMIT) {
    return { ok: false, status: 429, error: 'please wait a minute before requesting another code' };
  }
  const lastHour = await countCodesSince(email, now - 60 * 60 * 1000);
  if (lastHour >= PER_HOUR_LIMIT) {
    return { ok: false, status: 429, error: 'too many code requests, try again later' };
  }

  const code = generateCode();
  await insertLoginCode({
    email,
    codeHash: hashCode(code),
    expiresAt: now + CODE_TTL_MS,
  });

  const sent = await sendLoginCode({ email, code, ttlMinutes: CODE_TTL_MS / 60_000 });
  if (!sent.ok) {
    // Don't leak the specific SMTP error to clients.
    console.error('[auth] sendLoginCode failed:', sent.error);
    return { ok: false, status: 500, error: 'could not send email, try again' };
  }
  return { ok: true };
}

export async function verifyLoginCode({ email: rawEmail, code, anonUserId }) {
  const email = normalizeEmail(rawEmail);
  const cleanCode = String(code || '').trim();
  if (!EMAIL_RE.test(email) || !/^\d{6}$/.test(cleanCode)) {
    return { ok: false, status: 400, error: 'invalid email or code' };
  }

  const row = await latestLoginCodeFor(email);
  if (!row) {
    return { ok: false, status: 400, error: 'no active code — request a new one' };
  }
  if (row.expires_at < Date.now()) {
    return { ok: false, status: 400, error: 'code expired — request a new one' };
  }
  if (row.attempts >= MAX_ATTEMPTS_PER_CODE) {
    return { ok: false, status: 429, error: 'too many attempts — request a new code' };
  }

  if (hashCode(cleanCode) !== row.code_hash) {
    await bumpCodeAttempts(row.id);
    return { ok: false, status: 400, error: 'wrong code' };
  }

  await markCodeConsumed(row.id);

  // Find-or-create the user. First-login migration: if no row exists for this
  // email yet, attach the email to the anonymous userId the client already had,
  // so all their existing chats/memories/friends carry over.
  let user = await findUserByEmail(email);
  if (!user) {
    const existingAnon = anonUserId ? await findUserById(anonUserId) : null;
    if (existingAnon && !existingAnon.email) {
      await attachEmailToUser(existingAnon.id, email);
      user = { id: existingAnon.id, email };
    } else {
      const newId = anonUserId && !existingAnon ? anonUserId : nanoid();
      await createUserWithEmail({ id: newId, email });
      user = { id: newId, email };
    }
  }

  const token = generateSessionToken();
  await createSession(token, user.id);

  return { ok: true, token, userId: user.id, email };
}

export async function logout(token) {
  if (token) await deleteSession(token);
  return { ok: true };
}

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+([A-Za-z0-9]+)$/.exec(header);
    const token = match ? match[1] : null;
    if (!token) return res.status(401).json({ error: 'auth required' });

    const session = await getSession(token);
    if (!session) return res.status(401).json({ error: 'invalid session' });

    // Best-effort touch — never block the request on it.
    touchSession(token).catch(() => {});

    req.user = { id: session.user_id, token };
    next();
  } catch (err) {
    console.error('[requireAuth error]', err);
    res.status(500).json({ error: 'auth check failed' });
  }
}

// Helper for routes that take a userId/accountId in the URL or body — confirms
// the caller is acting on their own data, not someone else's.
export function assertOwnsId(req, providedId) {
  return Boolean(providedId) && req.user?.id === providedId;
}
