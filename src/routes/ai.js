// src/routes/ai.js
// ═══════════════════════════════════════════════════════════════════
// Enhanced AI pipeline: Serper (multi-query) → web_fetch (top pages)
// → Gemini structured extraction → itinerary/local-taste generation
//
// POST /ai/chat          — trip chatbot
// POST /ai/itinerary     — research-backed itinerary (2-phase)
// POST /ai/local-taste   — local food + places + experiences
// GET  /ai/photos        — Wikimedia place photos
// ═══════════════════════════════════════════════════════════════════

const express = require('express');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ─────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────
const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
const SERPER_URL = 'https://google.serper.dev/search';

// How many top Serper results to deep-fetch for page content
const FETCH_TOP_N = 3;

// Domains we skip fetching (aggregators, video, social — snippets only)
const SKIP_FETCH_DOMAINS = [
  'youtube.com', 'facebook.com', 'instagram.com', 'twitter.com',
  'reddit.com', 'tripadvisor.com', 'tripadvisor.in', 'makemytrip.com',
  'klook.com', 'viator.com', 'getyourguide.com', 'booking.com',
  'agoda.com', 'expedia.com',
];

// Domains we prefer fetching (high-quality editorial)
const PREFER_FETCH_DOMAINS = [
  'lonelyplanet.com', 'nomadicmatt.com', 'wikivoyage.org',
  'condénast.com', 'travelandleisure.com', 'timeout.com',
  'eatingthaifood.com', 'midnightblueelephant.com',
  'notquitenigella.com', 'marionskitchen.com',
  'guide.michelin.com', 'breathedreamgo.com',
  'passionforhospitality.net',
];

// ─────────────────────────────────────────────────────────────────
// GEMINI CORE CALLER
// ─────────────────────────────────────────────────────────────────
async function callGemini({ system, messages, maxTokens = 1000, temperature = 0.7 }) {
  const contents = [];

  if (system) {
    contents.push({ role: 'user',  parts: [{ text: `[System instructions]: ${system}` }] });
    contents.push({ role: 'model', parts: [{ text: 'Understood. I will follow those instructions.' }] });
  }

  for (const msg of messages) {
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    });
  }

  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      generationConfig: { maxOutputTokens: maxTokens, temperature },
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(`Gemini error: ${data.error.message}`);
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ─────────────────────────────────────────────────────────────────
// SERPER — MULTI-QUERY SEARCH
// fires multiple targeted queries in parallel, deduplicates results
// ─────────────────────────────────────────────────────────────────
async function serperMultiSearch(queries, numPerQuery = 8) {
  console.log(`🔍 [SERPER] Firing ${queries.length} searches:`, queries);

  const results = await Promise.allSettled(
    queries.map(q =>
      fetch(SERPER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': process.env.SERPER_API_KEY,
        },
        body: JSON.stringify({ q, num: numPerQuery, gl: 'in', hl: 'en' }),
      }).then(r => r.json())
    )
  );

  const seen = new Set();
  const allResults = [];

  for (const outcome of results) {
    if (outcome.status !== 'fulfilled') continue;
    const data = outcome.value;

    // Knowledge graph (only once, from first result with one)
    if (data.knowledgeGraph && !seen.has('__kg__')) {
      seen.add('__kg__');
      const kg = data.knowledgeGraph;
      allResults.push({
        type: 'knowledge_graph',
        title: kg.title,
        description: kg.description || '',
        attributes: kg.attributes || {},
        url: kg.website || '',
      });
    }

    for (const r of (data.organic || [])) {
      if (seen.has(r.link)) continue;
      seen.add(r.link);
      allResults.push({
        type: 'organic',
        title: r.title || '',
        url: r.link || '',
        snippet: r.snippet || '',
        sitelinks: (r.sitelinks || []).map(s => s.snippet || s.title).filter(Boolean),
      });
    }
  }

  console.log(`✅ [SERPER] ${allResults.length} deduplicated results from ${queries.length} queries`);
  return allResults;
}

// ─────────────────────────────────────────────────────────────────
// WEB FETCH — pull actual page content from top editorial sources
// ─────────────────────────────────────────────────────────────────
function shouldFetch(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace('www.', '');
    if (SKIP_FETCH_DOMAINS.some(d => host.includes(d))) return false;
    return true;
  } catch {
    return false;
  }
}

function preferScore(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '');
    return PREFER_FETCH_DOMAINS.some(d => host.includes(d)) ? 1 : 0;
  } catch {
    return 0;
  }
}

async function fetchPageContent(url, maxChars = 4000) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'TravelBae/1.0 (travel planning app)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const html = await res.text();

    // Strip tags, scripts, styles — extract readable text
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s{3,}/g, '\n\n')
      .trim()
      .slice(0, maxChars);

    return text || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// RESEARCH ASSEMBLER
