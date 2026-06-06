// src/routes/recommendations.js
// ═══════════════════════════════════════════════════════════════════
// Destination Recommendations — Hotels, Hospitals, Rentals
//
// GET /ai/recommendations?destination=Udaipur
//
// • Hotels  → Serper Places API (SERPER_RECS_API_KEY)
// • Hospitals → Geoapify Geocode + Places API (GEOAPIFY_API_KEY)
// • Rentals  → Serper Places API (multiple queries)
//
// Results are cached in Postgres per destination for 30 days.
// All users reading the same destination hit the DB — zero live calls.
// ═══════════════════════════════════════════════════════════════════

const express = require('express');
const prisma  = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ─────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────
const SERPER_PLACES_URL   = 'https://google.serper.dev/places';
// Fall back to the main Serper key if the dedicated recs key is not set on
// the deployment host (so Render works without a separate env var)
function serperRecsKey() {
  return process.env.SERPER_RECS_API_KEY || process.env.SERPER_API_KEY || '';
}
const GEOAPIFY_GEOCODE    = 'https://api.geoapify.com/v1/geocode/search';
const GEOAPIFY_PLACES     = 'https://api.geoapify.com/v2/places';
const CACHE_MAX_AGE_MS    = 30 * 24 * 60 * 60 * 1000; // 30 days
const HOSPITAL_RADIUS_M   = 15000; // 15 km radius

