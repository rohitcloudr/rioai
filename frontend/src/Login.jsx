import { useEffect, useRef, useState } from 'react';
import { apiUrl } from './api.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Login({ onAuthed }) {
  const [step, setStep] = useState('email'); // 'email' | 'code'
  const [email, setEmail] = useState('');
  const [adminCode, setAdminCode] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const [resendIn, setResendIn] = useState(0);

  const codeRef = useRef(null);

  useEffect(() => {
    if (step === 'code') codeRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  async function requestCode(e) {
    e?.preventDefault();
    if (busy) return;
    setError(null);
    setInfo(null);
    const trimmed = email.trim().toLowerCase();
    if (!EMAIL_RE.test(trimmed)) {
      setError('Please enter a valid email.');
      return;
    }
    const trimmedAdmin = adminCode.trim();
    if (!trimmedAdmin) {
      setError('Admin code required.');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(apiUrl('/api/auth/request-code'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmed, adminCode: trimmedAdmin }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        setError(data?.error || `Couldn't send code (status ${r.status}).`);
        return;
      }
      setEmail(trimmed);
      setStep('code');
      setResendIn(60);
      setInfo(`Code sent to ${trimmed}. Check your inbox.`);
    } catch {
      setError('Cannot reach the Rio server. Make sure it is running on port 8787.');
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(e) {
    e?.preventDefault();
    if (busy) return;
    setError(null);
    if (!/^\d{6}$/.test(code.trim())) {
      setError('Enter the 6-digit code from your email.');
      return;
    }
    setBusy(true);
    try {
      const anonUserId = localStorage.getItem('rioUserId') || null;
      const r = await fetch(apiUrl('/api/auth/verify-code'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code: code.trim(), anonUserId }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        setError(data?.error || `Could not verify code (status ${r.status}).`);
        return;
      }
      // Sync local id with the server-issued one (handles second-device case
      // where the server returned a different existing user.id than our anon one).
      if (data?.userId) localStorage.setItem('rioUserId', data.userId);
      onAuthed?.({ token: data.token, userId: data.userId, email: data.email });
    } catch {
      setError('Cannot reach the Rio server.');
    } finally {
      setBusy(false);
    }
  }

  function back() {
    setStep('email');
    setCode('');
    setAdminCode('');
    setError(null);
    setInfo(null);
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-brand">
          <BalanceMark />
          <h1>Rio</h1>
        </div>
        <p className="login-sub">your AI dost — sign in with your email</p>

        {step === 'email' ? (
          <form onSubmit={requestCode} className="login-form">
            <label className="login-label" htmlFor="login-email">Email</label>
            <input
              id="login-email"
              className="login-input"
              type="email"
              autoComplete="email"
              autoFocus
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
            />
            <label className="login-label" htmlFor="login-admin-code">Admin code</label>
            <input
              id="login-admin-code"
              className="login-input"
              type="password"
              autoComplete="off"
              placeholder="Enter the access code shared by the admin"
              value={adminCode}
              onChange={(e) => setAdminCode(e.target.value)}
              disabled={busy}
            />
            {error && <div className="login-error">{error}</div>}
            <button className="login-btn" type="submit" disabled={busy}>
              {busy ? 'Sending…' : 'Send code'}
            </button>
            <p className="login-hint">We'll email you a 6-digit code. No password.</p>
          </form>
        ) : (
          <form onSubmit={verifyCode} className="login-form">
            <label className="login-label" htmlFor="login-code">Enter the 6-digit code</label>
            <input
              id="login-code"
              ref={codeRef}
              className="login-input login-otp-input"
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              autoComplete="one-time-code"
              placeholder="••••••"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              disabled={busy}
            />
            {info && !error && <div className="login-info">{info}</div>}
            {error && <div className="login-error">{error}</div>}
            <button className="login-btn" type="submit" disabled={busy || code.length !== 6}>
              {busy ? 'Verifying…' : 'Verify & sign in'}
            </button>
            <div className="login-row">
              <button type="button" className="login-link" onClick={back} disabled={busy}>
                ← change email
              </button>
              <button
                type="button"
                className="login-link"
                onClick={requestCode}
                disabled={busy || resendIn > 0}
              >
                {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function BalanceMark() {
  return (
    <svg viewBox="0 0 100 100" width="48" height="48" aria-hidden="true">
      <circle cx="50" cy="50" r="48" fill="none" stroke="var(--logo-fg)" strokeWidth="1" opacity="0.18" />
      <circle cx="50" cy="50" r="38" fill="var(--logo-bg)" />
      <path
        d="M 50 12 A 38 38 0 0 1 50 88 A 19 19 0 0 0 50 50 A 19 19 0 0 1 50 12 Z"
        fill="var(--logo-fg)"
      />
      <circle cx="50" cy="69" r="5" fill="var(--logo-bg)" />
      <circle cx="50" cy="31" r="5" fill="var(--logo-fg)" />
    </svg>
  );
}
