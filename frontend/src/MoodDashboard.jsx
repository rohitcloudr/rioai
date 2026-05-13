import { useEffect, useState } from 'react';

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

// Mood-positivity ordering — used to color the daily heatmap cell.
// Higher = greener (better day), lower = redder.
const EMOTION_SCORE = {
  excited: 2,
  love: 2,
  happy: 2,
  surprised: 1,
  neutral: 0,
  confused: -1,
  tired: -1,
  anxious: -2,
  sad: -2,
  angry: -2,
};

export default function MoodDashboard({ isOpen, onClose, userId, authedFetch }) {
  const [data, setData] = useState(null);
  const [days, setDays] = useState(14);
  const [loading, setLoading] = useState(false);
  const doFetch = authedFetch || fetch;

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    doFetch(`/api/mood/${userId}?days=${days}`)
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => setData({ counts: [], series: [] }))
      .finally(() => setLoading(false));
  }, [isOpen, userId, days]);

  if (!isOpen) return null;

  const counts = data?.counts ?? [];
  const series = data?.series ?? [];
  const total = counts.reduce((s, c) => s + c.n, 0);
  const sorted = [...counts].sort((a, b) => b.n - a.n);
  const dailyBuckets = bucketByDay(series, days);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="mood-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mood-head">
          <h2>Your mood</h2>
          <div className="mood-range">
            {[7, 14, 30].map((d) => (
              <button
                key={d}
                className={d === days ? 'active' : ''}
                onClick={() => setDays(d)}
              >
                {d}d
              </button>
            ))}
            <button className="mood-close" onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
        </div>

        {loading ? (
          <p className="muted">Loading…</p>
        ) : total === 0 ? (
          <p className="muted">
            No mood data yet for the last {days} days. Chat with Rio and your emotions
            will start showing up here.
          </p>
        ) : (
          <>
            <div className="mood-section">
              <h3>Last {days} days</h3>
              <div className="mood-heatmap" role="img" aria-label="Daily mood heatmap">
                {dailyBuckets.map((b, i) => (
                  <div
                    key={i}
                    className="mood-cell"
                    title={
                      b.date +
                      (b.dominant
                        ? ` — mostly ${b.dominant} (${b.total} msg${b.total === 1 ? '' : 's'})`
                        : ' — no chats')
                    }
                    style={{
                      background: cellColor(b.score, b.total),
                    }}
                  >
                    <span className="mood-cell-emoji">
                      {b.dominant ? EMOTION_EMOJI[b.dominant] ?? '' : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="mood-section">
              <h3>Breakdown</h3>
              <ul className="mood-bars">
                {sorted.map((c) => {
                  const pct = total > 0 ? Math.round((c.n / total) * 100) : 0;
                  return (
                    <li key={c.emotion}>
                      <span className="mood-emo">
                        {EMOTION_EMOJI[c.emotion] ?? ''} {c.emotion}
                      </span>
                      <span className="mood-bar-track">
                        <span className="mood-bar-fill" style={{ width: `${pct}%` }} />
                      </span>
                      <span className="mood-pct">
                        {c.n} · {pct}%
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>

            <p className="muted mood-foot">
              Based on {total} message{total === 1 ? '' : 's'} you sent in the last {days} days.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function bucketByDay(series, days) {
  const buckets = [];
  const today = startOfDay(Date.now());
  for (let i = days - 1; i >= 0; i--) {
    const dayStart = today - i * 24 * 60 * 60 * 1000;
    buckets.push({
      key: dayStart,
      date: new Date(dayStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      counts: {},
      total: 0,
      score: 0,
    });
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const s of series) {
    const dayStart = startOfDay(s.created_at);
    const b = byKey.get(dayStart);
    if (!b) continue;
    b.counts[s.emotion] = (b.counts[s.emotion] || 0) + 1;
    b.total += 1;
    b.score += EMOTION_SCORE[s.emotion] ?? 0;
  }
  for (const b of buckets) {
    let max = 0;
    for (const [emo, n] of Object.entries(b.counts)) {
      if (n > max) {
        max = n;
        b.dominant = emo;
      }
    }
  }
  return buckets;
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function cellColor(score, total) {
  if (total === 0) return 'var(--surface-2, #eee)';
  const avg = score / total;
  // map [-2..+2] to a hue from red (0) -> yellow (50) -> green (130)
  const t = (avg + 2) / 4;
  const hue = Math.round(t * 130);
  const sat = 55;
  const light = 70;
  return `hsl(${hue} ${sat}% ${light}%)`;
}