// ─────────────────────────────────────────────────────────────────
// SERPER PLACES
// ─────────────────────────────────────────────────────────────────
async function serperPlaces(query) {
  try {
    const res = await fetch(SERPER_PLACES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': serperRecsKey(),
      },
      body: JSON.stringify({ q: query, gl: 'in', hl: 'en' }),
    });
    const data = await res.json();
    return Array.isArray(data.places) ? data.places : [];
  } catch (err) {
    console.warn(`[SERPER_PLACES] "${query}" failed:`, err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────
// GEOAPIFY — geocode city → lat/lon
// ─────────────────────────────────────────────────────────────────
async function geocodeCity(city) {
  const url =
    `${GEOAPIFY_GEOCODE}?text=${encodeURIComponent(city + ', India')}` +
    `&limit=1&apiKey=${process.env.GEOAPIFY_API_KEY}`;
  const res  = await fetch(url);
  const data = await res.json();
  const feat = data.features?.[0];
  if (!feat) throw new Error(`Geocode failed for "${city}"`);
  return { lat: feat.properties.lat, lon: feat.properties.lon };
}

// ─────────────────────────────────────────────────────────────────
// GEOAPIFY — healthcare places near lat/lon
// ─────────────────────────────────────────────────────────────────
async function geoapifyHealthcare(lat, lon) {
  try {
    const cats = [
      'healthcare.hospital',
      'healthcare.clinic_or_praxis',
      'healthcare.pharmacy',
      'healthcare.emergency',
    ].join(',');
    const url =
      `${GEOAPIFY_PLACES}?categories=${cats}` +
      `&filter=circle:${lon},${lat},${HOSPITAL_RADIUS_M}` +
      `&limit=60&apiKey=${process.env.GEOAPIFY_API_KEY}`;
    const res  = await fetch(url);
    const data = await res.json();
    return Array.isArray(data.features) ? data.features : [];
  } catch (err) {
    console.warn('[GEOAPIFY_HEALTHCARE] failed:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────
// CLASSIFIERS
// ─────────────────────────────────────────────────────────────────
function classifyHotelPrice(name = '', serperPriceLevel = '') {
  const n = name.toLowerCase();
  const p = String(serperPriceLevel || '').toLowerCase();

  // Serper returns "$", "$$", "$$$", "$$$$" or descriptive text
  if (/^\$\$\$\$?$/.test(p.trim()) || p.includes('expensive') || p.includes('very pricey')) return 'luxury';
  if (/^\$\$$/.test(p.trim())      || p.includes('moderate') || p.includes('mid'))            return 'mid';
  if (/^\$$/.test(p.trim())        || p.includes('inexpensive') || p.includes('cheap'))        return 'budget';

  // Name-based fallback
  if (/oberoi|taj |leela|aman |ritz|four seasons|palace hotel|marriott|hyatt|hilton|sheraton|ihg|luxury|5[\s-]?star|five[\s-]?star/.test(n)) return 'luxury';
  if (/oyo|zostel|budget|hostel|lodge|guesthouse|dharamshala|dormitory|backpacker|economy|cheap/.test(n)) return 'budget';

  return 'mid';
}

function detect24h(props) {
  const oh   = (props.opening_hours || props.datasource?.raw?.opening_hours || '').toLowerCase();
  const name = (props.name || '').toLowerCase();
  const cats = (props.categories || []).join(' ').toLowerCase();
  return (
    oh.includes('24/7') ||
    oh.includes('00:00-24:00') ||
    oh.includes('24 hours') ||
    cats.includes('emergency') ||
    /24.?hour|24\/7|round.?the.?clock|all.?night/.test(name)
  );
}

function hospitalCategory(cats = []) {
  const c = cats.join(' ').toLowerCase();
  if (c.includes('emergency')) return 'emergency';
  if (c.includes('hospital'))  return 'hospital';
  if (c.includes('pharmacy'))  return 'pharmacy';
  return 'clinic';
}

function classifyRentalType(name = '', queryHint = '') {
  const n = (name + ' ' + queryHint).toLowerCase();
  if (/scooter|scooty|scootie/.test(n))            return 'scooter';
  if (/\bbike\b|bicycle|cycle(?! rental)/.test(n)) return 'bike';
  return 'car';
}

// ─────────────────────────────────────────────────────────────────
// MAIN FETCH — runs all three categories in parallel
// ─────────────────────────────────────────────────────────────────
async function fetchAllRecommendations(destination) {
  const display = destination.charAt(0).toUpperCase() + destination.slice(1);
  console.log(`🔍 [RECS] Fetching recommendations for ${display}…`);

  const [hotelRes, geocodeRes, carRes, bikeRes, scooterRes] = await Promise.allSettled([
    serperPlaces(`top hotels in ${display}`),
    geocodeCity(display),
    serperPlaces(`car rental in ${display}`),
    serperPlaces(`bike rental in ${display}`),
    serperPlaces(`scooter scooty rental in ${display}`),
  ]);

  // ── Hotels ──────────────────────────────────────────────────────
  const hotels = [];
  if (hotelRes.status === 'fulfilled') {
    for (const p of hotelRes.value.slice(0, 80)) {
      if (!p.title) continue;
      hotels.push({
        destination,
        name:          p.title,
        rating:        p.rating        ? parseFloat(p.rating)    : null,
        priceLevel:    classifyHotelPrice(p.title, p.priceLevel || ''),
        pricePerNight: null,
        imageUrl:      p.thumbnailUrl  || null,
        address:       p.address       || null,
        lat:           p.latitude      ? parseFloat(p.latitude)  : null,
        lng:           p.longitude     ? parseFloat(p.longitude) : null,
        amenities:     [],
      });
    }
  }
  console.log(`🏨 [RECS] ${hotels.length} hotels`);

  // ── Hospitals ───────────────────────────────────────────────────
  const hospitals = [];
  if (geocodeRes.status === 'fulfilled') {
    const { lat, lon } = geocodeRes.value;
    const features = await geoapifyHealthcare(lat, lon);
    for (const f of features) {
      const props = f.properties || {};
      if (!props.name) continue;
      hospitals.push({
        destination,
        name:     props.name,
        category: hospitalCategory(props.categories || []),
        is24h:    detect24h(props),
        phone:    props.contact?.phone || props.datasource?.raw?.phone || null,
        address:  props.formatted || props.address_line2 || null,
        lat:      props.lat ? parseFloat(props.lat) : null,
        lng:      props.lon ? parseFloat(props.lon) : null,
      });
    }
  } else {
    console.warn('[RECS] Geocode failed:', geocodeRes.reason?.message);
  }
  console.log(`🏥 [RECS] ${hospitals.length} hospitals/clinics`);

  // ── Rentals ─────────────────────────────────────────────────────
  const rentals = [];
  const seenNames = new Set();

  const addRentals = (result, hint) => {
    if (result.status !== 'fulfilled') return;
    for (const p of result.value.slice(0, 25)) {
      if (!p.title) continue;
      const key = p.title.toLowerCase();
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      rentals.push({
        destination,
        name:    p.title,
        type:    classifyRentalType(p.title, hint),
        rating:  p.rating ? parseFloat(p.rating) : null,
        phone:   p.phoneNumber || null,
        address: p.address     || null,
        lat:     p.latitude    ? parseFloat(p.latitude)  : null,
        lng:     p.longitude   ? parseFloat(p.longitude) : null,
        mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.title + ' ' + display)}`,
      });
    }
  };

  addRentals(carRes,     'car');
  addRentals(bikeRes,    'bike');
  addRentals(scooterRes, 'scooter');
  console.log(`🚗 [RECS] ${rentals.length} rentals`);

  return { hotels, hospitals, rentals };
}

// ─────────────────────────────────────────────────────────────────
// GET /ai/recommendations?destination=Udaipur
// ─────────────────────────────────────────────────────────────────
router.get('/recommendations', async (req, res) => {
  const dest = (req.query.destination || '').trim().toLowerCase();
  if (!dest) return res.status(400).json({ error: 'destination query param is required' });

  try {
    // ── Check cache freshness ──────────────────────────────────────
    const latestHotel = await prisma.destinationHotel.findFirst({
      where:   { destination: dest },
      orderBy: { fetchedAt: 'desc' },
      select:  { fetchedAt: true },
    });

    const isStale =
      !latestHotel ||
      Date.now() - latestHotel.fetchedAt.getTime() > CACHE_MAX_AGE_MS;

    if (!isStale) {
      // ── Serve from DB ──────────────────────────────────────────
      const [hotels, hospitals, rentals] = await Promise.all([
        prisma.destinationHotel.findMany({
          where:   { destination: dest },
          orderBy: [{ rating: 'desc' }],
        }),
        prisma.destinationHospital.findMany({
          where:   { destination: dest },
          orderBy: [{ is24h: 'desc' }, { name: 'asc' }],
        }),
        prisma.destinationRental.findMany({
          where:   { destination: dest },
          orderBy: [{ rating: 'desc' }],
        }),
      ]);
      console.log(`✅ [RECS] Cache hit for "${dest}": ${hotels.length}H ${hospitals.length}Hosp ${rentals.length}R`);
      return res.json({
        hotels, hospitals, rentals,
        destination: dest,
        fromCache: true,
        cachedAt:  latestHotel.fetchedAt,
      });
    }

    // ── Fetch fresh data ───────────────────────────────────────────
    const { hotels, hospitals, rentals } = await fetchAllRecommendations(dest);

    // ── Persist to DB (atomic replace) ────────────────────────────
    await prisma.$transaction(async (tx) => {
      await tx.destinationHotel.deleteMany({ where: { destination: dest } });
      await tx.destinationHospital.deleteMany({ where: { destination: dest } });
      await tx.destinationRental.deleteMany({ where: { destination: dest } });
      if (hotels.length)    await tx.destinationHotel.createMany({ data: hotels });
      if (hospitals.length) await tx.destinationHospital.createMany({ data: hospitals });
      if (rentals.length)   await tx.destinationRental.createMany({ data: rentals });
    });

    console.log(`✅ [RECS] Stored fresh data for "${dest}": ${hotels.length}H ${hospitals.length}Hosp ${rentals.length}R`);
    return res.json({
      hotels, hospitals, rentals,
      destination: dest,
      fromCache: false,
    });

  } catch (err) {
    console.error('[RECS] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch recommendations' });
  }
});

module.exports = router;
