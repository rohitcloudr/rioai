// One-shot smoke test — authenticates against Gmail SMTP without sending mail.
// Run:  node verify-email.js
import 'dotenv/config';
import nodemailer from 'nodemailer';

const user = process.env.GMAIL_USER;
const pass = process.env.GMAIL_APP_PASSWORD;

if (!user || !pass) {
  console.error('FAIL: GMAIL_USER or GMAIL_APP_PASSWORD missing from .env');
  process.exit(1);
}

const t = nodemailer.createTransport({
  service: 'gmail',
  auth: { user, pass },
});

try {
  await t.verify();
  console.log(`OK: SMTP authenticated as ${user}`);
  process.exit(0);
} catch (e) {
  console.error('FAIL:', e?.message || e);
  process.exit(2);
}