// Combines snippets + fetched page content into rich context
// ─────────────────────────────────────────────────────────────────
async function buildResearchContext(searchResults, destination) {
  // Sort: prefer editorial sources first
  const organic = searchResults.filter(r => r.type === 'organic');
  const sorted = [...organic].sort((a, b) => preferScore(b.url) - preferScore(a.url));

  // Pick top N fetchable URLs
  const toFetch = sorted
    .filter(r => shouldFetch(r.url))
    .slice(0, FETCH_TOP_N);

  console.log(`🌐 [FETCH] Fetching ${toFetch.length} pages:`, toFetch.map(r => r.url));

  const fetched = await Promise.allSettled(
    toFetch.map(r => fetchPageContent(r.url))
  );

  // Build context string
  let context = '';

  // Knowledge graph first
  const kg = searchResults.find(r => r.type === 'knowledge_graph');
  if (kg) {
    context += `## About ${kg.title}\n${kg.description}\n`;
    if (Object.keys(kg.attributes).length) {
      context += Object.entries(kg.attributes).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n\n';
    }
  }

  // Full page content from editorial sources
  context += `## Detailed Research (from travel publications)\n`;
  let fetchedCount = 0;
  for (let i = 0; i < toFetch.length; i++) {
    const result = fetched[i];
    const source = toFetch[i];
    if (result.status === 'fulfilled' && result.value) {
      fetchedCount++;
      const host = new URL(source.url).hostname.replace('www.', '');
      context += `\n### Source: ${host}\nURL: ${source.url}\n${result.value}\n`;
    }
  }
  console.log(`✅ [FETCH] Successfully fetched ${fetchedCount}/${toFetch.length} pages`);

  // All snippets as supplementary
  context += `\n## Search Result Snippets (supplementary)\n`;
  for (const r of organic.slice(0, 15)) {
    const host = (() => { try { return new URL(r.url).hostname.replace('www.', ''); } catch { return r.url; } })();
    context += `\n[${host}] ${r.title}\n${r.snippet}`;
    if (r.sitelinks?.length) context += `\nMore: ${r.sitelinks.slice(0, 2).join(' | ')}`;
    context += '\n';
  }

  console.log(`📄 [CONTEXT] Total research context: ${context.length} chars`);
  return { context, sources: organic.slice(0, 10).map(r => ({ title: r.title, url: r.url })) };
}

// ─────────────────────────────────────────────────────────────────
// JSON UTILITIES
// ─────────────────────────────────────────────────────────────────
function extractJson(text) {
  const clean = String(text || '').replace(/```json|```/gi, '').trim();
  const start = clean.indexOf('{');
  if (start === -1) throw new Error('No JSON found');

  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < clean.length; i++) {
    const ch = clean[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) return clean.slice(start, i + 1); }
  }
  const end = clean.lastIndexOf('}');
  if (end > start) return clean.slice(start, end + 1);
  throw new Error('Incomplete JSON');
}

