// src/routes/itinerary.js
//
// GET    /trips/:id/itinerary      — get all itinerary items
// POST   /trips/:id/itinerary      — add an item
// DELETE /trips/:id/itinerary/:iid — delete an item

const express = require('express');
const db = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

async function requireMembership(tripId, userId) {
  return db.tripMember.findFirst({ where: { tripId, userId } });
}

router.get('/:id/itinerary', async (req, res) => {
  const m = await requireMembership(req.params.id, req.userId);
  if (!m) return res.status(403).json({ error: 'Not a member.' });

  const items = await db.itineraryItem.findMany({
    where: { tripId: req.params.id },
    orderBy: [{ day: 'asc' }, { time: 'asc' }],
  });
  res.json({ items });
});

// Body: { day, time, title, note, icon }
router.post('/:id/itinerary', async (req, res) => {
  const m = await requireMembership(req.params.id, req.userId);
  if (!m) return res.status(403).json({ error: 'Not a member.' });

  const { day, time, title, note, icon } = req.body;
  if (!day || !title) {
    return res.status(400).json({ error: 'day and title are required.' });
  }

  try {
    const item = await db.itineraryItem.create({
      data: {
        tripId: req.params.id,
        day: parseInt(day),
        time: time || null,
        title,
        note: note || null,
        icon: icon || null,
      },
    });
    res.status(201).json({ item });
  } catch (err) {
    console.error('Add itinerary error:', err);
    res.status(500).json({ error: 'Could not add itinerary item.' });
  }
});

router.delete('/:id/itinerary/:iid', async (req, res) => {
  const m = await requireMembership(req.params.id, req.userId);
  if (!m) return res.status(403).json({ error: 'Not a member.' });

  try {
    await db.itineraryItem.delete({ where: { id: req.params.iid } });
    res.json({ message: 'Item deleted.' });
  } catch (err) {
    res.status(404).json({ error: 'Item not found.' });
  }
});

module.exports = router;
