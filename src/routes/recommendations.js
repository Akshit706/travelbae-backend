// src/routes/recommendations.js
// ═══════════════════════════════════════════════════════════════════
// Destination Recommendations — Stays, Healthcare, Rentals
//
// GET /ai/recommendations?destination=Udaipur[&refresh=1]
//
// Stays    → 8 targeted Serper Places queries covering every tier
// Hospitals → Geoapify (primary) + 3 Serper queries (fallback/supplement)
// Rentals   → 3 Serper Places queries (car / bike / scooter)
//
// Cache: Postgres via Prisma for 30 days — zero live calls for users.
// Images: uploaded to ImageKit on first fetch, stored as IK URLs.
// ═══════════════════════════════════════════════════════════════════

const express = require('express');
const sb      = require('../lib/supabase');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const SERPER_PLACES_URL = 'https://google.serper.dev/places';
const GEOAPIFY_GEOCODE  = 'https://api.geoapify.com/v1/geocode/search';
const GEOAPIFY_PLACES   = 'https://api.geoapify.com/v2/places';
const IK_UPLOAD_URL     = 'https://upload.imagekit.io/api/v1/files/upload';
const CACHE_MAX_AGE_MS  = 30 * 24 * 60 * 60 * 1000;
const HOSP_RADIUS_M     = 20000;

function serperKey()   { return process.env.SERPER_RECS_API_KEY || process.env.SERPER_API_KEY || ''; }
function geoapifyKey() { return process.env.GEOAPIFY_API_KEY || ''; }
function ikEnabled()   { return !!(process.env.IMAGEKIT_PRIVATE_KEY && process.env.IMAGEKIT_URL_ENDPOINT); }
function ikAuth()      { return 'Basic ' + Buffer.from((process.env.IMAGEKIT_PRIVATE_KEY || '') + ':').toString('base64'); }

// ─── Serper Places ───────────────────────────────────────────────
async function serperPlaces(query) {
  try {
    const res  = await fetch(SERPER_PLACES_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': serperKey() },
      body:    JSON.stringify({ q: query, gl: 'in', hl: 'en' }),
    });
    const data = await res.json();
    if (!Array.isArray(data.places)) { if (data.error) console.warn(`[SERPER] "${query}":`, data.error); return []; }
    return data.places;
  } catch (e) { console.warn(`[SERPER] "${query}" failed:`, e.message); return []; }
}

// ─── ImageKit upload ─────────────────────────────────────────────
function ikFilename(name, dest) {
  return ('tb_' + dest + '_' + name).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 100);
}
async function uploadToIK(srcUrl, filename) {
  if (!ikEnabled() || !srcUrl) return srcUrl;
  try {
    const form = new FormData();
    form.append('file', srcUrl); form.append('fileName', filename + '.jpg');
    form.append('folder', '/tb-places'); form.append('useUniqueFileName', 'false');
    const res  = await fetch(IK_UPLOAD_URL, { method: 'POST', headers: { Authorization: ikAuth() }, body: form, signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    return data.url || srcUrl;
  } catch { return srcUrl; }
}
async function batchIK(items, limit = 5) {
  const map = new Map();
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(async it => {
      map.set(it.name, await uploadToIK(it.imageUrl, ikFilename(it.name, it.dest)));
    }));
  }
  return map;
}

