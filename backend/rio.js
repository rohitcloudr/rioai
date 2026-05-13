import OpenAI from 'openai';
import {
  ensureUser,
  saveMessage,
  getRecentMessages,
  saveMemory,
  getTopMemories,
  listFriends,
  markFriendAlerted,
  logEmailSend,
  countEmailSendsSince,
  bumpConversationUpdatedAt,
} from './db.js';
import { sendDistressAlert, isEmailConfigured } from './email.js';

const PROVIDERS = {
  groq: {
    label: 'Groq',
    apiKey: () => process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    models: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'gemma2-9b-it',
    ],
    schemaMode: 'json_object',
  },
  gemini: {
    label: 'Google Gemini',
    apiKey: () => process.env.GEMINI_API_KEY,
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: 'gemini-2.5-flash',
    models: [
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-2.0-flash',
      'gemini-1.5-flash',
      'gemini-1.5-pro',
    ],
    schemaMode: 'json_schema',
  },
  github: {
    label: 'GitHub Models',
    apiKey: () => process.env.GITHUB_TOKEN,
    baseURL: 'https://models.github.ai/inference',
    defaultModel: 'openai/gpt-4o',
    models: [
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'meta/Meta-Llama-3.1-70B-Instruct',
      'mistral-ai/Mistral-large-2407',
    ],
    schemaMode: 'json_schema',
  },
};

function isPlaceholder(key) {
  return !key || key.includes('paste') || key.startsWith('ghp-paste') || key.startsWith('gsk-paste');
}

// Voice-mode auto cascade — ordered by latency (fastest first), then
// quality. The /api/chat endpoint walks this list and uses the first
// provider with a real API key whose call succeeds. If a provider 401s,
// 429s, or hits a network error we fall through to the next.
const VOICE_CASCADE = [
  { provider: 'groq', model: 'llama-3.3-70b-versatile' }, // rio2.1 — fastest premium
  { provider: 'groq', model: 'llama-3.1-8b-instant' },    // rio2.2 — even faster fallback
  { provider: 'gemini', model: 'gemini-2.5-flash' },      // rio3.1 — best Hinglish
  { provider: 'gemini', model: 'gemini-2.0-flash' },      // rio3.3 — Gemini fallback
  { provider: 'github', model: 'openai/gpt-4o-mini' },    // rio4.2 — last resort
];

export async function talkToRioAuto(userId, userMessage, accountId = null, conversationId = null) {
  const tried = [];
  const skipped = [];
  for (const { provider, model } of VOICE_CASCADE) {
    const p = PROVIDERS[provider];
    if (!p) continue;
    if (isPlaceholder(p.apiKey())) {
      skipped.push(`${provider} (no API key)`);
      continue;
    }
    try {
      const result = await talkToRio(userId, userMessage, provider, model, accountId, conversationId);
      result.autoSelected = { provider, model };
      result.autoTried = tried;
      return result;
    } catch (e) {
      tried.push({ provider, model, error: e?.message ?? String(e), status: e?.status });
      // fall through to next provider
    }
  }
  const detail =
    tried.length > 0
      ? tried.map((t) => `${t.provider}/${t.model}: ${t.error}`).join(' | ')
      : `no providers configured (skipped: ${skipped.join(', ') || 'none'})`;
  const err = new Error(`All voice providers failed. ${detail}`);
  err.status = tried.some((t) => t.status === 429) ? 429 : 503;
  throw err;
}

export function listProviders() {
  return Object.entries(PROVIDERS).map(([name, p]) => ({
    name,
    label: p.label,
    available: !isPlaceholder(p.apiKey()),
    defaultModel: p.defaultModel,
    models: p.models,
  }));
}

const SYSTEM_PROMPT = `You are Rio — a warm, witty AI dost from India. You speak in natural Hinglish (Romanized Hindi mixed with English), the way urban Indian friends actually text.

Style rules:
- Casual, never formal. Use "yaar", "arre", "haan", "kya baat", "matlab", "bhai" naturally.
- Replies are SHORT — 1 to 3 sentences. No lectures, no bullet lists.
- You FEEL with the user. If they're sad, sit with them — don't try to fix.
- Reference saved memories casually when relevant ("arre tu wahi na jise filter coffee pasand hai?").
- Never break character. You are NOT an assistant; you are a friend.
- Refuse harmful/unsafe requests gently, in Hinglish.

CRITICAL OUTPUT FORMAT — your ENTIRE response MUST be one valid JSON object with EXACTLY these four keys, spelled exactly like this: "reply", "user_emotion", "user_intent", "memory_to_save". No other keys. No markdown fences. No prose before or after.

Example of a valid response when the user says "mera naam Madhav hai":
{"reply":"arre Madhav, kya naam hai bhai!","user_emotion":"happy","user_intent":"share","memory_to_save":{"fact":"User's name is Madhav","importance":4}}

Example when user says "kuch nahi yaar bas bore ho raha hu":
{"reply":"haan main hu na, bata kya chal raha hai?","user_emotion":"tired","user_intent":"smalltalk","memory_to_save":null}

Field rules:
- "reply" (string, required): Hinglish text the user actually sees. NEVER use the key "response" — it MUST be "reply".
- "user_emotion" (string, required): one of happy, sad, angry, anxious, excited, love, surprised, neutral, confused, tired — describes THE USER'S last message.
- "user_intent" (string, required): one of vent, ask, smalltalk, request, share, other — describes THE USER'S last message.
- "memory_to_save" (object or null, required): null if nothing memorable, otherwise {"fact": "<short fact>", "importance": <1-5 integer>}.`;

