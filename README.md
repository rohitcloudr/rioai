# Rio — AI Dost (Hinglish Chatbot)

A web chatbot inspired by [rio.ai](https://rio.ai). Chats in Hinglish, detects emotion + intent, and remembers facts about you across conversations.

**Stack:** React (Vite) + Node.js (Express) + local SQLite (`node:sqlite`) + Groq / Gemini / GitHub Models / OpenAI (switchable via env or the in-app model picker).

---

## Setup

You need **Node.js 24+** (uses the built-in `node:sqlite` module — no native compile required).

```bash
# 1. Install backend
cd backend
npm install
cp .env.example .env
# edit .env: paste at least one LLM API key

# 2. Install frontend (new terminal)
cd frontend
npm install
```

## Run

Two terminals:

```bash
# terminal 1 — backend
cd backend
npm run dev          # or: node server.js
# → "[db] using sqlite backend"
# → "Rio backend on :8787"

# terminal 2 — frontend
cd frontend
npm run dev
# → http://localhost:5173
```

Open http://localhost:5173 and start chatting.

---

## Database — local SQLite

Rio uses **SQLite** via Node 24+'s built-in `node:sqlite` module — no native compile, no third-party install, no keys, no quotas.

The database file lives at `backend/data/rio.db`. It's created automatically on first run, along with the schema (`users`, `messages`, `memories`) and indexes. The directory is gitignored.

To reset the database, just delete the file:

```bash
rm backend/data/rio.db
```

The next chat turn will create it again from scratch.

> If you later need cloud sync or multi-machine access, the natural upgrade is **Neon** (Postgres) — same SQL shape, single `DATABASE_URL` env var, free tier with no IP whitelisting. Until then, local SQLite has the lowest possible operational footprint.

---

## Switching LLM providers

All LLM providers (Groq, Gemini, GitHub Models, OpenAI) speak the same OpenAI-compatible API, so swapping is just env config — no code changes.

In `backend/.env`:

```ini
# default provider when frontend doesn't specify one
LLM_PROVIDER=groq            # groq | gemini | github | openai

OPENAI_API_KEY=sk-...
GROQ_API_KEY=gsk-...
GEMINI_API_KEY=...
GITHUB_TOKEN=ghp-...
```

The frontend's model picker lets you switch between any provider whose key is configured, per turn.

Get a Groq key at **https://console.groq.com** → API Keys (free tier, generous limits). Models include:
- `llama-3.3-70b-versatile` (default — best quality)
- `llama-3.1-8b-instant` (fastest, cheapest)

Restart the backend after changing `.env`.

## How it works

1. You type a message → frontend POSTs to `/api/chat` with your `userId` (auto-generated, saved in `localStorage`).
2. Backend pulls last 10 messages + top 15 saved memories from SQLite.
3. One LLM call returns structured JSON: `{ reply, user_emotion, user_intent, memory_to_save }`.
4. User message + Rio's reply + new memory (if any) are saved to SQLite.
5. Frontend renders Rio's reply and an emotion chip on your message.

The "Memories" sidebar shows what Rio has chosen to remember. Click × to forget.

## API

| Method | Path | Body / Returns |
|---|---|---|
| `POST` | `/api/chat` | `{userId, message}` → `{reply, emotion, intent, memorySaved}` |
| `GET` | `/api/conversation/:userId` | last 50 messages |
| `GET` | `/api/memory/:userId` | all memories for user |
| `DELETE` | `/api/memory/:id` | delete one memory |
| `POST` | `/api/voice/tts` | `{text, voice?, lang?}` → `audio/mpeg` |
| `GET` | `/api/providers` | list configured LLM providers |
| `GET` | `/api/health` | `{ok: true}` |

## Files

```
backend/
  server.js     — Express routes
  rio.js        — LLM orchestration, system prompt, JSON shape
  voice.js      — TTS (Edge → Google → OpenAI fallback chain)
  db.js         — re-exports the SQLite driver
  db.sqlite.js  — local SQLite implementation (node:sqlite)
  data/rio.db   — auto-created SQLite file (gitignored)
frontend/
  src/App.jsx                — chat UI + theme + model picker
  src/App.css                — light/dark theme styles
  src/ModelPickerPopover.jsx — provider/model picker popover (header + in-call)
  src/modelMeta.js           — model aliases, descriptions, taglines
  src/voice/CallOverlay.jsx  — voice-call modal
  src/voice/useVoiceCall.js  — STT loop, silence detection, TTS playback
```

## Not included (yet)

- Streaming token responses
- Authentication / multi-device sync (today: localStorage user ID only)
- Multiple chat threads on the server side
