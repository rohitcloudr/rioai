import { useEffect, useState } from 'react';
import { apiUrl } from './api.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function FriendsManager({ userId }) {
  const [friends, setFriends] = useState([]);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl(`/api/friends/${userId}`))
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setFriends(d.friends ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function addFriend(e) {
    e?.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!EMAIL_RE.test(trimmed)) {
      setErr('Please enter a valid email.');
      return;
    }
    setAdding(true);
    setErr(null);
    try {
      const r = await fetch(apiUrl('/api/friends'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, email: trimmed, name: name.trim() || undefined }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'request failed');
      setFriends((prev) => [...prev, d.friend]);
      setEmail('');
      setName('');
      setShowForm(false);
    } catch (e) {
      setErr(e.message);
    } finally {
      setAdding(false);
    }
  }

  async function removeFriend(id) {
    if (!confirm('Remove this friend? They will no longer be alerted if you hit a hard moment.')) return;
    try {
      await fetch(apiUrl(`/api/friends/${id}`), { method: 'DELETE' });
      setFriends((prev) => prev.filter((f) => f.id !== id));
    } catch {}
  }

  return (
    <div className="sidebar-section">
      <div className="sidebar-head">
        <h2>Friends</h2>
        <span className="count">{friends.length}</span>
      </div>

      <p className="muted" style={{ marginTop: 0 }}>
        If Rio detects you're going through something really hard, these friends get a quick email asking
        them to check in. Max 5.
      </p>

      {friends.length > 0 && (
        <ul className="memories">
          {friends.map((f) => (
            <li key={f.id}>
              <span className="memory-fact">
                {f.friend_name ? <strong>{f.friend_name}</strong> : null}
                {f.friend_name ? <span style={{ opacity: 0.7 }}> · </span> : null}
                <span style={{ opacity: 0.85 }}>{f.friend_email}</span>
              </span>
              <span className="memory-meta">
                <button className="del" onClick={() => removeFriend(f.id)} title="Remove">
                  ×
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {showForm ? (
        <form onSubmit={addFriend} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          <input
            type="text"
            placeholder="Friend's name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={adding}
            style={inputStyle}
          />
          <input
            type="email"
            placeholder="friend@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={adding}
            required
            style={inputStyle}
            autoFocus
          />
          {err && <div className="error" style={{ fontSize: 12 }}>⚠ {err}</div>}
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="submit"
              disabled={adding || !email.trim()}
              className="new-chat-btn"
              style={{ flex: 1, justifyContent: 'center' }}
            >
              {adding ? 'Adding…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setErr(null);
                setEmail('');
                setName('');
              }}
              disabled={adding}
              className="new-chat-btn"
              style={{ flex: 1, justifyContent: 'center', opacity: 0.7 }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          className="new-chat-btn"
          onClick={() => setShowForm(true)}
          disabled={friends.length >= 5}
          title={friends.length >= 5 ? 'Max 5 friends' : 'Add a friend'}
          style={{ marginTop: 8 }}
        >
          + Add friend
        </button>
      )}
    </div>
  );
}

const inputStyle = {
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid var(--border, #ccc)',
  background: 'var(--input-bg, transparent)',
  color: 'inherit',
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
};
