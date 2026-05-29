import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import {
  getAllMessages,
  getTopMemories,
  deleteMemory,
  updateMemory,
  addFriend,
  listFriends,
  countFriends,
  deleteFriend,
  getEmotionCounts,
  getEmotionSeries,
  createConversation,
  listConversations,
  getConversation,
  renameConversation,
  deleteConversation,
} from './db.js';
import { talkToRio, talkToRioAuto, talkToRioStream, listProviders } from './rio.js';
import { synthesizeSpeech } from './voice.js';
import { isEmailConfigured } from './email.js';
import { requestLoginCode, verifyLoginCode, logout, requireAuth, assertOwnsId } from './auth.js';

const app = express();

// CORS: in production, set FRONTEND_URL to your deployed site origin
// (comma-separated list also works, e.g. "https://rio.vercel.app,https://rio.example.com").
// If unset, falls back to allowing all origins — convenient for local dev.
const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length === 0 ? true : allowedOrigins,
    credentials: true,
  })
);

// Trust the first proxy (Render/Railway/Fly all sit behind one) so req.ip
// and req.protocol reflect the real client.
app.set('trust proxy', 1);

app.use(express.json({ limit: '64kb' }));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FRIENDS_PER_USER = 5;

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, emailConfigured: isEmailConfigured() });
});

app.get('/api/providers', (_req, res) => {
  res.json({ providers: listProviders() });
});

/* ===== Auth ===== */

app.post('/api/auth/request-code', async (req, res) => {
  try {
    const { email, adminCode } = req.body ?? {};
    const result = await requestLoginCode(email, adminCode);
    if (!result.ok) {
      return res.status(result.status || 400).json({ error: result.error });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth/request-code error]', err);
    res.status(500).json({ error: 'unexpected error' });
  }
});

app.post('/api/auth/verify-code', async (req, res) => {
  try {
    const { email, code, anonUserId } = req.body ?? {};
    const result = await verifyLoginCode({ email, code, anonUserId });
    if (!result.ok) {
      return res.status(result.status || 400).json({ error: result.error });
    }
    res.json({ token: result.token, userId: result.userId, email: result.email });
  } catch (err) {
    console.error('[auth/verify-code error]', err);
    res.status(500).json({ error: 'unexpected error' });
  }
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  try {
    await logout(req.user.token);
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth/logout error]', err);
    res.status(500).json({ error: 'unexpected error' });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  res.json({ userId: req.user.id });
});

/* ===== Protected routes ===== */

app.post('/api/chat', requireAuth, async (req, res) => {
  const { userId, message, provider, model, mode, stream, accountId, conversationId } = req.body ?? {};
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'userId required' });
  }
  if (!assertOwnsId(req, userId)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (accountId && !assertOwnsId(req, accountId)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message required' });
  }
  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId required' });
  }
  // Verify the conversation belongs to this user before any work.
  const conv = await getConversation(conversationId, req.user.id);
  if (!conv) {
    return res.status(404).json({ error: 'conversation not found' });
  }

  const isVoice = mode === 'voice';
  // Voice mode auto-cascades only when the user hasn't pinned a specific model.
  // If they picked one in the call overlay, honour it and surface its errors directly.
  const useAuto = isVoice && !provider;

  // Streaming path — only for non-voice, non-auto-cascade flows. Auto-cascade
  // can't stream because the first attempt may need to fail before we know
  // which provider serves the response.
  if (stream && !useAuto) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    try {
      const result = await talkToRioStream(userId, message.trim(), provider, model, (token) => {
        res.write(`event: token\ndata: ${JSON.stringify({ token })}\n\n`);
      }, accountId, conv.id);
      res.write(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
    } catch (err) {
      console.error('[chat stream error]', err);
      const status = (err?.status >= 400 && err?.status < 600) ? err.status : 500;
      const userMsg = status === 429
        ? `Rate limit / quota hit on ${provider || 'current provider'}. Try a different model from the picker, or wait a bit.`
        : (err?.message ?? 'unknown error');
      res.write(`event: error\ndata: ${JSON.stringify({ error: userMsg, status })}\n\n`);
    } finally {
      res.end();
    }
    return;
  }

  try {
    const result = useAuto
      ? await talkToRioAuto(userId, message.trim(), accountId, conv.id)
      : await talkToRio(userId, message.trim(), provider, model, accountId, conv.id);
    res.json(result);
  } catch (err) {
    console.error('[chat error]', err);
    const status = (err?.status >= 400 && err?.status < 600) ? err.status : 500;
    let userMsg;
    if (status === 429) {
      userMsg = useAuto
        ? 'Every voice provider is rate-limited right now. Wait a few seconds and try again.'
        : `Rate limit / quota hit on ${provider || 'current provider'}. Try a different model from the picker, or wait a bit.`;
    } else {
      userMsg = err?.message ?? 'unknown error';
    }
    res.status(status).json({
      error: userMsg,
      status,
      provider: provider || null,
      model: model || null,
    });
  }
});

