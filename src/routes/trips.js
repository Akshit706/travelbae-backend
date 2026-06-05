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

async function requireMembership(tripId, userId) {
  return db.tripMember.findFirst({ where: { tripId, userId } });
}

function getClubChatPair(tripOneId, tripTwoId) {
  return [tripOneId, tripTwoId].sort((a, b) => a.localeCompare(b));
}

function mapClubChat(chat, currentTripId) {
  const otherTrip = chat.tripAId === currentTripId ? chat.tripB : chat.tripA;
  return {
    id: chat.id,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    otherTripId: otherTrip.id,
    otherTrip,
    tripA: chat.tripA,
    tripB: chat.tripB,
    title: `${chat.tripA.groupName} x ${chat.tripB.groupName}`,
    messages: chat.messages,
    splitExpenses: chat.splitExpenses,
    latestMessage: chat.messages[chat.messages.length - 1] || null,
  };
}

function buildChatMemberKeys(chat) {
  const groupA = (chat.tripA?.members || []).map(member => `${chat.tripA.id}:${member.id}`);
  const groupB = (chat.tripB?.members || []).map(member => `${chat.tripB.id}:${member.id}`);
  return new Set([...groupA, ...groupB]);
}

function buildChatMemberLookup(chat) {
  const map = new Map();
  (chat.tripA?.members || []).forEach((member) => {
    map.set(`${chat.tripA.id}:${member.id}`, {
      tripId: chat.tripA.id,
      memberId: member.id,
      nickname: member.nickname,
    });
  });
  (chat.tripB?.members || []).forEach((member) => {
    map.set(`${chat.tripB.id}:${member.id}`, {
      tripId: chat.tripB.id,
      memberId: member.id,
      nickname: member.nickname,
    });
  });
  return map;
}

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