function parseJson(text) {
  const candidate = extractJson(text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(candidate);
}

async function parseOrRepair(rawText, shape) {
  try {
    return parseJson(rawText);
  } catch (firstErr) {
    console.warn(`⚠️ [JSON] Parse failed, attempting Gemini repair for: ${shape}`);
    try {
      const repaired = await callGemini({
        messages: [{
          role: 'user',
          content: `Fix this malformed JSON. Return ONLY valid JSON, no markdown, no explanation.\n\nMALFORMED:\n${String(rawText).slice(0, 50000)}`,
        }],
        maxTokens: 8000,
        temperature: 0,
      });
      return parseJson(repaired);
    } catch {
      throw firstErr;
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// CHATBOT
// ─────────────────────────────────────────────────────────────────
router.post('/chat', async (req, res) => {
  const { system, messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required.' });
  }
  try {
    const reply = await callGemini({ system, messages, maxTokens: 500 });
    res.json({ reply });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'AI service unavailable.' });
  }
});

// ─────────────────────────────────────────────────────────────────
// ITINERARY — 3-phase pipeline
//
// Phase 1: Multi-query Serper → web_fetch editorial sources → rich context
// Phase 2: Gemini structured extraction → clean JSON research data
// Phase 3: Gemini itinerary builder → final JSON itinerary
// ─────────────────────────────────────────────────────────────────
router.post('/itinerary', async (req, res) => {
  const {
    destination, days, budget, people = 1,
    interests = [], customDescription,
    arrivalSlot, departureSlot,
  } = req.body;

  if (!destination || !days) {
    return res.status(400).json({ error: 'destination and days are required.' });
  }

  const budgetPerDay = budget ? Math.round(budget / days) : null;
  const interestStr = interests.length
    ? interests.map(i => i.replace(/^[^\w]+/, '').trim()).join(', ')
    : 'sightseeing, food, culture, local experiences';

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🗺️  ITINERARY: ${destination} | ${days} days | ${interestStr}`);
  console.log(`${'═'.repeat(60)}`);

  try {
    // ── PHASE 1: RESEARCH ──────────────────────────────────────────
    console.log('\n📡 PHASE 1: Research');

    // Targeted queries — specific beats generic
    const searchQueries = [
      `${destination} top attractions things to do travel guide`,
      `${destination} best restaurants local food street food where to eat`,
      `${destination} hidden gems offbeat local tips travel`,
      `${destination} travel tips practical guide transport budget`,
    ];

    const searchResults = await serperMultiSearch(searchQueries, 8);
    const { context: researchContext, sources } = await buildResearchContext(searchResults, destination);

    // ── PHASE 2: STRUCTURED EXTRACTION ────────────────────────────
    console.log('\n🧠 PHASE 2: Structured extraction');

    const extractionPrompt = `You are a travel data analyst. Extract structured, factual travel information from the research context below.

DESTINATION: ${destination}
${budget ? `BUDGET: ₹${budget} total (₹${budgetPerDay}/day) for ${people} person(s)` : ''}
INTERESTS: ${interestStr}

RESEARCH CONTEXT:
${researchContext}

Extract and return ONLY valid JSON (no markdown, no backticks):
{
  "destination_overview": "2-3 sentence overview of the destination",
  "best_time_to_visit": "specific months and why",
  "practical_tips": ["tip1", "tip2", "tip3", "tip4", "tip5"],
  "getting_around": "transport options and costs",
  "average_costs": {
    "budget_meal": "₹XX",
    "mid_range_meal": "₹XX",
    "attraction_entry": "₹XX average",
    "local_transport_per_day": "₹XX"
  },
  "attractions": [
    {
      "name": "exact place name",
      "type": "temple|museum|market|beach|viewpoint|park|heritage|experience",
      "rating": "4.5",
      "area": "neighbourhood or area",
      "opening_hours": "9 AM – 6 PM",
      "entry_fee": "₹200 or Free",
      "duration": "1-2 hours",
      "best_for": "what it's famous for",
      "insider_tip": "specific tip tourists miss",
      "priority": "must_do|recommended|if_time_permits"
    }
  ],
  "restaurants": [
    {
      "name": "exact restaurant/stall name",
      "type": "street_food|casual|fine_dining|cafe|market",
      "area": "neighbourhood",
      "specialty": "specific dish to order",
      "price_range": "₹XX–₹XX per person",
      "best_meal": "breakfast|lunch|dinner|anytime",
      "insider_tip": "what to order, when to go",
      "priority": "must_try|recommended|if_time_permits"
    }
  ],
  "local_experiences": [
    {
      "name": "experience name",
      "description": "what it involves",
      "when": "best time",
      "cost": "₹XX or free",
      "insider_tip": "specific detail"
    }
  ],
  "areas_to_stay": ["area1 — why", "area2 — why"],
  "what_to_avoid": ["avoid1", "avoid2", "avoid3"]
}

Return maximum 20 attractions, 12 restaurants, 6 local_experiences.
Use ONLY information from the research context. If a detail is not in the context, omit that field rather than guessing.`;

    const extractionText = await callGemini({
      messages: [{ role: 'user', content: extractionPrompt }],
      maxTokens: 6000,
      temperature: 0, // Zero temperature — pure extraction, no hallucination
    });

    let structuredData;
    try {
      structuredData = await parseOrRepair(extractionText, 'structured travel data');
      console.log(`✅ [PHASE 2] Extracted: ${structuredData.attractions?.length || 0} attractions, ${structuredData.restaurants?.length || 0} restaurants`);
    } catch (e) {
      console.warn('⚠️ [PHASE 2] Extraction parse failed, using raw context for Phase 3');
      structuredData = null;
    }

    // ── PHASE 3: ITINERARY BUILD ───────────────────────────────────
    console.log('\n🗓️  PHASE 3: Itinerary build');

    const researchInput = structuredData
      ? JSON.stringify(structuredData, null, 2)
      : researchContext.slice(0, 8000);

    const SLOT_LABELS = { night: '12AM–6AM', morning: '6AM–12PM', afternoon: '12PM–6PM', evening: '6PM–12AM' };
    const arrivalLabel = arrivalSlot ? SLOT_LABELS[arrivalSlot] : 'morning';
    const departureLabel = departureSlot ? SLOT_LABELS[departureSlot] : 'morning';

    const itineraryPrompt = `You are an expert travel planner. Build a PERFECT ${days}-day itinerary for ${destination} using ONLY the structured research data below. Do not invent places not mentioned in the data.

STRUCTURED RESEARCH DATA:
${researchInput}

TRIP DETAILS:
- Destination: ${destination}
- Duration: ${days} days
- People: ${people}
- Budget: ${budget ? `₹${budget} total (₹${budgetPerDay}/day for the group)` : 'flexible'}
- Interests: ${interestStr}
- Arrival slot: Day 1 ${arrivalLabel}
- Departure slot: Day ${days} ${departureLabel}
${customDescription ? `\n- TRAVELLER'S SPECIAL INSTRUCTIONS (highest priority, override defaults if needed):\n  "${customDescription}"` : ''}

PLANNING RULES:
1. GEOGRAPHY FIRST — cluster nearby places on the same day, minimise backtracking
2. MORNING = popular/crowded spots (beat the queues); AFTERNOON = leisurely; EVENING = food, markets, sunset
3. Day 1: arrival + gentle orientation + nearby dinner. Day ${days}: checkout-friendly, near transport hub
4. Every meal slot (breakfast, lunch, dinner) must name a specific restaurant/stall from the research + what to order
5. At least one "local experience" or hidden gem per day
6. Respect the budget — note costs per activity, skip expensive options if budget is tight
7. Add a "pro_tip" per day that most tourists miss
8. Weather note per day if data is available

Return ONLY valid JSON, no markdown, no backticks, no comments:
{
  "headline": "compelling ${days}-day title",
  "summary": "2-sentence hook summary of what makes this itinerary special",
  "totalEstimatedCost": "₹XX,XXX",
  "bestTimeToVisit": "string",
  "quickTips": ["actionable tip 1", "tip 2", "tip 3", "tip 4"],
  "days": [
    {
      "day": 1,
      "title": "Theme title e.g. Old City & Street Food Trail",
      "theme": "one-line mood",
      "estimatedCost": "₹X,XXX",
      "proTip": "one insider tip most tourists miss",
      "weather": { "high": 32, "low": 24, "condition": "Sunny", "tip": "Carry water" },
      "activities": [
        {
          "time": "08:00 AM",
          "name": "Exact place name from research",
          "type": "attraction|food|experience|transport|hotel|shopping",
          "duration": "1.5 hours",
          "note": "specific insider detail — what to see, what to order, hidden detail",
          "cost": "₹200 per person",
          "rating": "4.7 ⭐",
          "icon": "🏰",
          "mustDo": true,
          "area": "neighbourhood"
        }
      ]
    }
  ]
}`;

    const itineraryText = await callGemini({
      messages: [{ role: 'user', content: itineraryPrompt }],
      maxTokens: 8000,
      temperature: 0.3, // Low-ish — creative but grounded
    });

    console.log(`✅ [PHASE 3] Itinerary text length: ${itineraryText.length} chars`);

    const itinerary = await parseOrRepair(itineraryText, 'itinerary');

    console.log(`🎉 [ITINERARY] Done — ${itinerary.days?.length || 0} days, ${itinerary.days?.reduce((s, d) => s + (d.activities?.length || 0), 0) || 0} activities`);

    res.json({ itinerary, sources });

  } catch (err) {
    console.error('❌ Itinerary error:', err.message, err.stack);
    res.status(500).json({ error: 'Could not generate itinerary. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────
// LOCAL TASTE — 2-phase: search+fetch → extract → structured output
// ─────────────────────────────────────────────────────────────────
router.post('/local-taste', async (req, res) => {
  const { destination } = req.body;
  if (!destination) return res.status(400).json({ error: 'destination is required.' });

  console.log(`\n🍜 LOCAL TASTE: ${destination}`);

  try {
    // Phase 1: Targeted food searches
    const searchResults = await serperMultiSearch([
      `${destination} must eat local food dishes authentic cuisine`,
      `${destination} best street food stalls local restaurants hidden gems`,
    ], 8);

    const { context } = await buildResearchContext(searchResults, destination);

    // Phase 2: Extract structured taste guide
    const tastePrompt = `You are a food travel writer. Extract a local taste guide for "${destination}" from the research context below.

RESEARCH CONTEXT:
${context}

Return ONLY valid JSON (no markdown, no backticks). Use ONLY information from the context:
{
  "headline": "${destination} — Local Flavours",
  "tagline": "compelling one-liner about this destination's food identity",
  "dishes": [
    {
      "emoji": "🍜",
      "name": "exact dish name",
      "desc": "where specifically to get it and one detail that makes it special",
      "tags": ["must-try"]
    }
  ],
  "places": [
    {
      "emoji": "📍",
      "name": "exact place name",
      "desc": "what makes it special and unmissable",
      "tags": ["iconic"]
    }
  ],
  "experiences": [
    {
      "emoji": "✨",
      "name": "experience name",
      "desc": "why locals love it, what to expect",
      "tags": ["offbeat"]
    }
  ],
  "tip": "single best insider tip only a local or seasoned traveller would know"
}

Rules:
- 4 items in each array
- Every item must be specific and named — no generic entries like "local restaurants"
- Tags per item: pick from must-try, must-do, iconic, heritage, scenic, culture, offbeat, hidden-gem, seasonal
- Use ONLY information from the context above`;

    const tasteText = await callGemini({
      messages: [{ role: 'user', content: tastePrompt }],
      maxTokens: 2000,
      temperature: 0.1,
    });

    const data = await parseOrRepair(tasteText, 'local taste');
    console.log(`✅ [LOCAL TASTE] Done — ${data.dishes?.length} dishes, ${data.places?.length} places`);

    res.json(data);
  } catch (err) {
    console.error('❌ Local taste error:', err.message);
    res.status(500).json({ error: 'Could not fetch local taste data.' });
  }
});

// ─────────────────────────────────────────────────────────────────
// PHOTOS — Wikimedia Commons with caching
// ─────────────────────────────────────────────────────────────────
const photoCache = new Map();
const PHOTO_NOISE_RE = /flag|logo|map|seal|coat|icon|emblem|portrait|locator|location|blank|outline|stub/i;

async function commonsSearch(q, limit = 15) {
  const url =
    `https://commons.wikimedia.org/w/api.php?action=query` +
    `&generator=search&gsrsearch=${encodeURIComponent(q)}` +
    `&gsrnamespace=6&gsrlimit=${limit}` +
    `&prop=imageinfo&iiprop=url|size&iiurlwidth=900` +
    `&format=json&origin=*`;

  const r = await fetch(url, {
    headers: { 'User-Agent': 'TravelBae/1.0 (contact@travelbae.app)' },
  });
  const data = await r.json();
  const pages = data.query?.pages || {};

  return Object.values(pages)
    .filter(p => {
      const info = p.imageinfo?.[0];
      if (!info?.url) return false;
      if (PHOTO_NOISE_RE.test((p.title || '').toLowerCase())) return false;
      if (!/\.(jpg|jpeg|png|webp)$/i.test(info.url)) return false;
      if (info.width && info.height && info.width < info.height) return false;
      return true;
    })
    .map(p => p.imageinfo[0].thumburl || p.imageinfo[0].url);
}

router.get('/photos', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });

  if (photoCache.has(q)) return res.json({ urls: photoCache.get(q) });

  try {
    let urls = await commonsSearch(`${q} monument landmark historic`);
    if (urls.length < 3) urls = [...new Set([...urls, ...await commonsSearch(q)])];
    if (urls.length < 3) {
      const bare = q.split(',')[0].trim();
      if (bare !== q) urls = [...new Set([...urls, ...await commonsSearch(bare)])];
    }

    const result = urls.slice(0, 3);
    photoCache.set(q, result);
    setTimeout(() => photoCache.delete(q), 60 * 60 * 1000);
    res.json({ urls: result });
  } catch (err) {
    console.error('Photos error:', err.message);
    res.status(500).json({ error: 'Could not fetch photos' });
  }
});