// ─── Fetch hotel images via Serper Images (up to 5 per hotel) ───────
// Fetches for ALL hotels (cover + gallery), stored as h.images[].
// Runs in parallel batches for up to 20 hotels.
async function fetchHotelImages(hotels) {
  const SERPER_IMAGES_URL = 'https://google.serper.dev/images';
  const key = process.env.SERPER_PHOTOS_API_KEY || serperKey();
  if (!key) return;
  const toFetch = hotels.slice(0, 20);
  await Promise.allSettled(toFetch.map(async h => {
    try {
      const queries = [
        `${h.name} hotel exterior`,
        `${h.name} hotel room interior`,
      ];
      const imgs = [];
      for (const q of queries) {
        if (imgs.length >= 5) break;
        const res = await fetch(SERPER_IMAGES_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
          body: JSON.stringify({ q, num: 5, gl: 'in', hl: 'en' }),
          signal: AbortSignal.timeout(7000),
        });
        const data = await res.json();
        const valid = (data.images || [])
          .filter(i => i.imageUrl && /\.(jpg|jpeg|png|webp)/i.test(i.imageUrl))
          .map(i => i.imageUrl);
        imgs.push(...valid);
      }
      h.images = [...new Set(imgs)].slice(0, 5);
      if (!h.imageUrl && h.images.length) h.imageUrl = h.images[0];
    } catch { /* ignore */ }
  }));
}

// ─── Supplement missing phone numbers via Serper web search ──────────
async function fetchMissingPhones(hotels, city) {
  const SERPER_SEARCH_URL = 'https://google.serper.dev/search';
  const key = serperKey();
  if (!key) return;
  const noPhone = hotels.filter(h => !h.phone).slice(0, 12);
  if (!noPhone.length) return;
  const PHONE_RE = /(?:\+91[-\s]?|0)?[6-9]\d{9}/g;
  await Promise.allSettled(noPhone.map(async h => {
    try {
      const res = await fetch(SERPER_SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
        body: JSON.stringify({ q: `"${h.name}" ${city} hotel phone number contact`, num: 3, gl: 'in', hl: 'en' }),
        signal: AbortSignal.timeout(6000),
      });
      const data = await res.json();
      // Try knowledge graph first (most reliable)
      const kgPhone = data.knowledgeGraph?.attributes?.Phone || data.knowledgeGraph?.phone;
      if (kgPhone) { h.phone = kgPhone.trim(); return; }
      // Scan organic result snippets
      const text = (data.organic || []).slice(0, 3).map(r => (r.snippet || '')).join(' ');
      const matches = text.match(PHONE_RE);
      if (matches && matches[0]) h.phone = matches[0];
    } catch { /* ignore */ }
  }));
}

// ─── Geoapify ────────────────────────────────────────────────────
async function geocodeCity(city) {
  const url  = `${GEOAPIFY_GEOCODE}?text=${encodeURIComponent(city + ' India')}&limit=1&apiKey=${geoapifyKey()}`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const data = await res.json();
  const f    = data.features?.[0];
  if (!f) throw new Error(`Geocode failed for "${city}"`);
  return { lat: f.properties.lat, lon: f.properties.lon };
}
async function geoapifyHealthcare(lat, lon) {
  const cats = 'healthcare.hospital,healthcare.clinic_or_praxis,healthcare.pharmacy,healthcare.emergency';
  const url  = `${GEOAPIFY_PLACES}?categories=${cats}&filter=circle:${lon},${lat},${HOSP_RADIUS_M}&limit=80&apiKey=${geoapifyKey()}`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const data = await res.json();
  return Array.isArray(data.features) ? data.features : [];
}