app.get('/api/conversation/:userId', requireAuth, async (req, res) => {
  if (!assertOwnsId(req, req.params.userId)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    let conversationId = req.query.conversationId;
    // If caller doesn't specify, fall back to their most-recent conversation
    // (or empty if they have none yet).
    if (!conversationId) {
      const list = await listConversations(req.params.userId);
      if (list.length === 0) return res.json({ messages: [], conversationId: null });
      conversationId = list[0].id;
    } else {
      const conv = await getConversation(conversationId, req.params.userId);
      if (!conv) return res.status(404).json({ error: 'conversation not found' });
    }
    const messages = await getAllMessages(req.params.userId, 200, conversationId);
    res.json({ messages, conversationId: Number(conversationId) });
  } catch (err) {
    console.error('[conversation error]', err);
    res.status(500).json({ error: err?.message ?? 'unknown error' });
  }
});

/* ===== Conversations ===== */

app.get('/api/conversations/:userId', requireAuth, async (req, res) => {
  if (!assertOwnsId(req, req.params.userId)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const conversations = await listConversations(req.params.userId);
    res.json({ conversations });
  } catch (err) {
    console.error('[conversations list error]', err);
    res.status(500).json({ error: err?.message ?? 'unknown error' });
  }
});

app.post('/api/conversations', requireAuth, async (req, res) => {
  const { userId, title } = req.body ?? {};
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'userId required' });
  }
  if (!assertOwnsId(req, userId)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const cleanTitle = typeof title === 'string' && title.trim() ? title.trim() : 'New chat';
  try {
    const conv = await createConversation({ userId, title: cleanTitle });
    res.json({ conversation: conv });
  } catch (err) {
    console.error('[conversation create error]', err);
    res.status(500).json({ error: err?.message ?? 'unknown error' });
  }
});

app.patch('/api/conversations/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const { title } = req.body ?? {};
  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title required' });
  }
  try {
    const result = await renameConversation(id, req.user.id, title.trim());
    if (!result || result.changes === 0) {
      return res.status(404).json({ error: 'conversation not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[conversation rename error]', err);
    res.status(500).json({ error: err?.message ?? 'unknown error' });
  }
});

