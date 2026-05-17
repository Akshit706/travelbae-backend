// src/routes/trips.js
// Everything to do with trips themselves.
//
// GET  /trips           — list my trips
// POST /trips           — create a new trip
// GET  /trips/:id       — get one trip with all its data
// POST /trips/join      — join a trip using a share code

const express = require('express');
const db = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// All routes here require login
router.use(authenticate);

// Helper: generate a share code like "JAI-4820" or "SOLO-7742"
function generateShareCode(destination, isSolo) {
  const prefix = isSolo
    ? 'SOLO'
    : (destination.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 3) || 'TRP');
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${num}`;
}

// ── LIST MY TRIPS ───────────────────────────────────────
// Returns all trips the logged-in user is a member of.
router.get('/', async (req, res) => {
  try {
    const memberships = await db.tripMember.findMany({
      where: { userId: req.userId },
      include: {
        trip: {
          include: {
            members: true,
            expenses: true,
            _count: { select: { photos: true, contacts: true } },
          },
        },
      },
      orderBy: { joinedAt: 'desc' },
    });

    const trips = memberships.map(m => m.trip);
    res.json({ trips });
  } catch (err) {
    console.error('List trips error:', err);
    res.status(500).json({ error: 'Could not fetch trips.' });
  }
});

// ── CREATE TRIP ─────────────────────────────────────────
// Body: { groupName, destination, emoji, arrival, departure, isSolo, budget, nickname }
// nickname = what this user wants to be called inside the trip (e.g. "Arjun")
router.post('/', async (req, res) => {
  const { groupName, destination, emoji, arrival, departure, isSolo, budget, nickname } = req.body;

  if (!groupName || !destination || !arrival || !departure || !nickname) {
    return res.status(400).json({ error: 'groupName, destination, arrival, departure, and nickname are required.' });
  }

  try {
    // Keep generating until we get a unique share code
    let shareCode;
    let attempts = 0;
    do {
      shareCode = generateShareCode(destination, isSolo);
      const exists = await db.trip.findUnique({ where: { shareCode } });
      if (!exists) break;
      attempts++;
    } while (attempts < 10);

    const trip = await db.trip.create({
      data: {
        groupName,
        destination,
        emoji: emoji || '✈️',
        arrival: new Date(arrival),
        departure: new Date(departure),
        isSolo: isSolo || false,
        shareCode,
        budget: budget ? parseFloat(budget) : null,
        // Add the creator as the first member
        members: {
          create: {
            userId: req.userId,
            nickname: nickname || req.userName,
          },
        },
      },
      include: { members: true },
    });

    res.status(201).json({ trip });
  } catch (err) {
    console.error('Create trip error:', err);
    res.status(500).json({ error: 'Could not create trip.' });
  }
});

// ── GET SINGLE TRIP ─────────────────────────────────────
// Returns the trip with all expenses, contacts, photos, and itinerary.
router.get('/:id', async (req, res) => {
  try {
    // Make sure the logged-in user is actually in this trip
    const membership = await db.tripMember.findFirst({
      where: { tripId: req.params.id, userId: req.userId },
    });
    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this trip.' });
    }

    const trip = await db.trip.findUnique({
      where: { id: req.params.id },
      include: {
        members: true,
        expenses: { orderBy: { date: 'desc' } },
        contacts: true,
        photos: { orderBy: { createdAt: 'desc' } },
        itinerary: { orderBy: [{ day: 'asc' }, { time: 'asc' }] },
      },
    });

    if (!trip) return res.status(404).json({ error: 'Trip not found.' });

    res.json({ trip, myNickname: membership.nickname });
  } catch (err) {
    console.error('Get trip error:', err);
    res.status(500).json({ error: 'Could not fetch trip.' });
  }
});

// ── JOIN TRIP ───────────────────────────────────────────
// Body: { shareCode, nickname }
router.post('/join', async (req, res) => {
  const { shareCode, nickname } = req.body;

  if (!shareCode || !nickname) {
    return res.status(400).json({ error: 'shareCode and nickname are required.' });
  }

  try {
    const trip = await db.trip.findUnique({ where: { shareCode: shareCode.trim().toUpperCase() } });
    if (!trip) {
      return res.status(404).json({ error: 'Invalid share code. Double-check and try again.' });
    }

    // Check if already a member
    const existing = await db.tripMember.findFirst({
      where: { tripId: trip.id, userId: req.userId },
    });
    if (existing) {
      return res.status(409).json({ error: 'You are already in this trip!' });
    }

    await db.tripMember.create({
      data: { tripId: trip.id, userId: req.userId, nickname },
    });

    res.json({ trip, message: `Joined "${trip.groupName}" successfully!` });
  } catch (err) {
    console.error('Join trip error:', err);
    res.status(500).json({ error: 'Could not join trip.' });
  }
});

// ── DELETE TRIP ─────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const membership = await db.tripMember.findFirst({
      where: { tripId: req.params.id, userId: req.userId },
    });
    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this trip.' });
    }

    await db.trip.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete trip error:', err);
    res.status(500).json({ error: 'Could not delete trip.' });
  }
});

// ── UPDATE TRIP (mark complete / restore) ───────────────
router.patch('/:id', async (req, res) => {
  try {
    const membership = await db.tripMember.findFirst({
      where: { tripId: req.params.id, userId: req.userId },
    });
    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this trip.' });
    }

    const trip = await db.trip.update({
      where: { id: req.params.id },
      data: {
        ...(req.body.completed !== undefined && { completed: req.body.completed }),
        ...(req.body.budget !== undefined && { budget: req.body.budget }),
      },
    });
    res.json({ trip });
  } catch (err) {
    console.error('Update trip error:', err);
    res.status(500).json({ error: 'Could not update trip.' });
  }
});

module.exports = router;
