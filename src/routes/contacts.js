// src/routes/contacts.js
//
// GET    /trips/:id/contacts           — list contacts
// POST   /trips/:id/contacts           — add contact
// DELETE /trips/:id/contacts/:cid      — delete contact

const express = require('express');
const db = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

async function requireMembership(tripId, userId) {
  return db.tripMember.findFirst({ where: { tripId, userId } });
}

router.get('/:id/contacts', async (req, res) => {
  const m = await requireMembership(req.params.id, req.userId);
  if (!m) return res.status(403).json({ error: 'Not a member of this trip.' });

  const contacts = await db.contact.findMany({ where: { tripId: req.params.id } });
  res.json({ contacts });
});

// Body: { name, role, cat, phone, note }
router.post('/:id/contacts', async (req, res) => {
  const m = await requireMembership(req.params.id, req.userId);
  if (!m) return res.status(403).json({ error: 'Not a member of this trip.' });

  const { name, role, cat, phone, note } = req.body;
  if (!name || !cat || !phone) {
    return res.status(400).json({ error: 'name, cat, and phone are required.' });
  }

  try {
    const contact = await db.contact.create({
      data: {
        tripId: req.params.id,
        name,
        role: role || '',
        cat,
        phone,
        addedBy: m.nickname, // whoever is logged in added it
        note: note || null,
      },
    });
    res.status(201).json({ contact });
  } catch (err) {
    console.error('Add contact error:', err);
    res.status(500).json({ error: 'Could not add contact.' });
  }
});

router.delete('/:id/contacts/:cid', async (req, res) => {
  const m = await requireMembership(req.params.id, req.userId);
  if (!m) return res.status(403).json({ error: 'Not a member of this trip.' });

  try {
    await db.contact.delete({ where: { id: req.params.cid } });
    res.json({ message: 'Contact deleted.' });
  } catch (err) {
    res.status(404).json({ error: 'Contact not found.' });
  }
});

module.exports = router;
