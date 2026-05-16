// src/routes/photos.js
// For now, photos are stored as URLs (e.g. from Cloudinary or Unsplash).
// Later you can add real file upload support.
//
// GET    /trips/:id/photos       — list photos
// POST   /trips/:id/photos       — add a photo by URL
// DELETE /trips/:id/photos/:pid  — delete a photo

const express = require('express');
const db = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

async function requireMembership(tripId, userId) {
  return db.tripMember.findFirst({ where: { tripId, userId } });
}

router.get('/:id/photos', async (req, res) => {
  const m = await requireMembership(req.params.id, req.userId);
  if (!m) return res.status(403).json({ error: 'Not a member.' });

  const photos = await db.photo.findMany({
    where: { tripId: req.params.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ photos });
});

// Body: { url }
router.post('/:id/photos', async (req, res) => {
  const m = await requireMembership(req.params.id, req.userId);
  if (!m) return res.status(403).json({ error: 'Not a member.' });

  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required.' });

  try {
    const photo = await db.photo.create({
      data: {
        tripId: req.params.id,
        url,
        uploader: m.nickname,
      },
    });
    res.status(201).json({ photo });
  } catch (err) {
    console.error('Add photo error:', err);
    res.status(500).json({ error: 'Could not add photo.' });
  }
});

router.delete('/:id/photos/:pid', async (req, res) => {
  const m = await requireMembership(req.params.id, req.userId);
  if (!m) return res.status(403).json({ error: 'Not a member.' });

  try {
    await db.photo.delete({ where: { id: req.params.pid } });
    res.json({ message: 'Photo deleted.' });
  } catch (err) {
    res.status(404).json({ error: 'Photo not found.' });
  }
});

module.exports = router;