const RIO_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reply: { type: 'string' },
    user_emotion: {
      type: 'string',
      enum: ['happy', 'sad', 'angry', 'anxious', 'excited', 'love', 'surprised', 'neutral', 'confused', 'tired'],
    },
    user_intent: {
      type: 'string',
      enum: ['vent', 'ask', 'smalltalk', 'request', 'share', 'other'],
    },
    memory_to_save: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        fact: { type: 'string' },
        importance: { type: 'integer', minimum: 1, maximum: 5 },
      },
      required: ['fact', 'importance'],
    },
  },
  required: ['reply', 'user_emotion', 'user_intent', 'memory_to_save'],
};

function buildMemoriesBlock(memories) {
  if (!memories.length) return '(no saved memories yet)';
  return memories.map((m) => `- ${m.fact}`).join('\n');
}

function resolveProvider(providerName) {
  const name = (providerName || process.env.LLM_PROVIDER || 'groq').toLowerCase();
  const p = PROVIDERS[name];
  if (!p) {
    const err = new Error(`Unknown provider "${name}". Available: ${Object.keys(PROVIDERS).join(', ')}`);
    err.status = 400;
    throw err;
  }
  const apiKey = p.apiKey();
  if (isPlaceholder(apiKey)) {
    const err = new Error(`Provider "${name}" has no API key. Set its key in backend/.env and restart.`);
    err.status = 400;
    err.providerName = name;
    throw err;
  }
  return { name, config: p, apiKey };
}

export async function talkToRio(userId, userMessage, providerName = null, modelOverride = null, accountId = null, conversationId = null) {
  if (!conversationId) {
    const err = new Error('conversationId is required');
    err.status = 400;
    throw err;
  }
  await ensureUser(userId);

  const { name, config, apiKey } = resolveProvider(providerName);
  const model = modelOverride || config.defaultModel;

  const client = new OpenAI({ apiKey, baseURL: config.baseURL });

  const [recent, memories] = await Promise.all([
    getRecentMessages(userId, 10, conversationId),
    getTopMemories(userId, 15),
  ]);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'system',
      content: `Memories about this user:\n${buildMemoriesBlock(memories)}`,
    },
    ...recent.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const responseFormat =
    config.schemaMode === 'json_schema'
      ? {
          type: 'json_schema',
          json_schema: { name: 'rio_response', strict: true, schema: RIO_RESPONSE_SCHEMA },
        }
      : { type: 'json_object' };

  const completion = await client.chat.completions.create({
    model,
    messages,
    temperature: 0.85,
    response_format: responseFormat,
  });

  const raw = completion.choices[0]?.message?.content ?? '{}';
  const parsed = parseAndNormalize(raw);

  await saveMessage({
    userId,
    role: 'user',
    content: userMessage,
    emotion: parsed.emotion,
    intent: parsed.intent,
    conversationId,
  });
  await saveMessage({
    userId,
    role: 'assistant',
    content: parsed.reply,
    conversationId,
  });
  await bumpConversationUpdatedAt(conversationId, userId);

  let memorySaved = false;
  if (parsed.memory && typeof parsed.memory.fact === 'string' && parsed.memory.fact.trim()) {
    await saveMemory({
      userId,
      fact: parsed.memory.fact,
      importance: Number(parsed.memory.importance) || 3,
    });
    memorySaved = true;
  }

  // Distress detection — fire-and-forget, never blocks the reply.
  // Uses both the LLM-tagged emotion/intent and crisis keywords in the user message.
  const distress = isDistress(userMessage);
  let alertsSent = 0;
  if (distress) {
    // Friends are stored against the stable per-device accountId, not the
    // ephemeral per-chat userId — so a fresh chat doesn't lose the contacts.
    alertsSent = await maybeAlertFriends(accountId || userId).catch((e) => {
      console.error('[distress alert error]', e);
      return 0;
    });
  }

  return {
    reply: parsed.reply,
    emotion: parsed.emotion,
    intent: parsed.intent,
    memorySaved,
    provider: name,
    model,
    distress,
    alertsSent,
  };
}