// ─── Classifiers ─────────────────────────────────────────────────
function classifyStayType(name, hint) {
  const n = (name + ' ' + hint).toLowerCase();
  if (/hostel|dorm|bunk|backpacker|zostel|moustache hostel|so hostel/.test(n)) return 'hostel';
  if (/homestay|home stay|b&b|bed.?breakfast|farmstay|villa|cottage|pg |paying guest/.test(n)) return 'guesthouse';
  if (/resort|palace|haveli|fort hotel|heritage hotel|castle|spa resort|safari|camp|tented|eco resort|jungle|treehouse/.test(n)) return 'resort';
  return 'hotel';
}
function classifyPrice(name, stayType, hint) {
  const n = (name + ' ' + hint).toLowerCase();
  if (stayType === 'hostel') return 'budget';
  if (/oberoi|taj \b|leela|aman\b|ritz|four seasons|marriott|hyatt|hilton|sheraton|westin|itc \b|vivanta|radisson|intercontinental|palace hotel|grand hyatt|luxury|5[\s-]?star|five[\s-]?star|premium|royal\b|regal\b/.test(n)) return 'luxury';
  if (stayType === 'resort') return /budget|economy|cheap/.test(n) ? 'mid' : 'luxury';
  if (/oyo|zostel|treebo|budget|lodge\b|dharamshala|economy|cheap|affordable|backpacker|under 1000|value inn/.test(n)) return 'budget';
  if (stayType === 'guesthouse') return 'budget';
  return 'mid';
}
function priceLbl(level, type) {
  if (type  === 'hostel')   return '₹400 – ₹900 / bed';
  if (level === 'budget')   return '₹800 – ₹2,500 / night';
  if (level === 'luxury')   return '₹6,000 – ₹25,000 / night';
  return '₹2,500 – ₹6,000 / night';
}
function detect24h(name, cats, oh) {
  const s = (name + ' ' + (cats||[]).join(' ') + ' ' + (oh||'')).toLowerCase();
  return /24.?hour|24\/7|round.?the.?clock|all.?night|00:00-24:00|emergency/.test(s);
}
function hospCat(name, cats) {
  const s = (name + ' ' + (cats||[]).join(' ')).toLowerCase();
  if (/emergency|trauma|casualty/.test(s)) return 'emergency';
  if (/\bhospital\b/.test(s))              return 'hospital';
  if (/pharmacy|chemist|drug store|medical store/.test(s)) return 'pharmacy';
  return 'clinic';
}
function rentalType(name, hint) {
  const n = (name + ' ' + hint).toLowerCase();
  if (/scooter|scooty/.test(n))                                    return 'scooter';
  if (/\bbike\b|motorcycle|motorbike|two.?wheel|enfield|pulsar/.test(n)) return 'bike';
  return 'car';
}

// ─── Serper hospital fallback ────────────────────────────────────
async function serperHospitals(city, dest) {
  const [a, b, c] = await Promise.allSettled([
    serperPlaces(`hospitals nursing home medical center in ${city}`),
    serperPlaces(`24 hour emergency clinic casualty in ${city}`),
    serperPlaces(`pharmacy chemist medical store in ${city}`),
  ]);
  const out = []; const seen = new Set();
  const add = (res, catHint) => {
    if (res.status !== 'fulfilled') return;
    for (const p of res.value) {
      if (!p.title) continue;
      const key = p.title.toLowerCase().trim();
      if (seen.has(key)) continue; seen.add(key);
      out.push({ destination: dest, name: p.title, category: hospCat(p.title, [catHint]),
        is24h: detect24h(p.title, [catHint], p.description||''), phone: p.phoneNumber||null,
        address: p.address||null, lat: p.latitude?parseFloat(p.latitude):null, lng: p.longitude?parseFloat(p.longitude):null });
    }
  };
  add(a,'hospital'); add(b,'emergency'); add(c,'pharmacy');
  return out;
}