module.exports = router;





/// // src/routes/ai.js
// // AI proxy using Google Gemini (gemini-1.5-flash).
// // Your frontend calls /ai/chat — this server calls Gemini using the key in .env.
// // The API key never touches the browser.
// //
// // POST /ai/chat       — chatbot message
// // POST /ai/itinerary  — generate a trip itinerary

// const express = require('express');
// const { authenticate } = require('../middleware/auth');

// const router = express.Router();
// router.use(authenticate);

// // Gemini API endpoint
// function geminiUrl() {
//   return `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
// }

// // Internal helper: call Gemini
// // Gemini doesn't have a "system" field like Anthropic/OpenAI.
// // We prepend the system prompt as the first user turn instead.
// async function callGemini({ system, messages, maxTokens = 1000 }) {
//   const contents = [];

//   // Inject system prompt as first user message if provided
//   if (system) {
//     contents.push({
//       role: 'user',
//       parts: [{ text: `[Instructions for you]: ${system}` }],
//     });
//     // Gemini requires alternating turns, so add a dummy model ack
//     contents.push({
//       role: 'model',
//       parts: [{ text: 'Understood. I will follow those instructions.' }],
//     });
//   }

//   // Add the actual conversation messages
//   for (const msg of messages) {
//     contents.push({
//       role: msg.role === 'assistant' ? 'model' : 'user',
//       parts: [{ text: msg.content }],
//     });
//   }

