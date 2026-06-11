// src/routes/auth.js
// Handles user registration and login.
//
// POST /auth/signup      — create a new account
// POST /auth/login       — log in, receive a token
// POST /auth/send-otp    — send a 6-digit OTP to an email address
// POST /auth/verify-otp  — verify OTP and log in (or finish signup)
// GET  /auth/me          — get the logged-in user's info

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const https = require('https');
const db = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ── In-memory OTP store  ─────────────────────────────────
// { email → { code, expiresAt, name? } }
const otpStore = new Map();

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

const OTP_EMAIL_HTML = (code) => `
  <div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:0;background:#0a2218;border-radius:20px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#1D9E75,#0A5C42);padding:32px 24px 24px;text-align:center">
      <div style="font-size:30px;font-weight:800;color:#fff;letter-spacing:-0.5px">trip<span style="color:#F4A94E">bae</span></div>
      <div style="font-size:12px;color:rgba(255,255,255,0.6);margin-top:4px;letter-spacing:2px;text-transform:uppercase">Plan · Split · Explore</div>
    </div>
    <div style="padding:32px 24px">
      <div style="font-size:15px;color:rgba(255,255,255,0.7);margin-bottom:24px;line-height:1.6">
        Here's your one-time sign-in code. It expires in <strong style="color:#fff">10 minutes</strong>.
      </div>
      <div style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:14px;padding:28px 20px;text-align:center;margin-bottom:24px">
        <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-bottom:10px;letter-spacing:2px;text-transform:uppercase">Your login code</div>
        <div style="font-size:48px;font-weight:900;letter-spacing:12px;color:#fff;font-family:monospace">${code}</div>
      </div>
      <div style="font-size:12px;color:rgba(255,255,255,0.3);text-align:center">If you didn't request this, you can safely ignore this email.</div>
    </div>
  </div>
`;