app.delete('/api/conversations/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: 'invalid id' });
  try {
    const result = await deleteConversation(id, req.user.id);
    if (!result || result.changes === 0) {
      return res.status(404).json({ error: 'conversation not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[conversation delete error]', err);
    res.status(500).json({ error: err?.message ?? 'unknown error' });
  }
});

app.get('/api/memory/:userId', requireAuth, async (req, res) => {
  if (!assertOwnsId(req, req.params.userId)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const memories = await getTopMemories(req.params.userId, 100);
    res.json({ memories });
  } catch (err) {
    console.error('[memory error]', err);
    res.status(500).json({ error: err?.message ?? 'unknown error' });
  }
});

app.post('/api/voice/tts', requireAuth, async (req, res) => {
  const { text, voice, lang } = req.body ?? {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text required' });
  }
  try {
    const result = await synthesizeSpeech(text, voice, lang);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    if (Buffer.isBuffer(result)) {
      res.end(result);
    } else if (result && typeof result.pipe === 'function') {
      result.pipe(res);
    } else if (result && typeof result.getReader === 'function') {
      const reader = result.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } else {
      const buf = Buffer.from(await new Response(result).arrayBuffer());
      res.end(buf);
    }
  } catch (err) {
    console.error('[tts error]', err);
    if (err?.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    if (err?.status === 429) {
      return res.status(429).json({
        error: 'TTS rate limit / quota hit. Browser fallback voice will be used.',
      });
    }
    res.status(500).json({ error: err?.message ?? 'tts failed' });
  }
});

app.delete('/api/memory/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'invalid id' });
  try {
    const result = await deleteMemory(id, req.user.id);
    if (!result || result.changes === 0) {
      // Return 404 (not 403) so callers can't probe for the existence of other users' memory ids.
      return res.status(404).json({ error: 'memory not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[delete memory error]', err);
    res.status(500).json({ error: err?.message ?? 'unknown error' });
  }
});

app.patch('/api/memory/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'invalid id' });
  const { fact, importance } = req.body ?? {};
  if (fact !== undefined && typeof fact !== 'string') {
    return res.status(400).json({ error: 'fact must be a string' });
  }
  if (importance !== undefined) {
    if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
      return res.status(400).json({ error: 'importance must be an integer 1–5' });
    }
  }
  try {
    const result = await updateMemory(id, { fact, importance }, req.user.id);
    if (!result || result.changes === 0) {
      return res.status(404).json({ error: 'memory not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[update memory error]', err);
    res.status(500).json({ error: err?.message ?? 'unknown error' });
  }
});

/* ===== Friends ===== */

app.get('/api/friends/:userId', requireAuth, async (req, res) => {
  if (!assertOwnsId(req, req.params.userId)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const friends = await listFriends(req.params.userId);
    res.json({
      friends,
      emailConfigured: isEmailConfigured(),
      limits: {
        maxFriends: MAX_FRIENDS_PER_USER,
        cooldownSeconds: 30,
        dailyCapPerAccount: 20,
      },
    });
  } catch (err) {
    console.error('[friends list error]', err);
    res.status(500).json({ error: err?.message ?? 'unknown error' });
  }
});

app.post('/api/friends', requireAuth, async (req, res) => {
  const { userId, email, name } = req.body ?? {};
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'userId required' });
  }
  if (!assertOwnsId(req, userId)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const trimmed = String(email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(trimmed)) {
    return res.status(400).json({ error: 'valid email required' });
  }
  try {
    const existingCount = await countFriends(userId);
    const already = (await listFriends(userId)).some((f) => f.friend_email === trimmed);
    if (!already && existingCount >= MAX_FRIENDS_PER_USER) {
      return res.status(400).json({ error: `max ${MAX_FRIENDS_PER_USER} friends` });
    }
    const friend = await addFriend({ userId, email: trimmed, name });
    res.json({ friend });
  } catch (err) {
    console.error('[friend add error]', err);
    res.status(500).json({ error: err?.message ?? 'unknown error' });
  }
});

app.delete('/api/friends/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  const userId = req.query.userId;
  if (!id) return res.status(400).json({ error: 'invalid id' });
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'userId required' });
  }
  if (!assertOwnsId(req, userId)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    await deleteFriend(id, userId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[friend delete error]', err);
    res.status(500).json({ error: err?.message ?? 'unknown error' });
  }
});

/* ===== Mood ===== */

app.get('/api/mood/:userId', requireAuth, async (req, res) => {
  if (!assertOwnsId(req, req.params.userId)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90);
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  try {
    const [counts, series] = await Promise.all([
      getEmotionCounts(req.params.userId, sinceMs),
      getEmotionSeries(req.params.userId, sinceMs),
    ]);
    res.json({ days, counts, series });
  } catch (err) {
    console.error('[mood error]', err);
    res.status(500).json({ error: err?.message ?? 'unknown error' });
  }
});

const PORT = Number(process.env.PORT) || 8787;
app.listen(PORT, () => {
  console.log(`Rio backend on :${PORT}`);
});