//   const res = await fetch(geminiUrl(), {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/json' },
//     body: JSON.stringify({
//       contents,
//       generationConfig: {
//         maxOutputTokens: maxTokens,
//         temperature: 0.7,
//       },
//     }),
//   });

//   const data = await res.json();

//   if (data.error) {
//     throw new Error(data.error.message || 'Gemini API error');
//   }

//   return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
// }

// // ── TRIP CHATBOT ────────────────────────────────────────
// // Body: { system, messages }
// // messages = [{ role: 'user' | 'assistant', content: string }]
// router.post('/chat', async (req, res) => {
//   const { system, messages } = req.body;

//   if (!messages || !Array.isArray(messages)) {
//     return res.status(400).json({ error: 'messages array is required.' });
//   }

//   try {
//     const reply = await callGemini({ system, messages, maxTokens: 500 });
//     res.json({ reply });
//   } catch (err) {
//     console.error('Gemini chat error:', err.message);
//     res.status(500).json({ error: 'AI service unavailable. Try again.' });
//   }
// });

// // ── GENERATE ITINERARY ──────────────────────────────────
// // Body: { destination, days, interests }
// router.post('/itinerary', async (req, res) => {
//   const { destination, days, interests } = req.body;

//   if (!destination || !days) {
//     return res.status(400).json({ error: 'destination and days are required.' });
//   }

//   const prompt = `
//     Create a detailed ${days}-day travel itinerary for ${destination}.
//     ${interests?.length ? `Traveller interests: ${interests.join(', ')}.` : ''}
    
//     Return ONLY valid JSON in this exact format, no explanation, no markdown, no backticks:
//     {
//       "days": [
//         {
//           "day": 1,
//           "items": [
//             { "time": "09:00 AM", "title": "Activity name", "note": "Short tip", "icon": "🏰" }
//           ]
//         }
//       ]
//     }
//   `;

//   try {
//     const text = await callGemini({
//       messages: [{ role: 'user', content: prompt }],
//       maxTokens: 1500,
//     });

//     const clean = text.replace(/```json|```/g, '').trim();
//     const itinerary = JSON.parse(clean);
//     res.json({ itinerary });
//   } catch (err) {
//     console.error('Gemini itinerary error:', err.message);
//     res.status(500).json({ error: 'Could not generate itinerary.' });
//   }
// });

// module.exports = router;

// src/routes/ai.js
// AI proxy using Google Gemini with Google Search Grounding.
// Scrapes real-time travel data from top sites, ranks by popularity,
// and generates the most refined itinerary possible.
//
// POST /ai/chat       — chatbot message
// POST /ai/itinerary  — generate research-backed trip itinerary

// const express = require('express');
// const { authenticate } = require('../middleware/auth');

// const router = express.Router();
// router.use(authenticate);

// // ── Gemini URLs ─────────────────────────────────────────
// function geminiUrl(model = 'gemini-3.1-flash-lite') {
//   return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
// }

// // ── Core Gemini caller (no grounding) ───────────────────
// async function callGemini({ system, messages, maxTokens = 1000, temperature = 0.7 }) {
//   const contents = [];

//   if (system) {
//     contents.push({ role: 'user', parts: [{ text: `[Instructions]: ${system}` }] });
//     contents.push({ role: 'model', parts: [{ text: 'Understood.' }] });
//   }

//   for (const msg of messages) {
//     contents.push({
//       role: msg.role === 'assistant' ? 'model' : 'user',
//       parts: [{ text: msg.content }],
//     });
//   }

//   const res = await fetch(geminiUrl(), {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/json' },
//     body: JSON.stringify({
//       contents,
//       generationConfig: { maxOutputTokens: maxTokens, temperature },
//     }),
//   });

//   const data = await res.json();
//   if (data.error) throw new Error(data.error.message || 'Gemini API error');
//   return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
// }

// // ── Serper web search helper ─────────────────────────────
// async function serperSearch(query, numResults = 10) {
//   const res = await fetch('https://google.serper.dev/search', {
//     method: 'POST',
//     headers: {
//       'Content-Type': 'application/json',
//       'X-API-KEY': process.env.SERPER_API_KEY,
//     },
//     body: JSON.stringify({ q: query, num: numResults, gl: 'in', hl: 'en' }),
//   });
//   const data = await res.json();

//   // Extract organic results + knowledge graph if present
//   const results = (data.organic || []).map(r => ({
//     title: r.title,
//     url: r.link,
//     snippet: r.snippet,
//   }));

//   const kg = data.knowledgeGraph;
//   const kgText = kg ? `\nKnowledge Graph: ${kg.title} — ${kg.description || ''}\n` : '';

//   return {
//     text: kgText + results.map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\nSource: ${r.url}`).join('\n\n'),
//     sources: results.slice(0, 8).map(r => ({ title: r.title, url: r.url })),
//   };
// }

// // ── Gemini + Serper search (replaces Google grounding) ───
// async function callGeminiWithSearch({ prompt, maxTokens = 8000, temperature = 0.3, searchQuery }) {
//   // Step 1: Get real web results via Serper
//   const query = searchQuery || prompt.slice(0, 200);
//   const { text: searchResults, sources } = await serperSearch(query);