// Send via Resend API (https://resend.com — free tier, no domain needed for testing)
function sendViaResend(toEmail, code, apiKey) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      from: 'TripBae <onboarding@resend.dev>',
      to: [toEmail],
      subject: `${code} — Your TripBae login code`,
      html: OTP_EMAIL_HTML(code),
    });
    const options = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[OTP] Sent via Resend to ${toEmail}`);
        } else {
          console.error('[OTP] Resend error:', res.statusCode, data);
        }
        resolve();
      });
    });
    req.on('error', (e) => { console.error('[OTP] Resend request error:', e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

async function sendOtpEmail(toEmail, code) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const SMTP_USER = process.env.SMTP_USER;
  const SMTP_PASS = process.env.SMTP_PASS;
  const FROM = process.env.OTP_FROM_EMAIL || 'akshitu10@gmail.com';

  // 1. Try Resend if configured (recommended — free, no domain setup needed)
  if (RESEND_API_KEY) {
    return sendViaResend(toEmail, code, RESEND_API_KEY);
  }

  // 2. Try SMTP/Gmail if configured
  if (SMTP_USER && SMTP_PASS) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: SMTP_USER, pass: SMTP_PASS },
      });
      await transporter.sendMail({
        from: `TripBae <${FROM}>`,
        to: toEmail,
        subject: `${code} — Your TripBae login code`,
        html: OTP_EMAIL_HTML(code),
      });
      console.log(`[OTP] Sent via SMTP to ${toEmail}`);
      return;
    } catch (e) {
      console.error('[OTP] SMTP send failed:', e.message);
    }
  }

  // 3. Fallback: log to console (set RESEND_API_KEY in Render env vars to fix this)
  console.warn(`[OTP] ⚠ No email provider configured. To: ${toEmail} | Code: ${code}`);
  console.warn('[OTP] Add RESEND_API_KEY to your Render environment variables (free at resend.com)');
}

// ── SEND OTP ─────────────────────────────────────────────
// Body: { email, name? }   (name only needed for new-user signup flow)
router.post('/send-otp', async (req, res) => {
  const { email, name } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  const code = generateOtp();
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 min
  otpStore.set(email.toLowerCase(), { code, expiresAt, name: name?.trim() || '' });

  await sendOtpEmail(email, code);
  res.json({ ok: true, message: 'OTP sent to your email.' });
});

// ── VERIFY OTP (login or signup) ─────────────────────────
// Body: { email, code, name? }
// If the user doesn't exist and name is provided, a new account is created.
router.post('/verify-otp', async (req, res) => {
  const { email, code, name } = req.body;
  if (!email || !code) {
    return res.status(400).json({ error: 'Email and OTP code are required.' });
  }
  const entry = otpStore.get(email.toLowerCase());
  if (!entry) {
    return res.status(400).json({ error: 'No OTP was requested for this email. Please request a new one.' });
  }
  if (Date.now() > entry.expiresAt) {
    otpStore.delete(email.toLowerCase());
    return res.status(400).json({ error: 'This OTP has expired. Please request a new one.' });
  }
  if (entry.code !== String(code).trim()) {
    return res.status(400).json({ error: 'Incorrect code. Please check your email and try again.' });
  }

  try {
    let user = await db.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) {
      // New user — need a name to create account
      const displayName = (name || entry.name || '').trim();
      if (!displayName) {
        // Don't delete the OTP yet — user still needs to come back with their name
        return res.status(400).json({ error: 'Please provide your name to create an account.', needsName: true });
      }
      // We have the name — consume OTP and create user
      otpStore.delete(email.toLowerCase());
      user = await db.user.create({
        data: { name: displayName, email: email.toLowerCase(), password: '' },
      });
    } else {
      // Existing user — consume OTP
      otpStore.delete(email.toLowerCase());
    }
    const token = jwt.sign(
      { userId: user.id, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error('verify-otp error:', err);
    res.status(500).json({ error: 'Could not complete login.' });
  }
});

// ── SIGNUP ──────────────────────────────────────────────
// Body: { name, email, password }
router.post('/signup', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  try {
    // Check if email is already taken
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    // Hash the password — never store plain text passwords
    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await db.user.create({
      data: { name, email, password: hashedPassword },
    });

    // Create a token so they're logged in immediately after signing up
    const token = jwt.sign(
      { userId: user.id, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '30d' } // token lasts 30 days
    );

    res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Could not create account.' });
  }
});

// ── LOGIN ───────────────────────────────────────────────
// Body: { email, password }
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const user = await db.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = jwt.sign(
      { userId: user.id, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Could not log in.' });
  }
});

// ── GET ME ──────────────────────────────────────────────
// Returns the currently logged-in user's profile.
// Requires: Authorization header
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await db.user.findUnique({
      where: { id: req.userId },
      select: { id: true, name: true, email: true, createdAt: true },
    });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch user.' });
  }
});

// ── DELETE ACCOUNT ──────────────────────────────────────
// Permanently deletes the logged-in user, their trip memberships,
// and any trips where they were the only remaining member.
// Requires: Authorization header
router.delete('/me', authenticate, async (req, res) => {
  try {
    const userId = req.userId;

    // Find all trips the user is part of
    const memberships = await db.tripMember.findMany({
      where: { userId },
      select: { tripId: true },
    });
    const tripIds = memberships.map(m => m.tripId);

    // Delete the user — cascades remove their TripMember rows
    await db.user.delete({ where: { id: userId } });

    // For each affected trip, if no members remain, delete the trip too
    // (cascades wipe its expenses, contacts, photos, itinerary)
    if (tripIds.length) {
      const remaining = await db.tripMember.groupBy({
        by: ['tripId'],
        where: { tripId: { in: tripIds } },
        _count: { tripId: true },
      });
      const stillHasMembers = new Set(remaining.map(r => r.tripId));
      const orphanTripIds = tripIds.filter(id => !stillHasMembers.has(id));
      if (orphanTripIds.length) {
        await db.trip.deleteMany({ where: { id: { in: orphanTripIds } } });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Delete account failed:', err);
    res.status(500).json({ error: 'Could not delete account.' });
  }
});

module.exports = router;