// ── SAVE AI CACHE (itinerary + taste) ──────────────────
// Called by any member after generation to persist so all members see it.
// Body: { cachedItinerary?, cachedTaste? }
// Either field can be null to clear it (e.g. on "regenerate").
router.patch('/:id/ai-cache', async (req, res) => {
  try {
    const membership = await requireMembership(req.params.id, req.userId);
    if (!membership) return res.status(403).json({ error: 'You are not a member of this trip.' });

    const update = {};
    if (Object.prototype.hasOwnProperty.call(req.body, 'cachedItinerary')) {
      update.cachedItinerary = req.body.cachedItinerary; // can be null (clears it)
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'cachedTaste')) {
      update.cachedTaste = req.body.cachedTaste;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Provide cachedItinerary and/or cachedTaste.' });
    }

    const trip = await db.trip.update({ where: { id: req.params.id }, data: update });
    res.json({ ok: true, cachedItinerary: trip.cachedItinerary, cachedTaste: trip.cachedTaste });
  } catch (err) {
    console.error('Save AI cache error:', err);
    res.status(500).json({ error: 'Could not save AI cache.' });
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

// ── CLUB HUB (discover + requests + my profile) with location-based filtering ─────────────
// Query params: ?lat=<number>&lng=<number>&radius=<number-in-km>
router.get('/:id/club', async (req, res) => {
  try {
    const m = await requireMembership(req.params.id, req.userId);
    if (!m) return res.status(403).json({ error: 'You are not a member of this trip.' });

    const { lat, lng, radius, vibe, activeOnly } = req.query;
    const userLat = lat ? parseFloat(lat) : null;
    const userLng = lng ? parseFloat(lng) : null;
    const filterRadius = radius ? parseFloat(radius) : null;

    // Helper to calculate haversine distance (km)
    const calcDistance = (lat1, lon1, lat2, lon2) => {
      const R = 6371; // Earth's radius in km
      const dLat = ((lat2 - lat1) * Math.PI) / 180;
      const dLon = ((lon2 - lon1) * Math.PI) / 180;
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + 
                Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * 
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    };

    const [myProfile, rawDiscover, incomingRequests, outgoingRequests, chats] = await Promise.all([
      db.clubProfile.findUnique({ where: { tripId: req.params.id } }),
      db.clubProfile.findMany({
        where: {
          status: 'listed',
          tripId: { not: req.params.id },
          trip: { completed: false },
        },
        include: {
          trip: {
            include: {
              members: true,
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
      }),
      db.clubJoinRequest.findMany({
        where: { targetTripId: req.params.id, status: 'pending' },
        include: {
          requesterTrip: { include: { members: true, clubProfile: true } },
          requesterUser: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      db.clubJoinRequest.findMany({
        where: { requesterTripId: req.params.id },
        include: {
          targetTrip: { include: { members: true, clubProfile: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      db.clubChat.findMany({
        where: {
          OR: [{ tripAId: req.params.id }, { tripBId: req.params.id }],
        },
        include: {
          tripA: {
            include: {
              members: true,
              clubProfile: true,
              photos: { orderBy: { createdAt: 'desc' }, take: 40 },
            },
          },
          tripB: {
            include: {
              members: true,
              clubProfile: true,
              photos: { orderBy: { createdAt: 'desc' }, take: 40 },
            },
          },
          messages: {
            include: {
              senderUser: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: 'asc' },
            take: 60,
          },
          splitExpenses: {
            orderBy: { createdAt: 'asc' },
            take: 200,
          },
        },
        orderBy: { updatedAt: 'desc' },
      }),
    ]);

    const referenceLat = userLat != null ? userLat : myProfile?.latitude ?? null;
    const referenceLng = userLng != null ? userLng : myProfile?.longitude ?? null;

    // Always attach distance when we can calculate it.
    let discover = rawDiscover;
    if (referenceLat != null && referenceLng != null) {
      discover = rawDiscover.map(profile => {
        if (profile.latitude == null || profile.longitude == null) {
          return { ...profile, distance: null };
        }
        return {
          ...profile,
          distance: calcDistance(referenceLat, referenceLng, profile.latitude, profile.longitude),
        };
      });
      if (filterRadius != null) {
        discover = discover.filter(profile => profile.distance != null && profile.distance <= filterRadius);
      }
      discover.sort((a, b) => {
        const da = a.distance == null ? Number.POSITIVE_INFINITY : a.distance;
        const dbv = b.distance == null ? Number.POSITIVE_INFINITY : b.distance;
        return da - dbv;
      });
    }

    if (vibe && vibe !== 'any') {
      discover = discover.filter(profile => (profile.vibe || 'mixed') === vibe);
    }

    if (activeOnly === '1') {
      const activeCutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
      discover = discover.filter(profile => new Date(profile.updatedAt).getTime() >= activeCutoff);
    }

    res.json({
      myProfile,
      discover,
      incomingRequests,
      outgoingRequests,
      chats: chats.map(chat => mapClubChat(chat, req.params.id)),
    });
  } catch (err) {
    console.error('Club hub error:', err);
    res.status(500).json({ error: 'Could not fetch club data.' });
  }
});

// ── CLUB PROFILE UPSERT ─────────────────────────────────────
// Body: { title, about, lookingFor, latitude, longitude, photoUrl, vibe, genderMix, boysCount, girlsCount, coverTags }
router.put('/:id/club/profile', async (req, res) => {
  const { title, about, lookingFor, latitude, longitude, photoUrl, vibe, genderMix, boysCount, girlsCount, coverTags } = req.body;

  if (!title || !about) {
    return res.status(400).json({ error: 'title and about are required.' });
  }

  try {
    const m = await requireMembership(req.params.id, req.userId);
    if (!m) return res.status(403).json({ error: 'You are not a member of this trip.' });

    const safeTags = Array.isArray(coverTags)
      ? coverTags
          .map(t => String(t || '').trim().slice(0, 24))
          .filter(Boolean)
          .slice(0, 8)
      : [];

    const profile = await db.clubProfile.upsert({
      where: { tripId: req.params.id },
      create: {
        tripId: req.params.id,
        creatorUserId: req.userId,
        status: 'listed',
        title: String(title).trim().slice(0, 80),
        about: String(about).trim().slice(0, 400),
        lookingFor: lookingFor ? String(lookingFor).trim().slice(0, 160) : null,
        latitude: latitude !== undefined && latitude !== null ? parseFloat(latitude) : null,
        longitude: longitude !== undefined && longitude !== null ? parseFloat(longitude) : null,
        photoUrl: photoUrl ? String(photoUrl).slice(0, 50000) : null, // base64 limit
        vibe: vibe ? String(vibe).trim().slice(0, 30) : null,
        genderMix: genderMix ? String(genderMix).trim().slice(0, 20) : null,
        boysCount: Number.isFinite(Number(boysCount)) ? Math.max(0, Math.min(99, Number(boysCount))) : null,
        girlsCount: Number.isFinite(Number(girlsCount)) ? Math.max(0, Math.min(99, Number(girlsCount))) : null,
        coverTags: safeTags,
      },
      update: {
        title: String(title).trim().slice(0, 80),
        about: String(about).trim().slice(0, 400),
        lookingFor: lookingFor ? String(lookingFor).trim().slice(0, 160) : null,
        latitude: latitude !== undefined && latitude !== null ? parseFloat(latitude) : null,
        longitude: longitude !== undefined && longitude !== null ? parseFloat(longitude) : null,
        photoUrl: photoUrl ? String(photoUrl).slice(0, 50000) : null,
        vibe: vibe ? String(vibe).trim().slice(0, 30) : null,
        genderMix: genderMix ? String(genderMix).trim().slice(0, 20) : null,
        boysCount: Number.isFinite(Number(boysCount)) ? Math.max(0, Math.min(99, Number(boysCount))) : null,
        girlsCount: Number.isFinite(Number(girlsCount)) ? Math.max(0, Math.min(99, Number(girlsCount))) : null,
        coverTags: safeTags,
      },
    });

    res.json({ profile });
  } catch (err) {
    console.error('Upsert club profile error:', err);
    res.status(500).json({ error: 'Could not save club profile.' });
  }
});

// ── CLUB STATUS (listed / snooze) ──────────────────────────
router.patch('/:id/club/status', async (req, res) => {
  const { status } = req.body;
  if (!['listed', 'snooze'].includes(status)) {
    return res.status(400).json({ error: 'status must be listed or snooze.' });
  }

  try {
    const m = await requireMembership(req.params.id, req.userId);
    if (!m) return res.status(403).json({ error: 'You are not a member of this trip.' });

    const trip = await db.trip.findUnique({ where: { id: req.params.id } });
    if (!trip) return res.status(404).json({ error: 'Trip not found.' });

    const profile = await db.clubProfile.upsert({
      where: { tripId: req.params.id },
      create: {
        tripId: req.params.id,
        creatorUserId: req.userId,
        status,
        title: trip.groupName,
        about: `Hey! We are ${trip.groupName}.`,
        vibe: 'mixed',
        genderMix: 'mixed',
        coverTags: [],
      },
      update: { status },
    });

    res.json({ profile });
  } catch (err) {
    console.error('Update club status error:', err);
    res.status(500).json({ error: 'Could not update club status.' });
  }
});

// ── SEND CLUB REQUEST ───────────────────────────────────────
router.post('/:id/club/requests', async (req, res) => {
  const { targetTripId, message } = req.body;
  if (!targetTripId || !message) {
    return res.status(400).json({ error: 'targetTripId and message are required.' });
  }

  try {
    const m = await requireMembership(req.params.id, req.userId);
    if (!m) return res.status(403).json({ error: 'You are not a member of this trip.' });
    if (req.params.id === targetTripId) {
      return res.status(400).json({ error: 'Cannot send request to your own group.' });
    }

    const targetProfile = await db.clubProfile.findUnique({ where: { tripId: targetTripId } });
    if (!targetProfile || targetProfile.status !== 'listed') {
      return res.status(404).json({ error: 'Target group is not currently listed.' });
    }

    const [tripAId, tripBId] = getClubChatPair(req.params.id, targetTripId);
    const existingChat = await db.clubChat.findUnique({
      where: { tripAId_tripBId: { tripAId, tripBId } },
    });
    if (existingChat) {
      return res.status(409).json({ error: 'You already have an active chat with this group.' });
    }

    const request = await db.clubJoinRequest.upsert({
      where: { targetTripId_requesterTripId: { targetTripId, requesterTripId: req.params.id } },
      create: {
        targetTripId,
        requesterTripId: req.params.id,
        requesterUserId: req.userId,
        message: String(message).trim().slice(0, 400),
        status: 'pending',
      },
      update: {
        requesterUserId: req.userId,
        message: String(message).trim().slice(0, 400),
        status: 'pending',
      },
    });

    res.status(201).json({ request });
  } catch (err) {
    console.error('Send club request error:', err);
    res.status(500).json({ error: 'Could not send request.' });
  }
});

// ── RESPOND TO CLUB REQUEST (accept / decline) ─────────────
router.patch('/:id/club/requests/:requestId', async (req, res) => {
  const { action } = req.body;
  if (!['accepted', 'declined'].includes(action)) {
    return res.status(400).json({ error: 'action must be accepted or declined.' });
  }

  try {
    const m = await requireMembership(req.params.id, req.userId);
    if (!m) return res.status(403).json({ error: 'You are not a member of this trip.' });

    const existing = await db.clubJoinRequest.findUnique({ where: { id: req.params.requestId } });
    if (!existing || existing.targetTripId !== req.params.id) {
      return res.status(404).json({ error: 'Request not found.' });
    }

    const result = await db.$transaction(async (tx) => {
      const request = await tx.clubJoinRequest.update({
        where: { id: req.params.requestId },
        data: { status: action },
      });

      let chat = null;
      if (action === 'accepted') {
        const [tripAId, tripBId] = getClubChatPair(existing.targetTripId, existing.requesterTripId);
        chat = await tx.clubChat.upsert({
          where: { tripAId_tripBId: { tripAId, tripBId } },
          create: { tripAId, tripBId },
          update: {},
          include: {
            tripA: { include: { members: true, clubProfile: true } },
            tripB: { include: { members: true, clubProfile: true } },
            messages: {
              include: {
                senderUser: { select: { id: true, name: true } },
              },
              orderBy: { createdAt: 'asc' },
            },
            splitExpenses: {
              orderBy: { createdAt: 'asc' },
            },
          },
        });
      }

      return { request, chat };
    });

    res.json({
      request: result.request,
      chat: result.chat ? mapClubChat(result.chat, req.params.id) : null,
    });
  } catch (err) {
    console.error('Respond club request error:', err);
    res.status(500).json({ error: 'Could not update request.' });
  }
});

// ── SEND CLUB CHAT MESSAGE ────────────────────────────────
router.post('/:id/club/chats/:chatId/messages', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) {
    return res.status(400).json({ error: 'text is required.' });
  }

  try {
    const m = await requireMembership(req.params.id, req.userId);
    if (!m) return res.status(403).json({ error: 'You are not a member of this trip.' });

    const chat = await db.clubChat.findUnique({ where: { id: req.params.chatId } });
    if (!chat || (chat.tripAId !== req.params.id && chat.tripBId !== req.params.id)) {
      return res.status(404).json({ error: 'Chat not found.' });
    }

    const message = await db.clubChatMessage.create({
      data: {
        chatId: chat.id,
        senderTripId: req.params.id,
        senderUserId: req.userId,
        text: text.slice(0, 1000),
      },
      include: {
        senderUser: { select: { id: true, name: true } },
      },
    });

    await db.clubChat.update({ where: { id: chat.id }, data: {} });

    res.status(201).json({ message });
  } catch (err) {
    console.error('Send club chat message error:', err);
    res.status(500).json({ error: 'Could not send chat message.' });
  }
});

// ── ADD CLUB CHAT SPLIT EXPENSE ──────────────────────────
// ── DELETE CLUB CHAT ─────────────────────────────────────
router.delete('/:id/club/chats/:chatId', async (req, res) => {
  try {
    const m = await requireMembership(req.params.id, req.userId);
    if (!m) return res.status(403).json({ error: 'You are not a member of this trip.' });

    const chat = await db.clubChat.findUnique({ where: { id: req.params.chatId } });
    if (!chat || (chat.tripAId !== req.params.id && chat.tripBId !== req.params.id)) {
      return res.status(404).json({ error: 'Chat not found.' });
    }

    await db.clubChat.delete({ where: { id: req.params.chatId } });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete club chat error:', err);
    res.status(500).json({ error: 'Could not delete chat.' });
  }
});

// ── ADD CLUB CHAT SPLIT EXPENSE ──────────────────────────
router.delete('/:id/club/chats/:chatId/splits/:splitId', async (req, res) => {
  try {
    const m = await requireMembership(req.params.id, req.userId);
    if (!m) return res.status(403).json({ error: 'You are not a member of this trip.' });

    const chat = await db.clubChat.findUnique({ where: { id: req.params.chatId } });
    if (!chat || (chat.tripAId !== req.params.id && chat.tripBId !== req.params.id)) {
      return res.status(404).json({ error: 'Chat not found.' });
    }

    const split = await db.clubChatSplitExpense.findUnique({ where: { id: req.params.splitId } });
    if (!split || split.chatId !== chat.id) {
      return res.status(404).json({ error: 'Split expense not found.' });
    }

    if (split.createdByTripId !== req.params.id) {
      return res.status(403).json({ error: 'Only the creator group can delete this split expense.' });
    }

    await db.$transaction(async (tx) => {
      await tx.clubChatSplitExpense.delete({ where: { id: split.id } });
      // For newly created synced records, remove matching ledger entries too.
      await tx.expense.deleteMany({
        where: {
          tripId: split.createdByTripId,
          note: `Auto-synced from club split ${chat.id}:${split.id}`,
        },
      });
      await tx.clubChat.update({ where: { id: chat.id }, data: {} });
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Delete club chat split expense error:', err);
    return res.status(500).json({ error: 'Could not delete split expense.' });
  }
});

// ── ADD CLUB CHAT SPLIT EXPENSE ──────────────────────────
router.post('/:id/club/chats/:chatId/splits', async (req, res) => {
  const desc = String(req.body?.desc || '').trim();
  const amount = Number(req.body?.amount);
  const paidByKey = String(req.body?.paidByKey || '').trim();
  const splitWithKeys = Array.isArray(req.body?.splitWithKeys)
    ? req.body.splitWithKeys.map(v => String(v || '').trim()).filter(Boolean)
    : [];

  if (!desc || !Number.isFinite(amount) || amount <= 0 || !paidByKey || splitWithKeys.length === 0) {
    return res.status(400).json({ error: 'desc, positive amount, paidByKey, and splitWithKeys are required.' });
  }

  try {
    const m = await requireMembership(req.params.id, req.userId);
    if (!m) return res.status(403).json({ error: 'You are not a member of this trip.' });

    const chat = await db.clubChat.findUnique({
      where: { id: req.params.chatId },
      include: {
        tripA: { include: { members: true } },
        tripB: { include: { members: true } },
      },
    });
    if (!chat || (chat.tripAId !== req.params.id && chat.tripBId !== req.params.id)) {
      return res.status(404).json({ error: 'Chat not found.' });
    }

    const validMemberKeys = buildChatMemberKeys(chat);
    if (!validMemberKeys.has(paidByKey) || splitWithKeys.some(key => !validMemberKeys.has(key))) {
      return res.status(400).json({ error: 'Split members are invalid for this combined group.' });
    }

    const memberLookup = buildChatMemberLookup(chat);
    const payer = memberLookup.get(paidByKey);
    if (!payer) {
      return res.status(400).json({ error: 'Payer is invalid for this chat.' });
    }

    const uniqueSplitWithKeys = [...new Set(splitWithKeys)];
    const splitMembers = uniqueSplitWithKeys
      .map((key) => memberLookup.get(key))
      .filter(Boolean);
    const perHead = amount / splitMembers.length;
    const chatLabel = `${chat.tripA.groupName} x ${chat.tripB.groupName}`;

    const participantsByTrip = splitMembers.reduce((acc, member) => {
      if (!acc[member.tripId]) acc[member.tripId] = [];
      acc[member.tripId].push(member.nickname);
      return acc;
    }, {});

    const result = await db.$transaction(async (tx) => {
      const createdSplitExpense = await tx.clubChatSplitExpense.create({
        data: {
          chatId: chat.id,
          desc: desc.slice(0, 160),
          amount,
          paidByKey,
          splitWithKeys: uniqueSplitWithKeys.slice(0, 80),
          createdByTripId: req.params.id,
          createdByUserId: req.userId,
        },
      });

      const syncedExpensePayloads = Object.entries(participantsByTrip)
        .filter(([tripId, splitNames]) => tripId === payer.tripId && splitNames.length > 0)
        .map(([tripId, splitNames]) => ({
          tripId,
          desc: `[Club Chat: ${chatLabel}] ${desc.slice(0, 120)}`,
          amount: Number((perHead * splitNames.length).toFixed(2)),
          paidBy: payer.nickname,
          cat: 'other',
          split: splitNames,
          note: `Auto-synced from club split ${chat.id}:${createdSplitExpense.id}`,
          date: new Date(),
        }));

      const syncedExpenses = [];
      for (const payload of syncedExpensePayloads) {
        // Keep each trip's own ledger in sync with combined chat splits.
        const expense = await tx.expense.create({ data: payload });
        syncedExpenses.push(expense);
      }

      await tx.clubChat.update({ where: { id: chat.id }, data: {} });
      return { createdSplitExpense, syncedExpenses };
    });

    res.status(201).json({
      splitExpense: result.createdSplitExpense,
      syncedExpenses: result.syncedExpenses,
    });
  } catch (err) {
    console.error('Add club chat split expense error:', err);
    res.status(500).json({ error: 'Could not add split expense.' });
  }
});

module.exports = router;