//   // Step 2: Pass search results as context to Gemini
//   const augmentedPrompt = `
// You have access to the following real-time web search results. Use them as your primary source of truth.

// SEARCH RESULTS:
// ${searchResults}

// ---

// Now answer the following using the search results above as context:
// ${prompt}
// `;

//   const text = await callGemini({
//     messages: [{ role: 'user', content: augmentedPrompt }],
//     maxTokens,
//     temperature,
//   });

//   return { text, groundingMetadata: { groundingChunks: sources.map(s => ({ web: s })) } };
// }

// function extractJsonObject(text) {
//   const clean = String(text || '').replace(/```json|```/gi, '').trim();
//   const start = clean.indexOf('{');
//   if (start === -1) throw new Error('No JSON object start found.');

//   let depth = 0;
//   let inString = false;
//   let escaping = false;
//   for (let i = start; i < clean.length; i += 1) {
//     const ch = clean[i];
//     if (inString) {
//       if (escaping) {
//         escaping = false;
//       } else if (ch === '\\') {
//         escaping = true;
//       } else if (ch === '"') {
//         inString = false;
//       }
//       continue;
//     }
//     if (ch === '"') {
//       inString = true;
//       continue;
//     }
//     if (ch === '{') depth += 1;
//     if (ch === '}') {
//       depth -= 1;
//       if (depth === 0) return clean.slice(start, i + 1);
//     }
//   }

//   const end = clean.lastIndexOf('}');
//   if (end !== -1 && end > start) return clean.slice(start, end + 1);
//   throw new Error('No complete JSON object found.');
// }

// function parseJsonLenient(text) {
//   const candidate = extractJsonObject(text)
//     .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
//     .replace(/,\s*([}\]])/g, '$1');
//   return JSON.parse(candidate);
// }

// async function parseOrRepairJson(rawText, shapeHint = 'itinerary') {
//   try {
//     return parseJsonLenient(rawText);
//   } catch (firstErr) {
//     const repairPrompt = `
// You will receive malformed JSON that should represent a ${shapeHint} object.
// Return ONLY corrected valid JSON with the same data intent.
// Do not add markdown fences. Do not add comments.

// MALFORMED JSON:
// ${String(rawText || '').slice(0, 120000)}
// `;

//     const repairedText = await callGemini({
//       messages: [{ role: 'user', content: repairPrompt }],
//       maxTokens: 9000,
//       temperature: 0,
//     });

//     try {
//       return parseJsonLenient(repairedText);
//     } catch {
//       throw firstErr;
//     }
//   }
// }

// // ── CHATBOT ─────────────────────────────────────────────
// router.post('/chat', async (req, res) => {
//   const { system, messages } = req.body;
//   if (!messages || !Array.isArray(messages)) {
//     return res.status(400).json({ error: 'messages array is required.' });
//   }
//   try {
//     const reply = await callGemini({ system, messages, maxTokens: 500 });
//     res.json({ reply });
//   } catch (err) {
//     console.error('Gemini chat error:', err.message);
//     res.status(500).json({ error: 'AI service unavailable. Try again.' });
//   }
// });

// // ── ITINERARY ────────────────────────────────────────────
// // Body: { destination, days, budget, people, interests }
// router.post('/itinerary', async (req, res) => {
//   const { destination, days, budget, people = 1, interests = [], customDescription } = req.body;

//   if (!destination || !days) {
//     return res.status(400).json({ error: 'destination and days are required.' });
//   }

//   const budgetPerDay = budget ? Math.round(budget / days) : null;
//   const interestStr = interests.length ? interests.join(', ') : 'general sightseeing, food, culture';

//   try {
//     // ── PHASE 1: Research via Google Search Grounding ──
//     // Pull real ranked data from top travel sites
//     const researchPrompt = `
// You are a world-class travel researcher. Search the web RIGHT NOW for the most up-to-date, highly-rated travel information about "${destination}".

// Search across these sources: TripAdvisor, Google Travel, Lonely Planet, Nomadic Matt, WikiVoyage, Condé Nast Traveler, Travel + Leisure, local tourism boards, and recent travel blogs from 2024-2025.

// For "${destination}", find and RANK the following by popularity, rating, and traveller reviews:

// 1. TOP 20 ATTRACTIONS (rank by TripAdvisor/Google rating, include opening hours, entry fees in INR if applicable, best time to visit, how long to spend)
// 2. TOP 15 RESTAURANTS & STREET FOOD (rank by reviews, include signature dishes, price range, area/neighbourhood)  
// 3. TOP 10 LOCAL EXPERIENCES (unique things only locals know, hidden gems, cultural immersions)
// 4. TOP 5 SHOPPING SPOTS (local markets, what to buy)
// 5. PRACTICAL INFO (best areas to stay, local transport options, average costs, safety tips, weather for this time of year)
// 6. WHAT TO AVOID (overrated spots, tourist traps, scam alerts)

// ${budgetPerDay ? `Budget: ₹${budget} total (₹${budgetPerDay}/day) for ${people} person(s). Filter recommendations accordingly.` : ''}
// Interests: ${interestStr}

// Return this as structured data I can use to build an itinerary. Be extremely specific with names, locations, ratings.
// `;

//     let researchData = '';
//     let sources = [];

