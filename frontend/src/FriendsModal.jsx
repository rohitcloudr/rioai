import { useEffect, useRef, useState } from 'react';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FRIENDS = 5;

// Friends are stored against the stable per-device accountId — they survive
// across every "new chat", so the user only sets them up once.
export default function FriendsModal({ isOpen, onClose, accountId, authedFetch }) {
  const doFetch = authedFetch || fetch;
  const [friends, setFriends] = useState([]);
  const [emailConfigured, setEmailConfigured] = useState(true);
  const [limits, setLimits] = useState(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    doFetch(`/api/friends/${accountId}`)
      .then((r) => r.json())
      .then((d) => {
        setFriends(d.friends ?? []);
        setEmailConfigured(d.emailConfigured !== false);
        setLimits(d.limits ?? null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isOpen, accountId]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  async function addFriend(e) {
    e?.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!EMAIL_RE.test(trimmed)) {
      setErr('Please enter a valid email.');
      return;
    }
    if (friends.length >= MAX_FRIENDS) {
      setErr(`Max ${MAX_FRIENDS} friends.`);
      return;
    }
    setAdding(true);
    setErr(null);
    try {
      const r = await doFetch('/api/friends', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: accountId, email: trimmed, name: name.trim() || undefined }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'request failed');
      setFriends((prev) => {
        const without = prev.filter((f) => f.id !== d.friend.id);
        return [...without, d.friend];
      });
      setEmail('');
      setName('');
    } catch (e) {
      setErr(e.message);
    } finally {
      setAdding(false);
    }
  }

  async function removeFriend(id) {
    if (!confirm('Remove this friend? They will no longer be alerted if Rio detects a hard moment.')) return;
    try {
      await doFetch(`/api/friends/${id}?userId=${encodeURIComponent(accountId)}`, { method: 'DELETE' });
      setFriends((prev) => prev.filter((f) => f.id !== id));
    } catch {}
  }

  const atCap = friends.length >= MAX_FRIENDS;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="friends-modal"
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Trusted friends"
      >
        <div className="friends-head">
          <div>
            <h2>Trusted friends</h2>
            <p className="friends-sub">
              If Rio detects you mentioning self-harm or wanting to end your life, the friends below get a quick check-in email. They are saved once — no need to add again for new chats.
            </p>
          </div>
          <button className="mood-close icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>

        {!emailConfigured && (
          <div className="friends-warn">
            ⚠ Email isn't configured on the server. Friends are saved, but alerts won't actually send until <code>GMAIL_USER</code> and <code>GMAIL_APP_PASSWORD</code> are set in <code>backend/.env</code>.
          </div>
        )}

        <div className="friends-list-wrap">
          {loading ? (
            <p className="muted">Loading…</p>
          ) : friends.length === 0 ? (
            <p className="muted friends-empty">No friends yet. Add up to {MAX_FRIENDS} below.</p>
          ) : (
            <ul className="friends-list">
              {friends.map((f) => (
                <li key={f.id} className="friend-card">
                  <div className="friend-avatar" aria-hidden="true">
                    {(f.friend_name || f.friend_email).charAt(0).toUpperCase()}
                  </div>
                  <div className="friend-info">
                    <div className="friend-name">{f.friend_name || f.friend_email.split('@')[0]}</div>
                    <div className="friend-email">{f.friend_email}</div>
                  </div>
                  <button
                    className="friend-remove"
                    onClick={() => removeFriend(f.id)}
                    aria-label={`Remove ${f.friend_name || f.friend_email}`}
                    title="Remove"
                  >
                    <TrashIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <form
          onSubmit={addFriend}
          className={`friends-form ${atCap ? 'at-cap' : ''}`}
          aria-disabled={atCap}
        >
          <div className="friends-form-row">
            <input
              type="text"
              placeholder="Friend's name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={adding || atCap}
              maxLength={60}
            />
            <input
              type="email"
              placeholder="friend@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={adding || atCap}
              required
              maxLength={120}
            />
            <button
              type="submit"
              disabled={adding || atCap || !email.trim()}
              className="friends-add-btn"
            >
              {adding ? 'Adding…' : 'Add'}
            </button>
          </div>
          {err && <div className="error friends-err">⚠ {err}</div>}
          <div className="friends-meta">
            {friends.length}/{MAX_FRIENDS} friends · {atCap ? 'at the cap, remove one to add more' : `${MAX_FRIENDS - friends.length} slot${MAX_FRIENDS - friends.length === 1 ? '' : 's'} left`}
          </div>
        </form>

        {limits && (
          <div className="friends-limits">
            <strong>Sending limits</strong>
            <ul>
              <li>Max {limits.maxFriends} friends per account</li>
              <li>{limits.cooldownSeconds}s cooldown between alerts to the same friend</li>
              <li>Up to {limits.dailyCapPerAccount} alert emails per account per day</li>
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}
