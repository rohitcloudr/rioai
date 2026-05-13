import nodemailer from 'nodemailer';

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const FROM_NAME = process.env.ALERT_FROM_NAME || 'Rio';

function isPlaceholder(v) {
  return !v || v.includes('paste') || v.includes('your.account@');
}

let transporter = null;
export function isEmailConfigured() {
  return !isPlaceholder(GMAIL_USER) && !isPlaceholder(GMAIL_APP_PASSWORD);
}

function getTransporter() {
  if (!isEmailConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
  }
  return transporter;
}

export async function sendDistressAlert({ friendEmail, friendName }) {
  const t = getTransporter();
  if (!t) {
    return { ok: false, error: 'email not configured (set GMAIL_USER and GMAIL_APP_PASSWORD)' };
  }

  const greeting = friendName ? `Hi ${friendName},` : 'Hi,';
  const subject = 'Your friend on Rio may need you';
  const text = [
    greeting,
    '',
    "Your friend has been talking with Rio and Your friend may be at risk of self-harm and could need immediate support.",
    '',
    "Please contact them as soon as possible. A call, message, or being there with them right now could make a real difference.",
    '',
    "If you believe they are in immediate danger, contact local emergency services or someone nearby who can safely check on them.",
    '',
    'You are receiving this because they chose you as a trusted contact in Rio.',
    '',
    '— Rio',
  ].join('\n');

  try {
    await t.sendMail({
      from: `"${FROM_NAME}" <${GMAIL_USER}>`,
      to: friendEmail,
      subject,
      text,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || 'send failed' };
  }
}

export async function sendLoginCode({ email, code, ttlMinutes = 10 }) {
  const t = getTransporter();
  if (!t) {
    return { ok: false, error: 'email not configured (set GMAIL_USER and GMAIL_APP_PASSWORD)' };
  }

  const subject = 'Your Rio login code';
  const text = [
    'Hi,',
    '',
    `Your Rio login code is: ${code}`,
    '',
    `This code is valid for ${ttlMinutes} minutes. If you didn't try to log in, you can ignore this email.`,
    '',
    '— Rio',
  ].join('\n');

  try {
    await t.sendMail({
      from: `"${FROM_NAME}" <${GMAIL_USER}>`,
      to: email,
      subject,
      text,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || 'send failed' };
  }
}