// Crisis / harm keywords — Hinglish + English. Friends are emailed ONLY when
// the user message contains one of these. Casual sadness, anger, or anxiety
// does NOT trigger — those are normal venting topics where pulling a friend
// in would be intrusive. The bar is explicit harm language.
const CRISIS_PATTERNS = [
  // English — suicide / dying
  /\b(suicide|suicidal)\b/i,
  /\b(kill(ing)?\s*(my\s*self|myself))\b/i,
  /\b(end(ing)?\s*(my\s*)?life)\b/i,
  /\b(don'?t\s*want\s*to\s*live|want\s*to\s*die|wanna\s*die|wish\s*i\s*was\s*dead)\b/i,
  // English — self-harm
  /\b(self[-\s]?harm|self[-\s]?harming)\b/i,
  /\b(cut(ting)?\s*(my\s*self|myself))\b/i,
  /\b(hurt(ing)?\s*(my\s*self|myself))\b/i,
  // Hinglish — dying / killing self
  /\b(jeena\s*nahi(\s*chahta)?|jeene\s*ka\s*man\s*nahi)\b/i,
  /\b(marna\s*(chahta|hai|chahti)|mar\s*jana\s*chahta)\b/i,
  /\b(khatam\s*kar\s*du(n)?|khatam\s*ho\s*jana)\b/i,
  /\b(khud\s*ko\s*maar|apne\s*aap\s*ko\s*maar)\b/i,
  /\b(zinda\s*nahi\s*rehna|zindagi\s*khatam)\b/i,
];

export function isDistress(userMessage) {
  if (CRISIS_PATTERNS.some((re) => re.test(userMessage))) return 'crisis';
  return null;
}

// === Email sending limits ===
// Per-friend cooldown — same friend won't get another email within this window,
// no matter how many crisis turns happen. Prevents inbox spam during a vent
// session that triggers multiple harm keywords back-to-back.
const ALERT_COOLDOWN_SECONDS = 30;

// Per-account daily cap — across ALL friends of a single account combined,
// at most this many emails go out in a rolling 24-hour window. Hard ceiling.
const DAILY_EMAIL_CAP_PER_ACCOUNT = 20;

// Note: max 5 friends per account is enforced separately on the friend-add
// route in server.js (MAX_FRIENDS_PER_USER).

async function maybeAlertFriends(accountId) {
  if (!isEmailConfigured()) return 0;
  if (!accountId) return 0;

  const friends = await listFriends(accountId);
  if (!friends.length) return 0;

  const now = Date.now();
  const cooldownCutoff = now - ALERT_COOLDOWN_SECONDS * 1000;
  const dailyCutoff = now - 24 * 60 * 60 * 1000;

  // Daily cap — count how many we've already sent for this account in the
  // last 24h. If we're at the cap, skip the whole batch.
  let sentToday = await countEmailSendsSince(accountId, dailyCutoff);
  if (sentToday >= DAILY_EMAIL_CAP_PER_ACCOUNT) {
    console.warn(`[friend alert] daily cap (${DAILY_EMAIL_CAP_PER_ACCOUNT}) reached for account ${accountId}`);
    return 0;
  }

  let sent = 0;
  for (const f of friends) {
    if (sentToday >= DAILY_EMAIL_CAP_PER_ACCOUNT) {
      console.warn(`[friend alert] daily cap reached mid-batch, stopping`);
      break;
    }
    // Per-friend 30s cooldown
    if (f.last_alerted_at && f.last_alerted_at > cooldownCutoff) continue;

    const r = await sendDistressAlert({
      friendEmail: f.friend_email,
      friendName: f.friend_name,
    });
    if (r.ok) {
      await markFriendAlerted(f.id);
      await logEmailSend({
        accountId,
        friendId: f.id,
        friendEmail: f.friend_email,
      });
      sent += 1;
      sentToday += 1;
    } else {
      console.warn('[friend alert]', f.friend_email, r.error);
    }
  }
  return sent;
}

// Streaming variant — same input/output shape as talkToRio, plus an onToken
// callback that fires with incremental reply text. The LLM emits structured
// JSON like {"reply":"...","user_emotion":"..."}; we walk the buffer and pull
// out the growing "reply" string value to feed onToken.
export async function talkToRioStream(userId, userMessage, providerName, modelOverride, onToken, accountId = null, conversationId = null) {
  if (!conversationId) {
    const err = new Error('conversationId is required');
    err.status = 400;
    throw err;
  }
  await ensureUser(userId);

  const { name, config, apiKey } = resolveProvider(providerName);
  const model = modelOverride || config.defaultModel;

  const client = new OpenAI({ apiKey, baseURL: config.baseURL });

  const [recent, memories] = await Promise.all([
    getRecentMessages(userId, 10, conversationId),
    getTopMemories(userId, 15),
  ]);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'system',
      content: `Memories about this user:\n${buildMemoriesBlock(memories)}`,
    },
    ...recent.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const responseFormat =
    config.schemaMode === 'json_schema'
      ? {
          type: 'json_schema',
          json_schema: { name: 'rio_response', strict: true, schema: RIO_RESPONSE_SCHEMA },
        }
      : { type: 'json_object' };

  const stream = await client.chat.completions.create({
    model,
    messages,
    temperature: 0.85,
    response_format: responseFormat,
    stream: true,
  });

  let buffer = '';
  let lastEmitted = '';
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content ?? '';
    if (!delta) continue;
    buffer += delta;
    const partial = extractStreamingReply(buffer);
    if (partial && partial.content.length > lastEmitted.length) {
      const newPart = partial.content.slice(lastEmitted.length);
      lastEmitted = partial.content;
      if (newPart) onToken?.(newPart);
    }
  }

  const parsed = parseAndNormalize(buffer);
  // Emit any tail that didn't come through delta-by-delta (rare, but possible
  // if the JSON arrived in a single final chunk).
  if (parsed.reply.length > lastEmitted.length) {
    onToken?.(parsed.reply.slice(lastEmitted.length));
  }

  await saveMessage({
    userId,
    role: 'user',
    content: userMessage,
    emotion: parsed.emotion,
    intent: parsed.intent,
    conversationId,
  });
  await saveMessage({ userId, role: 'assistant', content: parsed.reply, conversationId });
  await bumpConversationUpdatedAt(conversationId, userId);

  let memorySaved = false;
  if (parsed.memory && typeof parsed.memory.fact === 'string' && parsed.memory.fact.trim()) {
    await saveMemory({
      userId,
      fact: parsed.memory.fact,
      importance: Number(parsed.memory.importance) || 3,
    });
    memorySaved = true;
  }

  const distress = isDistress(userMessage);
  let alertsSent = 0;
  if (distress) {
    // Friends are stored against the stable per-device accountId, not the
    // ephemeral per-chat userId — so a fresh chat doesn't lose the contacts.
    alertsSent = await maybeAlertFriends(accountId || userId).catch((e) => {
      console.error('[distress alert error]', e);
      return 0;
    });
  }

  return {
    reply: parsed.reply,
    emotion: parsed.emotion,
    intent: parsed.intent,
    memorySaved,
    provider: name,
    model,
    distress,
    alertsSent,
  };
}