//     try {
//       console.log(`🔍 [ITINERARY] Firing 2 Serper searches for: ${destination}`);
//       const [attractionsSearch, foodSearch] = await Promise.all([
//         serperSearch(`best places to visit hidden gems local experiences ${destination}`),
//         serperSearch(`best food restaurants street food travel tips ${destination}`),
//       ]);
//       console.log(`✅ [SERPER] Attractions results (${attractionsSearch.sources.length} sources):`, attractionsSearch.sources.map(s => s.url));
//       console.log(`✅ [SERPER] Food results (${foodSearch.sources.length} sources):`, foodSearch.sources.map(s => s.url));
//       console.log(`📄 [SERPER] Combined search text length: ${(attractionsSearch.text + foodSearch.text).length} chars`);
//       const combinedSearch = attractionsSearch.text + '\n\n' + foodSearch.text;
//       const combinedSources = [...attractionsSearch.sources, ...foodSearch.sources];

//       const augmentedResearchPrompt = `
// You have access to the following real-time web search results. Use them as your primary source of truth.

// SEARCH RESULTS:
// ${combinedSearch}

// ---

// Now answer the following using the search results above as context:
// ${researchPrompt}
// `;
//       console.log(`🤖 [GEMINI] Sending Phase 1 research prompt (${augmentedResearchPrompt.length} chars) to Gemini...`);
//       const text = await callGemini({
//         messages: [{ role: 'user', content: augmentedResearchPrompt }],
//         maxTokens: 6000,
//         temperature: 0.2,
//       });
//       console.log(`✅ [GEMINI] Phase 1 research done. Response length: ${text.length} chars`);
//       console.log(`📄 [GEMINI] Phase 1 snippet:`, text.slice(0, 300));
//       const groundingMetadata = { groundingChunks: combinedSources.map(s => ({ web: s })) };
//       researchData = text;

//       // Extract source URLs from grounding metadata
//       if (groundingMetadata?.groundingChunks) {
//         sources = groundingMetadata.groundingChunks
//           .filter(c => c.web?.url)
//           .map(c => ({ title: c.web.title || c.web.url, url: c.web.url }))
//           .slice(0, 8);
//       }
//       } catch (searchErr) {
//       console.warn('Search grounding failed, falling back to trained knowledge:', searchErr.message);
//       console.warn('Full grounding error:', searchErr.message, searchErr.stack);
//     // } catch (searchErr) {
//     //   console.warn('Search grounding failed, falling back to trained knowledge:', searchErr.message);
//       // Fallback: use Gemini's trained knowledge without grounding
//       researchData = await callGemini({
//         messages: [{ role: 'user', content: researchPrompt }],
//         maxTokens: 4000,
//         temperature: 0.3,
//       });
//     }

//     // ── PHASE 2: Build the itinerary from research ──
//     const itineraryPrompt = `
// You are the world's best travel planner — better than any app or website. 
// Using the research below, build the PERFECT ${days}-day itinerary for ${destination}.

// RESEARCH DATA:
// ${researchData}

// TRIP DETAILS:
// - Destination: ${destination}
// - Duration: ${days} days
// - People: ${people}
// - Budget: ${budget ? `₹${budget} total (₹${budgetPerDay}/day per group)` : 'flexible'}
// - Interests: ${interestStr}
// ${customDescription ? `- Special instructions from traveler (HIGHEST PRIORITY — follow these closely): "${customDescription}"` : ''}

// ITINERARY RULES:
// 1. Order activities logically by geography — cluster nearby spots on the same day to minimise travel
// 2. Start mornings with the most popular/crowded spots (beat the crowd)
// 3. Mix top-rated attractions with hidden gems and local experiences
// 4. Include specific meal recommendations at each mealtime — name the restaurant/stall and what to order
// 5. Add realistic time estimates for each activity
// 6. Include practical tips (how to get there, what to wear, what to bring, best photo spots)
// 7. First day: arrive + light exploration + orientation. Last day: checkout-friendly activities
// 8. If budget provided, stay within it and note approximate costs
// 9. Include at least one unique local experience per day that tourists usually miss

// Return ONLY valid JSON — no markdown, no backticks, no explanation:
// {
//   "headline": "The Perfect ${days}-Day ${destination} Experience",
//   "summary": "2-sentence compelling summary of this itinerary",
//   "totalEstimatedCost": "₹XX,XXX",
//   "bestTimeToVisit": "string",
//   "quickTips": ["tip1", "tip2", "tip3", "tip4"],
//   "days": [
//     {
//       "day": 1,
//       "title": "Day theme e.g. Old City & Street Food Trail",
//       "theme": "one-line mood e.g. History, architecture & authentic flavours",
//       "estimatedCost": "₹X,XXX",
//       "weather": { "high": 28, "low": 14, "condition": "Clear", "tip": "Wear sunscreen" },
//       "activities": [
//         {
//           "time": "08:00 AM",
//           "name": "Specific place name",
//           "type": "attraction|food|experience|transport|hotel|shopping",
//           "duration": "1.5 hours",
//           "note": "Specific insider tip — what to see, what to order, hidden detail",
//           "cost": "₹200 per person",
//           "rating": "4.7 ⭐",
//           "icon": "🏰",
//           "mustDo": true
//         }
//       ]
//     }
//   ]
// }
// `;

//     // const itineraryText = await callGemini({
//     //   messages: [{ role: 'user', content: itineraryPrompt }],
//     //   maxTokens: 8000,
//     //   temperature: 0.4,
//     // });

//     console.log(`⏳ [ITINERARY] Waiting 4s before Phase 2...`);
//     await new Promise(r => setTimeout(r, 4000));
//     console.log(`🤖 [GEMINI] Sending Phase 2 itinerary build prompt...`);
//     const itineraryText = await callGemini({
//       messages: [{ role: 'user', content: itineraryPrompt }],
//       maxTokens: 8000,
//       temperature: 0.4,
//     });
//     console.log(`✅ [GEMINI] Phase 2 done. Itinerary text length: ${itineraryText.length} chars`);

//     const itinerary = await parseOrRepairJson(itineraryText, 'travel itinerary');

