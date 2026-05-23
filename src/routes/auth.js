// src/routes/auth.js
// Handles user registration and login.
//
// POST /auth/signup  — create a new account
// POST /auth/login   — log in, receive a token
// GET  /auth/me      — get the logged-in user's info

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

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