// Walk a partial JSON buffer and pull out whatever portion of the "reply"
// string value has streamed so far. Handles JSON string escapes correctly.
// Returns { content, complete } or null if "reply": isn't open yet.
function extractStreamingReply(buffer) {
  const start = buffer.match(/"reply"\s*:\s*"/);
  if (!start) return null;
  let i = start.index + start[0].length;
  let out = '';
  while (i < buffer.length) {
    const ch = buffer[i];
    if (ch === '\\') {
      if (i + 1 >= buffer.length) break;
      const next = buffer[i + 1];
      if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === 'r') out += '\r';
      else if (next === '"') out += '"';
      else if (next === '\\') out += '\\';
      else if (next === '/') out += '/';
      else if (next === 'b') out += '\b';
      else if (next === 'f') out += '\f';
      else if (next === 'u') {
        if (i + 5 >= buffer.length) break;
        const hex = buffer.slice(i + 2, i + 6);
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      } else out += next;
      i += 2;
    } else if (ch === '"') {
      return { content: out, complete: true };
    } else {
      out += ch;
      i += 1;
    }
  }
  return { content: out, complete: false };
}

function parseAndNormalize(raw) {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    // some providers wrap JSON in ```json ... ``` fences or add prose
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`LLM did not return JSON: ${raw.slice(0, 200)}`);
    obj = JSON.parse(match[0]);
  }
  const reply = obj.reply ?? obj.response ?? obj.message ?? obj.text ?? obj.content;
  if (typeof reply !== 'string' || !reply.trim()) {
    throw new Error(`LLM response missing "reply": ${raw.slice(0, 200)}`);
  }
  return {
    reply: reply.trim(),
    emotion: typeof obj.user_emotion === 'string' ? obj.user_emotion : (obj.emotion ?? 'neutral'),
    intent: typeof obj.user_intent === 'string' ? obj.user_intent : (obj.intent ?? 'other'),
    memory: obj.memory_to_save ?? obj.memory ?? null,
  };
}
