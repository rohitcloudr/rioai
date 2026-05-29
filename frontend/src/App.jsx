import { useEffect, useMemo, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CallOverlay from './voice/CallOverlay.jsx';
import ModelPickerPopover from './ModelPickerPopover.jsx';
import FriendsModal from './FriendsModal.jsx';
import MoodDashboard from './MoodDashboard.jsx';
import Login from './Login.jsx';
import { rioAlias } from './modelMeta.js';
import { apiUrl } from './api.js';

function loadAuth() {
  try {
    const raw = sessionStorage.getItem('rioAuth');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveAuth(auth) {
  if (auth) sessionStorage.setItem('rioAuth', JSON.stringify(auth));
  else sessionStorage.removeItem('rioAuth');
}

// fetch wrapper that injects the bearer token and clears the session on 401.
function makeAuthedFetch(token) {
  return async (url, opts = {}) => {
    const headers = new Headers(opts.headers || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const res = await fetch(apiUrl(url), { ...opts, headers });
    if (res.status === 401) {
      saveAuth(null);
      window.location.reload();
    }
    return res;
  };
}

const EMOTION_EMOJI = {
  happy: '😊',
  sad: '😔',
  angry: '😠',
  anxious: '😟',
  excited: '🤩',
  love: '🥰',
  surprised: '😮',
  neutral: '🙂',
  confused: '😕',
  tired: '😴',
};

const SAMPLE_PROMPTS = [
  'arre yaar kya scene hai?',
  'mujhe aaj kuch motivation chahiye',
  'mera fav drink filter coffee hai',
  'thoda Pune ke baare me bata',
];

function getUserId() {
  let id = localStorage.getItem('rioUserId');
  if (!id) {
    id = nanoid();
    localStorage.setItem('rioUserId', id);
  }
  return id;
}

// Stable per-device id used for things that should survive across "new chat",
// most importantly the trusted-friends list. Kept separate from the per-chat
// userId so each new chat doesn't reset the friends list.
function getAccountId() {
  let id = localStorage.getItem('rioAccountId');
  if (!id) {
    id = nanoid();
    localStorage.setItem('rioAccountId', id);
  }
  return id;
}

function timeAgo(t) {
  if (!t) return '';
  const diff = Date.now() - t;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  if (days < 7) return days + 'd ago';
  return new Date(t).toLocaleDateString();
}

function loadModelChoice() {
  try {
    const raw = localStorage.getItem('rioModelChoice');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function loadVoiceChoice() {
  try {
    const raw = localStorage.getItem('rioVoiceChoice');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function safeJson(r) {
  const text = await r.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const THEMES = ['earth', 'coastal'];
function loadInitialTheme() {
  const saved = localStorage.getItem('rioTheme');
  if (THEMES.includes(saved)) return saved;
  return 'earth';
}

export default function App() {
  const [auth, setAuth] = useState(loadAuth);

  if (!auth) {
    return (
      <Login
        onAuthed={(a) => {
          saveAuth(a);
          setAuth(a);
        }}
      />
    );
  }

  return <ChatApp auth={auth} onLogout={() => { saveAuth(null); setAuth(null); }} />;
}

function ChatApp({ auth, onLogout }) {
  const authedFetch = useMemo(() => makeAuthedFetch(auth.token), [auth.token]);
  // Post-login, the email-bound user.id from the server is the durable id used
  // for every backend call. We keep this in state for symmetry with the rest of
  // the code, but it never changes within a session.
  const [userId, setUserId] = useState(auth.userId);
  const accountId = auth.userId;
  const [messages, setMessages] = useState([]);
  const [memories, setMemories] = useState([]);
  const [providers, setProviders] = useState([]);
  const [choice, setChoice] = useState(loadModelChoice);
  const [voiceChoice, setVoiceChoice] = useState(loadVoiceChoice);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [theme, setTheme] = useState(loadInitialTheme);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [inCall, setInCall] = useState(false);
  const [moodOpen, setMoodOpen] = useState(false);
  const [friendsOpen, setFriendsOpen] = useState(false);
  const [friendsCount, setFriendsCount] = useState(0);
  const [alertBanner, setAlertBanner] = useState(null);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);

  // theme
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('rioTheme', theme);
  }, [theme]);

  // friends count badge (shared across chats — driven by accountId)
  const refreshFriendsCount = () => {
    authedFetch(`/api/friends/${accountId}`)
      .then(safeJson)
      .then((d) => setFriendsCount(d?.friends?.length ?? 0))
      .catch(() => {});
  };
  useEffect(() => {
    refreshFriendsCount();
  }, [accountId, friendsOpen]);

  // initial load — fetch conversations, pick (or create) the active one,
  // then load its messages. Also fetch providers in parallel.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await authedFetch(`/api/conversations/${userId}`);
        const d = await safeJson(r);
        let list = Array.isArray(d?.conversations) ? d.conversations : [];
        if (cancelled) return;
        if (list.length === 0) {
          // First-time user — mint a starter conversation.
          const created = await authedFetch('/api/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, title: 'New chat' }),
          }).then(safeJson);
          if (cancelled) return;
          if (created?.conversation) list = [created.conversation];
        }
        if (list.length === 0) return; // creation failed; bail quietly
        setConversations(list);
        const activeId = list[0].id;
        setConversationId(activeId);
        const convRes = await authedFetch(
          `/api/conversation/${userId}?conversationId=${activeId}`
        ).then(safeJson);
        if (cancelled) return;
        setMessages(convRes?.messages ?? []);
      } catch {
        // Network errors will surface when the user tries to send.
      }
    })();

    refreshMemories();

    fetch(apiUrl('/api/providers'))
      .then(safeJson)
      .then((d) => {
        if (cancelled) return;
        const list = (d?.providers ?? []).filter((p) => p.available);
        setProviders(list);
        // No auto-default. choice stays null on first load; user must pick.
        // If a saved choice points to a model whose key is no longer set,
        // drop it back to null.
        setChoice((cur) => {
          if (!cur) return null;
          const stillAvail = list.find((p) => p.name === cur.provider && p.models.includes(cur.model));
          return stillAvail ? cur : null;
        });
        setVoiceChoice((cur) => {
          if (!cur) return null;
          const stillAvail = list.find((p) => p.name === cur.provider && p.models.includes(cur.model));
          return stillAvail ? cur : null;
        });
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [userId]);

  useEffect(() => {
    if (choice) localStorage.setItem('rioModelChoice', JSON.stringify(choice));
    else localStorage.removeItem('rioModelChoice');
  }, [choice]);

  useEffect(() => {
    if (voiceChoice) localStorage.setItem('rioVoiceChoice', JSON.stringify(voiceChoice));
    else localStorage.removeItem('rioVoiceChoice');
  }, [voiceChoice]);

  async function refreshConversations() {
    try {
      const r = await authedFetch(`/api/conversations/${userId}`);
      const d = await safeJson(r);
      const list = Array.isArray(d?.conversations) ? d.conversations : [];
      setConversations(list);
    } catch {}
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading]);

  // auto-grow textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }, [input]);

  const modelOptions = useMemo(() => {
    return providers.flatMap((p) =>
      p.models.map((m) => ({
        value: `${p.name}::${m}`,
        provider: p.name,
        providerLabel: p.label,
        model: m,
        label: rioAlias(m),
      }))
    );
  }, [providers]);

  async function refreshMemories() {
    try {
      const r = await authedFetch(`/api/memory/${userId}`);
      const d = await safeJson(r);
      setMemories(d?.memories ?? []);
    } catch {}
  }

  async function sendStreamed(text, body, turnIds) {
    // SSE-based streaming. Each `event: token` arrives as it's produced;
    // the final `event: done` carries emotion/intent/model/distress.
    const userMsg = { role: 'user', content: text, id: turnIds.user };
    const assistantId = turnIds.assistant;
    setMessages((prev) => [...prev, userMsg, { role: 'assistant', content: '', id: assistantId, streaming: true }]);

    let response;
    try {
      response = await authedFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, stream: true }),
      });
    } catch {
      throw new Error('Cannot reach Rio backend. Make sure the server is running on port 8787.');
    }
    if (!response.ok || !response.body) {
      const data = await safeJson(response).catch(() => null);
      throw new Error(data?.error ?? `Server error (${response.status}).`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalEvent = null;
    let errorEvent = null;
    let acc = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events end with "\n\n"
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const ev = parseSseEvent(raw);
        if (!ev) continue;
        if (ev.event === 'token') {
          acc += ev.data.token ?? '';
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: acc } : m))
          );
        } else if (ev.event === 'done') {
          finalEvent = ev.data;
        } else if (ev.event === 'error') {
          errorEvent = ev.data;
        }
      }
    }

    if (errorEvent) {
      throw new Error(errorEvent.error ?? 'stream error');
    }
    if (!finalEvent) {
      throw new Error('Stream ended without a done event.');
    }

    setMessages((prev) =>
      prev.map((m) => {
        if (m.id === userMsg.id) return { ...m, emotion: finalEvent.emotion, intent: finalEvent.intent };
        if (m.id === assistantId) return {
          ...m,
          content: finalEvent.reply ?? acc,
          model: finalEvent.model,
          streaming: false,
        };
        return m;
      })
    );
    return finalEvent;
  }

  async function send(textOverride, opts = {}) {
    const text = (textOverride ?? input).trim();
    if (!text || loading) return;
    if (!conversationId) {
      setError('Setting up your chat… try again in a moment.');
      return;
    }
    setError(null);
    if (!textOverride) setInput('');

    setLoading(true);

    const isFirstMessage = messages.length === 0;
    const body = { userId, accountId, conversationId, message: text };
    if (opts.voiceMode) {
      body.mode = 'voice';
      if (voiceChoice) {
        body.provider = voiceChoice.provider;
        body.model = voiceChoice.model;
      }
    } else if (choice) {
      body.provider = choice.provider;
      body.model = choice.model;
    }

    // Streaming is only used for non-voice text turns with a pinned model.
    // Voice mode uses the auto-cascade non-streaming path so failures can fall
    // through to the next provider.
    const canStream = !opts.voiceMode && !!choice;
    const turnId = Date.now();
    const turnIds = { user: `tmp-${turnId}`, assistant: `asst-${turnId}` };

    try {
      if (canStream) {
        const final = await sendStreamed(text, body, turnIds);
        if (final?.memorySaved) refreshMemories();
        if (final?.alertsSent > 0) {
          setAlertBanner(`Pinged ${final.alertsSent} friend${final.alertsSent === 1 ? '' : 's'} to check in.`);
        }
        if (isFirstMessage) {
          maybeAutoTitleConversation(conversationId, text);
        } else {
          refreshConversations();
        }
        return final?.reply;
      }

      // Non-streaming path
      const userMsg = { role: 'user', content: text, id: turnIds.user };
      setMessages((prev) => [...prev, userMsg]);
      let r;
      try {
        r = await authedFetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        throw new Error('Cannot reach Rio backend. Make sure the server is running on port 8787.');
      }
      const data = await safeJson(r);
      if (!r.ok) {
        throw new Error(data?.error ?? `Server error (${r.status}). Try again or pick a different model.`);
      }
      if (!data || typeof data.reply !== 'string') {
        throw new Error('Got an empty response from Rio. Try again.');
      }

      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last && last.id === userMsg.id) {
          updated[updated.length - 1] = { ...last, emotion: data.emotion, intent: data.intent };
        }
        return [...updated, { role: 'assistant', content: data.reply, model: data.model }];
      });
      if (data.memorySaved) refreshMemories();
      if (data.alertsSent > 0) {
        setAlertBanner(`Pinged ${data.alertsSent} friend${data.alertsSent === 1 ? '' : 's'} to check in.`);
      }
      // Auto-title the conversation from the user's first message.
      if (isFirstMessage) {
        maybeAutoTitleConversation(conversationId, text);
      } else {
        refreshConversations();
      }
      return data.reply;
    } catch (e) {
      setError(e.message);
      // Roll back ONLY this turn's optimistic messages.
      setMessages((prev) => prev.filter((m) => m.id !== turnIds.user && m.id !== turnIds.assistant));
      if (!textOverride) setInput(text);
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function maybeAutoTitleConversation(id, firstMessage) {
    const title = (firstMessage || '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat';
    try {
      await authedFetch(`/api/conversations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
    } catch {}
    refreshConversations();
  }

  async function deleteMemory(id) {
    await authedFetch(`/api/memory/${id}`, { method: 'DELETE' });
    setMemories((prev) => prev.filter((m) => m.id !== id));
  }

  async function patchMemory(id, patch) {
    setMemories((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
    try {
      await authedFetch(`/api/memory/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
    } catch {
      refreshMemories();
    }
  }

  async function newChat() {
    setError(null);
    setDrawerOpen(false);
    try {
      const r = await authedFetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, title: 'New chat' }),
      });
      const d = await safeJson(r);
      if (!r.ok || !d?.conversation) {
        throw new Error(d?.error || `Could not create chat (${r.status}).`);
      }
      setConversations((prev) => [d.conversation, ...prev]);
      setConversationId(d.conversation.id);
      setMessages([]);
    } catch (e) {
      setError(e.message || 'Could not start a new chat.');
    }
  }

  // Local-only — wipes the on-screen messages but keeps the conversation row
  // and its history on the server. Useful if the screen feels cluttered.
  function clearChat() {
    if (!confirm('Clear the current chat from view?')) return;
    setMessages([]);
    setError(null);
  }

  async function loadSession(id) {
    setDrawerOpen(false);
    if (id === conversationId) return;
    setError(null);
    setConversationId(id);
    setMessages([]);
    try {
      const r = await authedFetch(`/api/conversation/${userId}?conversationId=${id}`);
      const d = await safeJson(r);
      if (!r.ok) {
        throw new Error(d?.error || `Could not load chat (${r.status}).`);
      }
      setMessages(d?.messages ?? []);
    } catch (e) {
      setError(e.message || 'Could not load that chat.');
    }
  }

  async function deleteSession(id, e) {
    e?.stopPropagation();
    if (!confirm('Delete this chat and its history?')) return;
    try {
      const r = await authedFetch(`/api/conversations/${id}`, { method: 'DELETE' });
      if (!r.ok) {
        const d = await safeJson(r);
        throw new Error(d?.error || `Could not delete chat (${r.status}).`);
      }
      const remaining = conversations.filter((c) => c.id !== id);
      setConversations(remaining);
      if (id === conversationId) {
        // If we just deleted the active chat, switch to another one or mint a fresh one.
        if (remaining.length > 0) {
          await loadSession(remaining[0].id);
        } else {
          await newChat();
        }
      }
    } catch (err) {
      setError(err.message || 'Could not delete that chat.');
    }
  }

  async function signOut() {
    try {
      await authedFetch('/api/auth/logout', { method: 'POST' });
    } catch {}
    onLogout();
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function editMessage(text) {
    setInput(text);
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      requestAnimationFrame(() => {
        ta.setSelectionRange(text.length, text.length);
        ta.scrollTop = ta.scrollHeight;
      });
    }
  }

  const noProviders = modelOptions.length === 0;

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <RioLogo />
          <h1>Rio</h1>
          <span className="brand-sub">your AI dost</span>
        </div>

        <div className="header-controls">
          <div className="model-picker">
            {noProviders ? (
              <span className="muted">No providers configured</span>
            ) : (
              <ModelPickerPopover
                value={choice}
                onChange={(next) => setChoice(next)}
                modelOptions={modelOptions}
                variant="light"
              />
            )}
          </div>

          <button
            className="icon-btn friends-btn"
            onClick={() => setFriendsOpen(true)}
            title="Trusted friends — saved across all chats"
            aria-label="Trusted friends"
          >
            <UsersIcon />
            {friendsCount > 0 && <span className="badge">{friendsCount}</span>}
          </button>

          <button
            className="icon-btn"
            onClick={() => setMoodOpen(true)}
            title="Mood tracker"
            aria-label="Mood tracker"
          >
            <ChartIcon />
          </button>

          <button
            className="icon-btn call-btn"
            onClick={() => setInCall(true)}
            title="Call Rio (voice mode)"
            aria-label="Start voice call"
          >
            <PhoneIcon />
          </button>

          <button
            className="icon-btn"
            onClick={clearChat}
            title="Clear current chat"
            aria-label="Clear chat"
          >
            <TrashIcon />
          </button>

          <button
            className="icon-btn theme-btn"
            onClick={() => setTheme((t) => (t === 'earth' ? 'coastal' : 'earth'))}
            title={theme === 'earth' ? 'Switch to Coastal palette' : 'Switch to Earth palette'}
            aria-label="Switch palette"
          >
            {theme === 'earth' ? <WaveIcon /> : <LeafIcon />}
          </button>

          <button
            className="icon-btn"
            onClick={signOut}
            title={`Sign out (${auth.email || 'signed in'})`}
            aria-label="Sign out"
          >
            <LogoutIcon />
          </button>

        </div>
      </header>

      {alertBanner && (
        <div className="alert-banner">
          <span>{alertBanner}</span>
          <button onClick={() => setAlertBanner(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      <div className="layout">
        <main className="chat">
          <div className="chat-scroll" ref={scrollRef}>
            {messages.length === 0 && !loading ? (
              <div className="empty">
                <div className="empty-emoji">👋</div>
                <h3>arre, hi!</h3>
                <p>main Rio hu — tera AI dost. kuch bhi bol, main sun rahi hu.</p>
                <div className="empty-prompts">
                  {SAMPLE_PROMPTS.map((p) => (
                    <button key={p} onClick={() => send(p)}>
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m, i) => <Bubble key={m.id ?? i} msg={m} onEdit={editMessage} />)
            )}
            {loading && messages[messages.length - 1]?.role !== 'assistant' && <TypingDots />}
          </div>

          <div className="composer">
            {error && <div className="error">⚠ {error}</div>}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={inCall ? 'on call with Rio…' : 'kuch likh… (Enter to send, Shift+Enter for newline)'}
              rows={1}
              disabled={loading || noProviders || inCall}
            />
            <button
              className="send-btn"
              onClick={() => send()}
              disabled={loading || !input.trim() || noProviders || inCall}
              aria-label="Send"
              title="Send"
            >
              <SendIcon />
            </button>
          </div>
        </main>

        {drawerOpen && <div className="backdrop" onClick={() => setDrawerOpen(false)} />}
        <aside className={`sidebar ${drawerOpen ? 'open' : ''}`}>
          <button
            className="sidebar-close icon-btn"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close sidebar"
          >
            ×
          </button>

          <button className="new-chat-btn" onClick={newChat} title="Start a new chat">
            <NewChatIcon />
            <span>New chat</span>
          </button>

          <div className="sidebar-section">
            <div className="sidebar-head">
              <h2>Chat history</h2>
              {conversations.length > 0 && <span className="count">{conversations.length}</span>}
            </div>
            {conversations.length === 0 ? (
              <p className="muted">Your past chats will appear here.</p>
            ) : (
              <ul className="history">
                {conversations.map((c) => (
                  <li
                    key={c.id}
                    className={`history-item ${c.id === conversationId ? 'active' : ''}`}
                    onClick={() => loadSession(c.id)}
                  >
                    <div className="history-text">
                      <span className="history-title">{c.title}</span>
                      <span className="history-meta">
                        {timeAgo(c.updated_at)} · {c.msg_count} msg
                      </span>
                    </div>
                    <button
                      className="del"
                      onClick={(e) => deleteSession(c.id, e)}
                      title="Delete chat"
                      aria-label="Delete chat"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="sidebar-section">
            <div className="sidebar-head">
              <h2>Memories</h2>
              <span className="count">{memories.length}</span>
            </div>
            {memories.length === 0 ? (
              <p className="muted">Rio remembers important things you share — names, preferences, life events. They'll show up here.</p>
            ) : (
              <ul className="memories">
                {memories.map((m) => (
                  <MemoryItem
                    key={m.id}
                    memory={m}
                    onDelete={() => deleteMemory(m.id)}
                    onPatch={(patch) => patchMemory(m.id, patch)}
                  />
                ))}
              </ul>
            )}
          </div>

        </aside>
      </div>

      <CallOverlay
        isOpen={inCall}
        onClose={() => setInCall(false)}
        onTurn={(text) => send(text, { voiceMode: true })}
        modelOptions={modelOptions}
        voiceChoice={voiceChoice}
        onVoiceChoiceChange={setVoiceChoice}
        authedFetch={authedFetch}
      />

      <MoodDashboard
        isOpen={moodOpen}
        onClose={() => setMoodOpen(false)}
        userId={userId}
        authedFetch={authedFetch}
      />

      <FriendsModal
        isOpen={friendsOpen}
        onClose={() => setFriendsOpen(false)}
        accountId={accountId}
        authedFetch={authedFetch}
      />
    </div>
  );
}

function parseSseEvent(raw) {
  const lines = raw.split('\n');
  let event = 'message';
  let data = '';
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

function MemoryItem({ memory, onDelete, onPatch }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memory.fact);

  function save() {
    const next = draft.trim();
    if (next && next !== memory.fact) onPatch({ fact: next });
    setEditing(false);
  }

  function bumpImportance(stars) {
    if (stars !== memory.importance) onPatch({ importance: stars });
  }

  return (
    <li>
      {editing ? (
        <input
          className="memory-edit"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') {
              setDraft(memory.fact);
              setEditing(false);
            }
          }}
        />
      ) : (
        <span
          className="memory-fact"
          onDoubleClick={() => setEditing(true)}
          title="Double-click to edit"
        >
          {memory.fact}
        </span>
      )}
      <span className="memory-meta">
        <span className="importance importance-clickable">
          {[1, 2, 3, 4, 5].map((n) => (
            <span
              key={n}
              role="button"
              aria-label={`Set importance ${n}`}
              onClick={() => bumpImportance(n)}
              className={n <= memory.importance ? 'star-on' : 'star-off'}
            >
              ★
            </span>
          ))}
        </span>
        <button
          className="del"
          onClick={() => setEditing((v) => !v)}
          title={editing ? 'Done' : 'Edit'}
          aria-label="Edit memory"
        >
          {editing ? '✓' : '✎'}
        </button>
        <button className="del" onClick={onDelete} title="Forget this">
          ×
        </button>
      </span>
    </li>
  );
}

function Bubble({ msg, onEdit }) {
  const isUser = msg.role === 'user';
  const emoji = msg.emotion ? EMOTION_EMOJI[msg.emotion] ?? '' : '';
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(msg.content);
      } else {
        const ta = document.createElement('textarea');
        ta.value = msg.content;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  return (
    <div className={`row ${isUser ? 'row-user' : 'row-rio'}`}>
      <div className={`bubble ${isUser ? 'bubble-user' : 'bubble-rio'}${msg.streaming ? ' bubble-streaming' : ''}`}>
        {isUser ? (
          msg.content
        ) : (
          <>
            <ReactMarkdown remarkPlugins={[remarkGfm]} className="md">
              {msg.content || ''}
            </ReactMarkdown>
            {msg.streaming && <span className="stream-caret" />}
          </>
        )}
      </div>
      {isUser && (
        <div className="msg-actions">
          <button
            type="button"
            onClick={() => onEdit?.(msg.content)}
            title="Edit"
            aria-label="Edit message"
          >
            <EditIcon />
          </button>
          <button
            type="button"
            onClick={copy}
            title={copied ? 'Copied!' : 'Copy'}
            aria-label="Copy message"
            className={copied ? 'copied' : ''}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
      )}
      {isUser && msg.emotion && (
        <div className="chip">
          {emoji} {msg.emotion}
          {msg.intent && <span className="chip-sep"> · {msg.intent}</span>}
        </div>
      )}
      {!isUser && msg.model && <div className="chip chip-model">{rioAlias(msg.model)}</div>}
    </div>
  );
}

function TypingDots() {
  return (
    <div className="row row-rio">
      <div className="bubble bubble-rio typing">
        <span /><span /><span />
      </div>
    </div>
  );
}

/* ============== ICONS ============== */
function RioLogo() {
  // Balance mark — yin-yang inside a soft halo.
  // Speaks to calm / mind / equilibrium, matching the project's wellness intent.
  // Mathematical SVG (only circles + arcs) so it renders precisely at every size.
  // Colors come from --logo-fg / --logo-bg so the mark retints per palette.
  return (
    <svg
      className="brand-logo"
      viewBox="0 0 100 100"
      width="40"
      height="40"
      aria-label="Rio logo"
      role="img"
    >
      {/* outer halo ring */}
      <circle cx="50" cy="50" r="48" fill="none" stroke="var(--logo-fg)" strokeWidth="1" opacity="0.18" />
      <circle cx="50" cy="50" r="44" fill="none" stroke="var(--logo-fg)" strokeWidth="0.6" opacity="0.10" />

      {/* yin-yang body — light side */}
      <circle cx="50" cy="50" r="38" fill="var(--logo-bg)" />

      {/* yin-yang body — dark S-half (right + bottom-left lobe) */}
      <path
        d="M 50 12 A 38 38 0 0 1 50 88 A 19 19 0 0 0 50 50 A 19 19 0 0 1 50 12 Z"
        fill="var(--logo-fg)"
      />

      {/* light dot inside the dark lobe */}
      <circle cx="50" cy="69" r="5" fill="var(--logo-bg)" />
      {/* dark dot inside the light lobe */}
      <circle cx="50" cy="31" r="5" fill="var(--logo-fg)" />

      {/* four cardinal aura ticks for a subtle meditative feel */}
      <circle cx="50" cy="3.5" r="1.4" fill="var(--logo-fg)" opacity="0.55" />
      <circle cx="50" cy="96.5" r="1.4" fill="var(--logo-fg)" opacity="0.55" />
      <circle cx="3.5" cy="50" r="1.1" fill="var(--logo-fg)" opacity="0.35" />
      <circle cx="96.5" cy="50" r="1.1" fill="var(--logo-fg)" opacity="0.35" />
    </svg>
  );
}

function LeafIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19.8 2c1 5 .5 10-2.5 13a7 7 0 0 1-6.3 5z" />
      <path d="M2 21c0-3 1.85-5.36 5.08-6" />
    </svg>
  );
}
function WaveIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2" />
      <path d="M2 17c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2" />
      <path d="M2 7c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2" />
    </svg>
  );
}
function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}
function NewChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.33 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}
function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}
function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function ChartIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="20" x2="12" y2="10" />
      <line x1="18" y1="20" x2="18" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  );
}
function UsersIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function LogoutIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}