// ─── Main fetch ───────────────────────────────────────────────────
async function fetchAll(dest) {
  const city = dest.charAt(0).toUpperCase() + dest.slice(1);
  console.log(`🔍 [RECS] Fetching fresh data for "${city}"…`);

  const hasGeoapify = geoapifyKey().length > 0;
  const [h0,h1,h2,h3,h4,h5,h6,h7, geoR, rc,rb,rs] = await Promise.allSettled([
    serperPlaces(`best hotels in ${city}`),
    serperPlaces(`cheap budget hotel under 1000 in ${city}`),
    serperPlaces(`hostel dormitory backpacker stay in ${city}`),
    serperPlaces(`OYO rooms treebo guesthouse lodge in ${city}`),
    serperPlaces(`homestay bed breakfast farmstay in ${city}`),
    serperPlaces(`3 star mid range hotel in ${city}`),
    serperPlaces(`boutique heritage hotel in ${city}`),
    serperPlaces(`luxury 5 star palace resort in ${city}`),
    hasGeoapify ? geocodeCity(city) : Promise.reject(new Error('No Geoapify key')),
    serperPlaces(`car taxi self drive rental in ${city}`),
    serperPlaces(`bike motorcycle rental in ${city}`),
    serperPlaces(`scooter scooty rental in ${city}`),
  ]);

  // Hotels
  const hotelSeen = new Set(); const hotels = [];
  const pairs = [[h0,''],[h1,'budget'],[h2,'hostel'],[h3,'budget'],[h4,'guesthouse'],[h5,'mid'],[h6,'boutique'],[h7,'luxury']];
  for (const [res, hint] of pairs) {
    if (res.status !== 'fulfilled') continue;
    for (const p of res.value) {
      if (!p.title) continue;
      const key = p.title.toLowerCase().trim();
      if (hotelSeen.has(key)) continue; hotelSeen.add(key);
      const st  = classifyStayType(p.title, hint);
      const pl  = classifyPrice(p.title, st, hint);
      hotels.push({ destination:dest, name:p.title, rating:p.rating?parseFloat(p.rating):null,
        stayType:st, priceLevel:pl, pricePerNight:priceLbl(pl,st),
        imageUrl:p.thumbnailUrl||null, address:p.address||null,
        lat:p.latitude?parseFloat(p.latitude):null, lng:p.longitude?parseFloat(p.longitude):null, amenities:[] });
    }
  }
  console.log(`🏨 [RECS] ${hotels.length} stays`);

  // Fill missing images via Serper Images (up to 5 per hotel)
  await fetchHotelImages(hotels);
  // Supplement missing phone numbers via web search
  await fetchMissingPhones(hotels, city);

  // Upload hotel images to IK
  if (ikEnabled()) {
    const withImg = hotels.filter(h=>h.imageUrl).slice(0,30);
    const ikMap   = await batchIK(withImg.map(h=>({name:h.name,dest,imageUrl:h.imageUrl})));
    for (const h of hotels) { if (ikMap.has(h.name)) h.imageUrl = ikMap.get(h.name); }
    console.log(`📸 [RECS] IK done for ${withImg.length} hotel images`);
  }

  // Hospitals
  let hospitals = [];
  if (geoR.status === 'fulfilled') {
    try {
      const {lat,lon} = geoR.value;
      const feats = await geoapifyHealthcare(lat, lon);
      const seen  = new Set();
      for (const f of feats) {
        const p = f.properties||{}; if (!p.name) continue;
        const key = p.name.toLowerCase().trim(); if (seen.has(key)) continue; seen.add(key);
        const oh = p.opening_hours||p.datasource?.raw?.opening_hours||'';
        hospitals.push({ destination:dest, name:p.name, category:hospCat(p.name,p.categories||[]),
          is24h:detect24h(p.name,p.categories||[],oh), phone:p.contact?.phone||p.datasource?.raw?.phone||null,
          address:p.formatted||p.address_line2||null,
          lat:p.lat?parseFloat(p.lat):null, lng:p.lon?parseFloat(p.lon):null });
      }
      console.log(`🏥 [RECS] ${hospitals.length} via Geoapify`);
    } catch(e) { console.warn('[RECS] Geoapify healthcare error:', e.message); }
  } else { console.warn('[RECS] Geocode skipped:', geoR.reason?.message); }

  // Supplement with Serper
  const serperH  = await serperHospitals(city, dest);
  const hospSeen = new Set(hospitals.map(h=>h.name.toLowerCase().trim()));
  for (const h of serperH) {
    const key = h.name.toLowerCase().trim();
    if (!hospSeen.has(key)) { hospSeen.add(key); hospitals.push(h); }
  }
  const catOrd = {emergency:0,hospital:1,clinic:2,pharmacy:3};
  hospitals.sort((a,b)=>{if(b.is24h!==a.is24h)return Number(b.is24h)-Number(a.is24h);return(catOrd[a.category]??4)-(catOrd[b.category]??4);});
  console.log(`🏥 [RECS] ${hospitals.length} total healthcare`);

  // Rentals
  const rentals = []; const rentalSeen = new Set();
  const addR = (res, hint) => {
    if (res.status !== 'fulfilled') return;
    for (const p of res.value.slice(0,20)) {
      if (!p.title) continue;
      const key = p.title.toLowerCase().trim(); if (rentalSeen.has(key)) continue; rentalSeen.add(key);
      rentals.push({ destination:dest, name:p.title, type:rentalType(p.title,hint),
        rating:p.rating?parseFloat(p.rating):null, phone:p.phoneNumber||null, address:p.address||null,
        lat:p.latitude?parseFloat(p.latitude):null, lng:p.longitude?parseFloat(p.longitude):null,
        mapsUrl:`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.title+' '+city)}` });
    }
  };
  addR(rc,'car'); addR(rb,'bike'); addR(rs,'scooter');
  console.log(`🚗 [RECS] ${rentals.length} rentals`);
  return { hotels, hospitals, rentals };
}