//     res.json({ itinerary, sources });

//   } catch (err) {
//     console.error('Itinerary generation error:', err.message);
//     res.status(500).json({ error: 'Could not generate itinerary. Please try again.' });
//   }
// });

// // ── LOCAL TASTE (food + places + experiences) ────────────
// // Body: { destination }
// router.post('/local-taste', async (req, res) => {
//   const { destination } = req.body;
//   if (!destination) return res.status(400).json({ error: 'destination is required.' });

//   try {
//     const prompt = `
// Search the web for the most authentic, highly-rated local food experiences, must-visit places, and unique experiences in "${destination}". 
// Use TripAdvisor, Zomato, local food blogs, Google reviews from 2024-2025.

// Return ONLY valid JSON:
// {
//   "headline": "${destination} — Local Flavours",
//   "tagline": "compelling one-liner",
//   "dishes": [
//     { "emoji": "🍜", "name": "dish name", "desc": "where to get it and why it's special", "tags": ["must-try"] }
//   ],
//   "places": [
//     { "emoji": "📍", "name": "place name", "desc": "what makes it special", "tags": ["iconic"] }
//   ],
//   "experiences": [
//     { "emoji": "✨", "name": "experience name", "desc": "why locals love it", "tags": ["offbeat"] }
//   ],
//   "tip": "single best insider tip a local would give"
// }

// 4 items each. Only real, specific, highly-rated options.
// `;

//     let text;
//     try {
//     console.log(`🔍 [LOCAL TASTE] Firing Serper search for: ${destination}`);
//       const { text: searchResults, sources: tasteSources } = await serperSearch(
//         `best local food dishes restaurants street food experiences ${destination}`
//       );
//       console.log(`✅ [SERPER] Local taste results (${tasteSources.length} sources):`, tasteSources.map(s => s.url));
//       console.log(`📄 [SERPER] Search text length: ${searchResults.length} chars`);
//       const augmentedTastePrompt = `
// You have access to the following real-time web search results. Use them as your primary source of truth.

// SEARCH RESULTS:
// ${searchResults}

// ---

// Now answer the following using the search results above as context:
// ${prompt}
// `;
//       console.log(`🤖 [GEMINI] Sending local taste prompt (${augmentedTastePrompt.length} chars)...`);
//       text = await callGemini({
//         messages: [{ role: 'user', content: augmentedTastePrompt }],
//         maxTokens: 2000,
//         temperature: 0.3,
//       });
//       console.log(`✅ [GEMINI] Local taste done. Response length: ${text.length} chars`);
//       console.log(`📄 [GEMINI] Local taste snippet:`, text.slice(0, 300));  
//     } catch {
//       text = await callGemini({ messages: [{ role: 'user', content: prompt }], maxTokens: 2000 });
//     }

//     const data = await parseOrRepairJson(text, 'local taste guide');
//     res.json(data);
//   } catch (err) {
//     console.error('Local taste error:', err.message);
//     res.status(500).json({ error: 'Could not fetch local taste data.' });
//   }
// });


// const photoCache = new Map();

// // Shared noise filter – skip flags, maps, logos, portraits, SVG/GIF
// const PHOTO_NOISE_RE = /flag|logo|map|seal|coat|icon|emblem|portrait|locator|location|blank|outline|stub/i;

// async function commonsSearch(q, limit = 15) {
//   const url =
//     `https://commons.wikimedia.org/w/api.php?action=query` +
//     `&generator=search&gsrsearch=${encodeURIComponent(q)}` +
//     `&gsrnamespace=6&gsrlimit=${limit}` +
//     `&prop=imageinfo&iiprop=url|size&iiurlwidth=900` +
//     `&format=json&origin=*`;
//   const r = await fetch(url, {
//     headers: { 'User-Agent': 'TravelBae/1.0 (contact@travelbae.app)' },
//   });
//   const data = await r.json();
//   const pages = data.query?.pages || {};
//   return Object.values(pages)
//     .filter(p => {
//       const info = p.imageinfo?.[0];
//       if (!info?.url) return false;
//       const fname = (p.title || '').toLowerCase();
//       if (PHOTO_NOISE_RE.test(fname)) return false;
//       if (!/\.(jpg|jpeg|png|webp)$/i.test(info.url)) return false;
//       // prefer landscape / reasonable size
//       if (info.width && info.height && info.width < info.height) return false;
//       return true;
//     })
//     .map(p => p.imageinfo[0].thumburl || p.imageinfo[0].url);
// }

// router.get('/photos', async (req, res) => {
//   const { q } = req.query;
//   if (!q) return res.status(400).json({ error: 'q is required' });

//   if (photoCache.has(q)) {
//     return res.json({ urls: photoCache.get(q) });
//   }

//   try {
//     // Pass 1 — landmark-specific
//     let urls = await commonsSearch(`${q} monument landmark historic`);

//     // Pass 2 — broader if still short
//     if (urls.length < 3) {
//       const more = await commonsSearch(q);
//       urls = [...new Set([...urls, ...more])];
//     }

//     // Pass 3 — strip qualifiers, bare city/place name
//     if (urls.length < 3) {
//       const bare = q.split(',')[0].trim();
//       if (bare !== q) {
//         const more = await commonsSearch(bare);
//         urls = [...new Set([...urls, ...more])];
//       }
//     }

//     const result = urls.slice(0, 3);
//     photoCache.set(q, result);
//     setTimeout(() => photoCache.delete(q), 60 * 60 * 1000);

//     res.json({ urls: result });
//   } catch (err) {
//     console.error('Wikimedia photos error:', err.message);
//     res.status(500).json({ error: 'Could not fetch photos' });
//   }
// });



// module.exports = router;