// ─── Route ───────────────────────────────────────────────────────
router.get('/recommendations', async (req, res) => {
  const dest    = (req.query.destination || '').trim().toLowerCase();
  const refresh = req.query.refresh === '1';
  if (!dest) return res.status(400).json({ error: 'destination required' });

  try {
    // ── Check Supabase cache ──────────────────────────────────
    if (!refresh) {
      try {
        const { data: cached, error: cacheErr } = await sb
          .from('destination_recommendations')
          .select('data, updated_at')
          .eq('destination', dest)
          .maybeSingle();
        if (cached && !cacheErr) {
          const age       = Date.now() - new Date(cached.updated_at).getTime();
          const hospCount = (cached.data?.hospitals || []).length;
          const hasImages = (cached.data?.hotels || []).some(h => Array.isArray(h.images) && h.images.length > 0);
          if (age < CACHE_MAX_AGE_MS && hospCount > 0 && hasImages) {
            console.log(`⚡ [RECS] Cache hit "${dest}": ${cached.data.hotels?.length}H ${hospCount}Hosp ${cached.data.rentals?.length}R`);
            return res.json({ ...cached.data, destination: dest, fromCache: true, cachedAt: cached.updated_at });
          }
          console.log(`🔄 [RECS] Stale / empty hospitals for "${dest}" — refreshing`);
        }
        if (cacheErr) console.warn('[RECS] Supabase read error:', cacheErr.message);
      } catch (cacheReadErr) {
        console.warn('[RECS] Supabase read failed, fetching fresh:', cacheReadErr.message);
      }
    }

    // ── Fetch fresh data ──────────────────────────────────────
    const { hotels, hospitals, rentals } = await fetchAll(dest);

    // ── Persist to Supabase ───────────────────────────────────
    try {
      const { error: writeErr } = await sb
        .from('destination_recommendations')
        .upsert({ destination: dest, data: { hotels, hospitals, rentals }, updated_at: new Date().toISOString() });
      if (writeErr) throw writeErr;
      console.log(`💾 [RECS] Saved to Supabase: "${dest}" — ${hotels.length}H ${hospitals.length}Hosp ${rentals.length}R`);
    } catch (dbErr) {
      console.warn('[RECS] Supabase write failed (non-fatal):', dbErr.message);
    }

    return res.json({ hotels, hospitals, rentals, destination: dest, fromCache: false });
  } catch (err) {
    console.error('[RECS] Error:', err);
    res.status(500).json({ error: err.message || 'Failed' });
  }
});

module.exports = router;
