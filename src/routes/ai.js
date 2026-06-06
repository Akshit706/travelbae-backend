// src/routes/ai.js
// ═══════════════════════════════════════════════════════════════════
// Enhanced AI pipeline: Serper (multi-query) → web_fetch (top pages)
// → Gemini structured extraction → itinerary/local-taste generation
//
// POST /ai/chat          — trip chatbot
// POST /ai/itinerary     — research-backed itinerary (3-phase)
// POST /ai/local-taste   — local food + places + experiences
// GET  /ai/photos        — Wikimedia place photos
// ═══════════════════════════════════════════════════════════════════

const express = require('express');
const crypto  = require('crypto');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ─────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────

// Model cascade — ordered by: free RPM → quality
// gemini-3.1-flash-lite : highest free RPM, fastest, primary workhorse
// gemini-2.5-flash-lite : fallback, still fast and free
// gemini-2.5-flash      : final fallback, best quality, lower free RPM
const GEMINI_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
];

// Per-model cooldown tracking — if a model 429s, skip it for COOLDOWN_MS
// This means the NEXT call immediately tries the next model, no waiting
const MODEL_COOLDOWN_MS = 65000; // 65s — just past the 1-min window
const modelCooldowns = new Map(); // modelName → timestamp when it's usable again

const SERPER_URL  = 'https://google.serper.dev/search';
const FETCH_TOP_N = 3;

// Domains to skip fetching (login-walled, video, social, aggregators)
const SKIP_FETCH_DOMAINS = [
  'youtube.com', 'facebook.com', 'instagram.com', 'twitter.com',
  'reddit.com',  'tripadvisor.com', 'tripadvisor.in', 'makemytrip.com',
  'klook.com',   'viator.com', 'getyourguide.com', 'booking.com',
  'agoda.com',   'expedia.com',
];

// Editorial domains worth deep-fetching
const PREFER_FETCH_DOMAINS = [
  'lonelyplanet.com', 'nomadicmatt.com',   'wikivoyage.org',
  'travelandleisure.com', 'timeout.com',   'cntraveler.com',
  'eatingthaifood.com',   'marionskitchen.com',
  'midnightblueelephant.com', 'notquitenigella.com',
  'guide.michelin.com',   'breathedreamgo.com',
  'passionforhospitality.net', 'willflyforfood.net',
  'budgettraveller.org',  'akasaair.com',
];

// ─────────────────────────────────────────────────────────────────
// GEMINI CALLER — fast model cascade, no queue blocking
//
// Strategy:
//   • Try models in cascade order
//   • If a model is in cooldown → skip it immediately (no wait)
//   • If a model returns 429 → put it in cooldown, try next model NOW
//   • If all models are in cooldown → wait for the soonest to recover
//   • Non-429 errors → skip to next model immediately
// ─────────────────────────────────────────────────────────────────
function geminiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
}

function isRateLimitError(data) {
  return (
    data?.error?.code === 429 ||
    (data?.error?.message || '').toLowerCase().includes('quota') ||
    (data?.error?.message || '').toLowerCase().includes('rate limit')
  );
}

function isModelNotFoundError(data) {
  const msg = (data?.error?.message || '').toLowerCase();
  return msg.includes('not found') || msg.includes('not supported') || data?.error?.code === 404;
}

function modelAvailableAt(model) {
  return modelCooldowns.get(model) || 0;
}

function putModelOnCooldown(model) {
  const until = Date.now() + MODEL_COOLDOWN_MS;
  modelCooldowns.set(model, until);
  console.warn(`🔴 [GEMINI] ${model} on cooldown for ${MODEL_COOLDOWN_MS / 1000}s`);
}

async function callGemini({ system, messages, maxTokens = 1000, temperature = 0.7 }) {
  // Build contents once
  const contents = [];
  if (system) {
    contents.push({ role: 'user',  parts: [{ text: `[System instructions]: ${system}` }] });
    contents.push({ role: 'model', parts: [{ text: 'Understood.' }] });
  }
  for (const msg of messages) {
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    });
  }

  const body = JSON.stringify({
    contents,
    generationConfig: { maxOutputTokens: maxTokens, temperature },
  });

  let lastError = 'No models available';

  for (let pass = 0; pass < 2; pass++) {
    // pass 0: try all non-cooldown models
    // pass 1: if all are in cooldown, wait for the soonest one and retry once

    const now = Date.now();

    // Find which models are available right now
    const available = GEMINI_MODELS.filter(m => modelAvailableAt(m) <= now);

    if (available.length === 0 && pass === 0) {
      // All in cooldown — wait for the soonest one to recover
      const soonest = Math.min(...GEMINI_MODELS.map(m => modelAvailableAt(m)));
      const waitMs  = Math.max(soonest - Date.now() + 200, 0); // +200ms buffer
      console.warn(`⏳ [GEMINI] All models in cooldown. Waiting ${(waitMs / 1000).toFixed(1)}s for next available…`);
      await new Promise(r => setTimeout(r, waitMs));
      continue; // retry pass 1 with refreshed availability
    }

    for (const model of available) {
      try {
        const res  = await fetch(geminiUrl(model), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        const data = await res.json();

        if (!data.error) {
          return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        }

        if (isRateLimitError(data)) {
          putModelOnCooldown(model);
          lastError = `${model} rate limited`;
          continue; // try next model immediately
        }

        if (isModelNotFoundError(data)) {
          // Permanently mark as unavailable for this session
          modelCooldowns.set(model, Date.now() + 24 * 60 * 60 * 1000);
          console.warn(`⚠️ [GEMINI] Model not found: ${model} — removing from rotation`);
          lastError = `${model} not found`;
          continue;
        }

        // Other API error
        lastError = data.error.message;
        console.warn(`⚠️ [GEMINI] Error on ${model}: ${lastError}`);
        continue; // try next model

      } catch (fetchErr) {
        lastError = fetchErr.message;
        console.warn(`⚠️ [GEMINI] Fetch error on ${model}: ${lastError}`);
        continue;
      }
    }

    // If we get here on pass 0, all available models failed
    if (pass === 0) break; // no point retrying if non-cooldown errors
  }

  throw new Error(`Gemini unavailable: ${lastError}`);
}

// ─────────────────────────────────────────────────────────────────
// SERPER — multi-query search, deduplicated
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

    if (data.knowledgeGraph && !seen.has('__kg__')) {
      seen.add('__kg__');
      const kg = data.knowledgeGraph;
      allResults.push({
        type: 'knowledge_graph',
        title: kg.title || '',
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
// WEB FETCH — pull actual page content from editorial sources
// ─────────────────────────────────────────────────────────────────
function shouldFetch(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace('www.', '');
    return !SKIP_FETCH_DOMAINS.some(d => host.includes(d));
  } catch { return false; }
}

function preferScore(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '');
    return PREFER_FETCH_DOMAINS.some(d => host.includes(d)) ? 1 : 0;
  } catch { return 0; }
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
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s{3,}/g, '\n\n')
      .trim().slice(0, maxChars) || null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────
// RESEARCH ASSEMBLER
// ─────────────────────────────────────────────────────────────────
async function buildResearchContext(searchResults, topN = FETCH_TOP_N) {
  const organic = searchResults.filter(r => r.type === 'organic');
  const sorted  = [...organic].sort((a, b) => preferScore(b.url) - preferScore(a.url));
  const toFetch = sorted.filter(r => shouldFetch(r.url)).slice(0, topN);

  console.log(`🌐 [FETCH] Fetching ${toFetch.length} pages:`, toFetch.map(r => r.url));
  const fetched = await Promise.allSettled(toFetch.map(r => fetchPageContent(r.url)));

  let context = '';

  const kg = searchResults.find(r => r.type === 'knowledge_graph');
  if (kg) {
    context += `## Overview: ${kg.title}\n${kg.description}\n`;
    const attrs = Object.entries(kg.attributes || {});
    if (attrs.length) context += attrs.map(([k, v]) => `${k}: ${v}`).join('\n') + '\n\n';
  }

  context += `## Detailed Research (from travel publications)\n`;
  let fetchedCount = 0;
  for (let i = 0; i < toFetch.length; i++) {
    const r = fetched[i];
    if (r.status === 'fulfilled' && r.value) {
      fetchedCount++;
      const host = new URL(toFetch[i].url).hostname.replace('www.', '');
      context += `\n### ${host}\nURL: ${toFetch[i].url}\n${r.value}\n`;
    }
  }
  console.log(`✅ [FETCH] ${fetchedCount}/${toFetch.length} pages fetched`);

  context += `\n## Snippets (supplementary)\n`;
  for (const r of organic.slice(0, 15)) {
    const host = (() => { try { return new URL(r.url).hostname.replace('www.', ''); } catch { return r.url; } })();
    context += `\n[${host}] ${r.title}\n${r.snippet}`;
    if (r.sitelinks?.length) context += `\nMore: ${r.sitelinks.slice(0, 2).join(' | ')}`;
    context += '\n';
  }

  console.log(`📄 [CONTEXT] ${context.length} chars total`);
  return { context, sources: organic.slice(0, 10).map(r => ({ title: r.title, url: r.url })) };
}

// ─────────────────────────────────────────────────────────────────
// JSON UTILITIES
// ─────────────────────────────────────────────────────────────────
function extractJson(text) {
  const clean = String(text || '').replace(/```json|```/gi, '').trim();
  const start = clean.indexOf('{');
  if (start === -1) throw new Error('No JSON object found');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < clean.length; i++) {
    const ch = clean[i];
    if (inStr) {
      if (esc)         { esc = false; continue; }
      if (ch === '\\') { esc = true;  continue; }
      if (ch === '"')  { inStr = false; continue; }
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
  return JSON.parse(
    extractJson(text)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/,\s*([}\]])/g, '$1')
  );
}

async function parseOrRepair(rawText, shape) {
  try { return parseJson(rawText); }
  catch (firstErr) {
    console.warn(`⚠️ [JSON] Parse failed for ${shape}, attempting repair`);
    try {
      const repaired = await callGemini({
        messages: [{
          role: 'user',
          content: `Fix this malformed JSON. Return ONLY valid JSON, no markdown, no explanation.\n\nMALFORMED:\n${String(rawText).slice(0, 50000)}`,
        }],
        maxTokens: 8000, temperature: 0,
      });
      return parseJson(repaired);
    } catch { throw firstErr; }
  }
}

// ─────────────────────────────────────────────────────────────────
// CHATBOT
// ─────────────────────────────────────────────────────────────────
router.post('/chat', async (req, res) => {
  const { system, messages } = req.body;
  if (!messages || !Array.isArray(messages))
    return res.status(400).json({ error: 'messages array is required.' });
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
// Phase 1: Serper (4 queries) + web-fetch → rich research context
// Phase 2: Gemini extraction (temp=0) → typed structured JSON
// Phase 3: Gemini itinerary build (temp=0.3) → final itinerary JSON
// ─────────────────────────────────────────────────────────────────
router.post('/itinerary', async (req, res) => {
  const {
    destination, days, budget, people = 1,
    interests = [], customDescription,
    arrivalSlot, departureSlot, travelNotes,
  } = req.body;

  if (!destination || !days)
    return res.status(400).json({ error: 'destination and days are required.' });

  const clampedDays  = Math.min(Math.max(1, parseInt(days) || 1), 30);
  const budgetPerDay = budget ? Math.round(budget / clampedDays) : null;
  const interestStr  = interests.length
    ? interests.map(i => i.replace(/^[^\w]+/, '').trim()).join(', ')
    : 'sightseeing, food, culture, local experiences';

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🗺️  ITINERARY: ${destination} | ${clampedDays} days | ${interestStr}`);
  console.log(`${'═'.repeat(60)}`);

  try {
    // ── PHASE 1: Research ──────────────────────────────────────
    console.log('\n📡 PHASE 1: Research');
    // Scale search breadth with trip length: more days → more unique places needed
    const numPerQuery = clampedDays <= 3 ? 8 : clampedDays <= 7 ? 10 : 12;
    const fetchTopN   = clampedDays <= 3 ? 3 : clampedDays <= 7 ? 5 : 7;
    const searchQueries = [
      `${destination} top famous iconic attractions landmarks must visit travel guide`,
      `${destination} best popular restaurants cafes rooftop bars where to eat food guide`,
      `${destination} renowned famous street food institutions iconic food spots`,
      `${destination} travel tips practical guide transport budget itinerary`,
      `${destination} top attractions opening hours timings entry fee ticket price official`,
    ];
    if (clampedDays > 3) {
      searchQueries.push(`${destination} popular neighbourhoods iconic areas walking tour`);
      searchQueries.push(`${destination} day trips famous nearby places excursions`);
    }
    if (clampedDays > 7) {
      searchQueries.push(`${destination} top museums galleries heritage sites entry fee hours`);
      searchQueries.push(`${destination} famous markets shopping iconic experiences`);
    }
    const searchResults = await serperMultiSearch(searchQueries, numPerQuery);
    const { context: researchContext, sources } = await buildResearchContext(searchResults, fetchTopN);

    // ── PHASE 2: Structured extraction ────────────────────────
    console.log('\n🧠 PHASE 2: Structured extraction');
    // Scale extraction and build limits based on trip length
    const maxAttractions    = Math.min(Math.max(20, clampedDays * 2), 50);
    const maxRestaurants    = Math.min(Math.max(12, clampedDays), 30);
    const maxExperiences    = Math.min(Math.max(6,  Math.floor(clampedDays / 2)), 15);
    // ~1400 tokens/day for activities + metadata, minimum 8000, cap at model limit
    const phase3Tokens      = Math.min(Math.max(8000, clampedDays * 1400), 65000);
    const phase2Tokens      = Math.min(Math.max(6000, clampedDays * 300),  16000);

    const extractionPrompt = `You are a travel data analyst curating a high-quality travel guide for ${destination}. Extract named places from the research context — but ONLY those that meet the quality bar below.

DESTINATION: ${destination}
${budget ? `BUDGET: ₹${budget} total (₹${budgetPerDay}/day) for ${people} person(s)` : ''}
INTERESTS: ${interestStr}

RESEARCH CONTEXT:
${researchContext}

QUALITY BAR — a place only makes the list if it passes ALL of these:
1. It is specifically named in the research context (not just "a local temple" or "street stalls")
2. It is famous, well-known, widely recommended, or trending — the kind of place that appears in travel guides, top-10 lists, or has a genuine reputation beyond its immediate neighbourhood
3. For restaurants/food: must be a named establishment (restaurant, dhaba, café, bakery, rooftop bar) or a nationally/globally famous street food institution — NOT a generic unnamed vendor or roadside stall. A chai stall does NOT qualify unless it is genuinely iconic and appears by name in travel editorial
4. For attractions: must be a real landmark, heritage site, museum, iconic market, or well-known viewpoint — not a generic street or unnamed locality

RULES:
- Never include unnamed or generic places ("local market", "street vendors", "nearby temple", "a local eatery")
- Never merge two different places into one entry.
- CRITICAL: Only populate a field if the value appears EXPLICITLY in the research context. Set "opening_hours" to null if not in context. Set "entry_fee" and "price_range" to null if not in context. Never guess or infer — null is better than a made-up value.
- Mark "hours_verified": true only if opening hours came from the context.
- Mark "price_verified": true only if price came from the context.

Return ONLY valid JSON (no markdown, no backticks):
{
  "destination_overview": "2-3 sentence overview",
  "best_time_to_visit": "specific months and why",
  "practical_tips": ["tip1","tip2","tip3","tip4","tip5"],
  "getting_around": "transport options and costs",
  "average_costs": {
    "budget_meal": "₹XX",
    "mid_range_meal": "₹XX",
    "attraction_entry": "₹XX average",
    "local_transport_per_day": "₹XX"
  },
  "attractions": [
    {
      "name": "exact place name as written in context",
      "type": "temple|museum|market|beach|viewpoint|park|heritage|experience|neighbourhood|street",
      "area": "neighbourhood or district",
      "opening_hours": "9 AM – 6 PM or null if not in context",
      "hours_verified": true,
      "entry_fee": "₹200 or Free or null if not in context",
      "price_verified": true,
      "duration": "1-2 hours",
      "best_for": "one line: what it is famous for",
      "insider_tip": "specific tip tourists miss",
      "priority": "must_do|recommended|if_time_permits"
    }
  ],
  "restaurants": [
    {
      "name": "exact name — must be a named establishment or a famous institution, never a generic stall",
      "type": "street_food|casual|fine_dining|cafe|market|hawker",
      "area": "neighbourhood or district",
      "specialty": "specific dish to order",
      "price_range": "₹XX–₹XX per person or null if not in context",
      "price_verified": true,
      "opening_hours": "hours or null if not in context",
      "hours_verified": true,
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
  "areas_to_stay": ["area1 — why","area2 — why"],
  "what_to_avoid": ["avoid1","avoid2","avoid3"]
}
Extract up to ${maxAttractions} attractions, ${maxRestaurants} restaurants, ${maxExperiences} local_experiences. Prioritise quantity of unique named places over brevity.`;

    let structuredData = null;
    try {
      const extractionText = await callGemini({
        messages: [{ role: 'user', content: extractionPrompt }],
        maxTokens: phase2Tokens, temperature: 0,
      });
      structuredData = await parseOrRepair(extractionText, 'structured travel data');
      console.log(`✅ [PHASE 2] ${structuredData.attractions?.length || 0} attractions, ${structuredData.restaurants?.length || 0} restaurants`);
    } catch (e) {
      console.warn('⚠️ [PHASE 2] Failed — Phase 3 will use raw context:', e.message);
    }

    // ── PHASE 3: Itinerary build ───────────────────────────────
    console.log('\n🗓️  PHASE 3: Itinerary build');
    const SLOT_LABELS = {
      night: '12AM–6AM', morning: '6AM–12PM',
      afternoon: '12PM–6PM', evening: '6PM–12AM',
    };
    const arrivalLabel   = SLOT_LABELS[arrivalSlot]   || '6AM–12PM';
    const departureLabel = SLOT_LABELS[departureSlot] || '6AM–12PM';
    const researchInput  = structuredData
      ? JSON.stringify(structuredData, null, 2)
      : researchContext.slice(0, 8000);

    // Build readable place pools so the model sees exactly what's available
    // Also pass verified flags so Phase 3 knows which fields came from real sources
    const attractionPool = (structuredData?.attractions || [])
      .map(a => `• [${a.area || '?'}] ${a.name} (${a.type}, duration: ${a.duration || '1-2h'}, entry: ${a.entry_fee || 'unknown'}, hours: ${a.opening_hours || 'unknown'}, hours_verified: ${a.hours_verified ? 'YES' : 'NO'}, price_verified: ${a.price_verified ? 'YES' : 'NO'})`)
      .join('\n') || '(see research data)';
    const restaurantPool = (structuredData?.restaurants || [])
      .map(r => `• [${r.area || '?'}] ${r.name} — ${r.specialty || r.type} (${r.best_meal || 'anytime'}, price: ${r.price_range || 'unknown'}, hours: ${r.opening_hours || 'unknown'}, hours_verified: ${r.hours_verified ? 'YES' : 'NO'}, price_verified: ${r.price_verified ? 'YES' : 'NO'})`)
      .join('\n') || '(see research data)';
    const experiencePool = (structuredData?.local_experiences || [])
      .map(e => `• ${e.name}: ${e.description || ''}`)
      .join('\n');

    const activitiesPerDay = clampedDays <= 3 ? 6 : clampedDays <= 7 ? 5 : 4;

    const itineraryPrompt = `You are a seasoned travel planner and a warm, knowledgeable local friend writing a ${clampedDays}-day itinerary for ${destination}. Your job is not just to list places — it is to plan a trip that FEELS right: well-paced, human, and considerate of how a real traveller's body and mood shift across the day. Most of the output is practical and clear. But in a few specific places — the summary, the proTip, and the activity note — you can let a little personality show: a dry observation, a knowing aside, a line that sounds like a smart friend rather than a guidebook.

QUALITY STANDARD — mandatory for every meal and activity:
Every restaurant, café, or food stop must be a named, established place with a real reputation — the kind featured in Lonely Planet, Condé Nast Traveller, food blogs, or local top-10 lists. No unnamed roadside stalls, no generic "local dhaba", no "chai wala" unless it is a genuinely famous institution known by name in travel editorial. If the restaurant pool below does not have enough quality options for a meal slot, replace that slot with a neighbourhood walk, a scenic stop, or a market browse — never invent a mediocre vendor.
The same standard applies to attractions: iconic, historic, famous, or trending — not just "a temple" or "a local area".

AVAILABLE ATTRACTIONS (use only these; do not invent new ones):
${attractionPool}

AVAILABLE RESTAURANTS (use only these for named meals):
${restaurantPool}
${experiencePool ? `\nAVAILABLE LOCAL EXPERIENCES:\n${experiencePool}` : ''}

FULL RESEARCH DATA (for costs, tips, opening hours, context):
${researchInput}

TRIP DETAILS:
- Destination: ${destination}
- Duration: ${clampedDays} days
- People: ${people}
- Budget: ${budget ? `₹${budget} total (₹${budgetPerDay}/day for the group)` : 'flexible'}
- Interests: ${interestStr}
- Arrival: Day 1 ${arrivalLabel}
- Departure: Day ${clampedDays} ${departureLabel}
${customDescription ? `- TRAVELLER INSTRUCTIONS (highest priority): "${customDescription}"` : ''}
${travelNotes ? `
── PERSONAL CONTEXT — read every word, apply thoughtfully ──
"${travelNotes}"

Personalisation rules (apply silently — do not announce them):
• Elderly / mobility issues → flag strenuous activities (long treks, steep climbs) with a gentle note like "May be tough on the knees — the café next door is a lovely alternative." For relaxed spots add warmth: "Easy on everyone — this one the whole group will love."
• Kids → note child-friendly angles; flag noisy/crowded spots; highlight interactive or open-air activities.
• Dietary restrictions → only include restaurants matching those constraints; clearly note where to ask for alternatives.
• Budget conscious → prioritise free/low-cost options; mention free-entry timings; lean on street food over sit-down meals where quality holds.
• Solo traveller → frame notes around independence, self-discovery, social cafés, and ease of navigation alone.
• Medical / physical conditions → acknowledge them briefly in the relevant activity note; never be alarmist, always suggest the softer alternative nearby.
Weave this into the "note" fields naturally — like a knowledgeable friend who already knows the group. Do NOT list these rules in the output.` : ''}

════════════════════════════════════════
RULE SET — every rule is mandatory
════════════════════════════════════════

── RULE 1: ZERO REPEATS ──
Every activity "name" must be globally unique across ALL ${clampedDays} days. Before writing each activity check mentally: "Have I used this place name on any previous day?" If yes, choose a different place.

── RULE 2: ENERGY FLOW (most important for feel) ──
Every activity has an energy level: HIGH (trek, long walk, temple hopping, cycling, water sport, 2h+ walking tour) | MEDIUM (single temple, museum, market stroll, cooking class) | LOW (cafe, scenic viewpoint by car/tuk-tuk, boat ride, shopping) | REST (hotel pool, spa, beach lounge, sit-down meal).
Sequence rule: after any HIGH activity, the NEXT activity must be LOW or REST. Never place two HIGH activities back-to-back. Afternoons in hot climates are naturally LOW/REST — use indoor spots, shaded cafes, air-conditioned museums, or pools.

── RULE 3: NARRATIVE CONTINUITY ──
The "note" field must be personal and contextual — reference what just happened or what's coming next. Write like a friend who has been there: warm, observational, specific. Keep it mostly sincere. A light, dry observation is welcome when it fits naturally, but don't force humour into serious or logistical moments (temples, long treks, safety-critical spots).
Keep notes SHORT — 1 sentence, 2 at most. Cut anything that can be implied.
Good examples:
  • After a long temple walk: "Your legs will thank you for stopping here — iced coffee, shaded terrace, no rush."
  • Before a sunset viewpoint: "Get here before the crowd does — the light at golden hour earns every cliché written about it."
  • First meal on arrival day: "Keep it light and local — the bigger adventures start tomorrow."
  • After an exhausting day: "Two minutes from the hotel, quiet dinner, exactly what today needs."
  • At a beloved local spot: "The queue is the review."
Never write generic notes like "great place to visit" or "famous attraction". Every note must be personal and contextual.

── RULE 4: ARRIVAL & DEPARTURE RITUALS ──
Day 1 — ALWAYS start with hotel check-in (type: "hotel", icon: "🏨", name: "Hotel Check-in & Freshen Up", area: use areas_to_stay from research). After check-in, give 30–60 min to settle. Then a gentle first activity: a short neighbourhood walk or a light snack at a nearby cafe — nothing that requires full energy. No museums, temples, or treks on Day 1 unless arrival was very early morning.
Day ${clampedDays} — End the day with an airport/station transfer (type: "transport", icon: "🚕", name: "Transfer to Airport / Station"). Before checkout, a final breakfast and one very short, sentimental farewell activity (a last cup of coffee at a favourite spot, a quick market stop for souvenirs) — nothing time-consuming.

── RULE 5: DAY SHAPE ──
Build each day like a story arc. Use these as anchor points — but the ACTUAL times flow from activity durations, not from these slots:
  ~08:00 AM  Breakfast (30–45 min sit-down, or 20 min if grab-and-go)
  ~09:00 AM  Morning activity (medium or high energy — body is fresh)
  ~11:30 AM  Second morning spot if nearby and low/medium energy
  ~01:00 PM  Lunch (45–60 min)
  ~02:30 PM  Afternoon activity — MUST be low or medium energy (hot, tired)
  ~05:00 PM  Golden hour — viewpoint, riverside, market, sunset spot
  ~07:30 PM  Dinner (60–90 min)
Target ${activitiesPerDay} activities per day (Day 1: fewer due to arrival; Day ${clampedDays}: fewer due to checkout).

── RULE 6: TIME FLOW — COHERENT, HUMAN, NOT MILITARY ──
This is NOT a school timetable. Real travel has friction, wandering, and spontaneous pauses.
The goal is coherence: a traveller reading the schedule should never wonder "wait, what happened between 10 AM and 1 PM?"

Mandatory fields for EVERY activity:
  • "time"        — start time in 12h format "HH:MM AM/PM"
  • "endTime"     — approximate finish time. Add duration to start time.
  • "travelToNext"— how to get to the next activity, specific and vivid: "15 min auto-rickshaw past the old bazaar", "10 min walk along the lake promenade", "quick 5 min cab". Never just "taxi" or "walk". OMIT for the last activity of the day.

Sensibility check — for every consecutive pair of activities, the sequence must make sense:
  endTime(N) + travelToNext(N) ≈ startTime(N+1)  (within ~15 min is fine)

Natural breathing room IS allowed — a 10–20 min buffer between arrival and the next start is fine, human, expected.
What is NOT allowed: large unexplained gaps (30+ min) where nothing is planned. If there is genuine downtime, name it:
  → post-lunch slow hour → "Slow Afternoon Wander through [neighbourhood name]"
  → waiting for golden hour → "Rooftop Chai at [café name] — watch the city slow down"
  → natural rest → "Rest & Freshen Up at Hotel"
Think of these not as filler but as the breaths between the big moments — they're often what travellers remember most.

── RULE 7: OPENING HOURS — STRICT SCHEDULING GATE ──
Every attraction/market/restaurant must pass this check BEFORE you schedule it:

  LATEST SAFE START = closing_time − duration − 30 min (last-entry buffer)

  Examples:
    • Place closes 5 PM, visit takes 2 h → latest start = 5:00 PM − 2:00 h − 0:30 = 2:30 PM. NEVER schedule after 2:30 PM.
    • Place closes 6 PM, visit takes 1 h → latest start = 4:30 PM.
    • Market closes 2 PM → NEVER in afternoon slot.
    • Sunrise viewpoint best at 6 AM → schedule at 5:45 AM or note the wake-up.

  If a place does NOT fit the timeslot you want, move it to the correct timeslot or swap it for a place that does fit.
  The golden-hour slot (5 PM) is ONLY for: open-air viewpoints, riverwalks, beaches, gardens, neighbourhoods, sunset spots — things with no closing time.

  VERIFIED vs ESTIMATED hours:
  • If the pool above says "hours_verified: YES" — use those hours exactly and set "hoursSource": "verified" in the activity JSON.
  • If it says "hours_verified: NO" or hours are "unknown" — use these safe defaults: attractions 9 AM–5:30 PM | restaurants 8 AM–10 PM | markets 6 AM–1 PM | beaches/parks all day. Set "hoursSource": "estimated".
  Never pretend estimated hours are verified.

  Put the hours in "openingHours" field. If scheduled within 45 min of opening → note: "Arrive right at opening — it fills up fast." If scheduled within 1 h of latest-safe-start → note: "Head straight in — last entry is 30 min before closing."

── RULE 7B: PRACTICAL HEADS-UPS ──
For each activity, populate the "headsUp" field with ONE critical practical note the user needs BEFORE arriving. Choose whichever applies:
  • Payment: "Cash only — no cards accepted"
  • Dress code: "Cover shoulders and knees; scarves available at entrance for ₹20"
  • Booking: "Reserve online at least a day ahead — walk-ins rarely get in"
  • Crowds: "Packed 10 AM–2 PM — go early or after 3 PM"
  • Access: "Shoes off at the entrance — wear slip-ons"
  • Safety: "Negotiate fare before boarding; metered tuk-tuks are cheaper"
  • Weather: "Outdoor — skip on heavy rain days; check forecast morning of"
  • Best day: "Closed on Mondays" or "Busiest on weekends — go weekday"
  ONLY include a headsUp if it is grounded in the research context or is a universally known fact for that type of place (e.g. temples require covered shoulders everywhere in Southeast Asia). Do NOT invent specific details like "cash only" unless the context says so. Set to null if nothing is grounded.

── RULE 8: CLUSTER ──
Group places in the same neighbourhood on the same day to minimise transit time and fatigue.

── RULE 9: MEALS ──
Never write "local restaurant", "street stall", or "nearby cafe". Always name the exact place and dish from the restaurant pool above.

── RULE 10: POOL EXHAUSTION ──
If named places run out for later days, use: a named neighbourhood walk (give the real street/neighbourhood name), a local market, a sunset viewpoint, a craft shopping lane. Never repeat a named venue.

── RULE 11: proTip ──
One genuinely specific, actionable insider tip per day. Not "carry water" or "wear sunscreen". Something that sounds like advice from someone who's been there — direct, specific, occasionally a dry observation when it fits naturally. E.g. "The queue at X forms before 8 AM — arrive at 7:45 and you'll walk straight in." or "Ask for the off-menu Y dish at Z — it's not on the board but locals always order it."

Return ONLY valid JSON, no markdown, no backticks, no comments.
Before writing the JSON, do a quick coherence scan: for each day, does the sequence of times make sense for a real traveller? Are there any unexplained 30+ min gaps? Fix them with a named filler activity before outputting.
{
  "headline": "compelling ${clampedDays}-day title",
  "summary": "2-sentence hook that makes the reader immediately want to go — specific, warm, with just a touch of personality. Never generic.",
  "totalEstimatedCost": "₹XX,XXX",
  "bestTimeToVisit": "string",
  "quickTips": ["tip1","tip2","tip3","tip4"],
  "days": [
    {
      "day": 1,
      "title": "Theme e.g. Arrival & Old Town First Impressions",
      "theme": "one-line mood / emotional tone of the day",
      "estimatedCost": "₹X,XXX",
      "proTip": "specific insider tip",
      "weather": { "high": 32, "low": 24, "condition": "Sunny", "tip": "One short weather-specific tip" },
      "activities": [
        {
          "time": "02:00 PM",
          "endTime": "03:00 PM",
          "travelToNext": "7 min walk down the main bazaar to the next spot",
          "name": "Hotel Check-in & Freshen Up",
          "type": "hotel",
          "energyLevel": "rest",
          "duration": "1 hour",
          "openingHours": "24 hours",
          "hoursSource": "verified",
          "note": "Drop your bags, take a cold shower, and breathe — the city will still be there in an hour.",
          "headsUp": "Keep your passport handy for check-in; most hotels hold rooms until 2 PM so call ahead if arriving early.",
          "cost": "included in stay",
          "icon": "🏨",
          "mustDo": false,
          "area": "Phuket Old Town"
        }
      ]
    }
  ]
}`;

    const itineraryText = await callGemini({
      messages: [{ role: 'user', content: itineraryPrompt }],
      maxTokens: phase3Tokens, temperature: 0.35,
    });
    console.log(`✅ [PHASE 3] ${itineraryText.length} chars`);

    const itinerary = await parseOrRepair(itineraryText, 'itinerary');

    // ── Server-side deduplication pass ─────────────────────────────────────────
    // Guarantees no activity appears twice even if the model slips.
    const seenActivities = new Set();
    let dupeCount = 0;
    for (const day of (itinerary.days || [])) {
      day.activities = (day.activities || []).filter(act => {
        const key = (act.name || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
        if (!key) return false;
        if (seenActivities.has(key)) { dupeCount++; return false; }
        seenActivities.add(key);
        return true;
      });
    }
    if (dupeCount > 0) console.warn(`⚠️  [DEDUP] Removed ${dupeCount} duplicate activit${dupeCount === 1 ? 'y' : 'ies'} server-side`);

    const actCount  = itinerary.days?.reduce((s, d) => s + (d.activities?.length || 0), 0) || 0;
    console.log(`🎉 [ITINERARY] Done — ${itinerary.days?.length || 0} days, ${actCount} activities`);

    res.json({ itinerary, sources });

  } catch (err) {
    console.error('❌ Itinerary error:', err.message);
    res.status(500).json({ error: 'Could not generate itinerary. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────
// LOCAL TASTE  — Supabase-cached, shared across all users
// Key: destination normalised to lowercase + trimmed
// ─────────────────────────────────────────────────────────────────
const sb = require('../lib/supabase');

router.post('/local-taste', async (req, res) => {
  const { destination } = req.body;
  if (!destination) return res.status(400).json({ error: 'destination is required.' });

  // Normalise key: "Phuket City  , Thailand" → "phuket city, thailand"
  const destKey = destination.toLowerCase().replace(/\s+/g, ' ').trim();

  // ── Cache hit: return stored data immediately ──────────────────
  try {
    const { data: cached, error: cacheErr } = await sb
      .from('destination_taste')
      .select('data')
      .eq('destination', destKey)
      .maybeSingle();
    if (cached && !cacheErr) {
      console.log(`⚡ [LOCAL TASTE] Cache hit: ${destKey}`);
      return res.json(cached.data);
    }
    if (cacheErr) console.warn('⚠️  [LOCAL TASTE] Supabase read error:', cacheErr.message);
  } catch (dbErr) {
    console.warn('⚠️  [LOCAL TASTE] Supabase read failed, continuing to generate:', dbErr.message);
  }

  // ── Cache miss: generate, then persist ────────────────────────
  console.log(`\n🍜 LOCAL TASTE: ${destination} (generating…)`);
  try {
    const searchResults = await serperMultiSearch([
      `${destination} most iconic must-eat dishes famous regional food specialty`,
      `${destination} legendary renowned acclaimed restaurants institutions top-rated`,
      `${destination} signature culinary experience famous food market heritage cooking`,
      `${destination} best restaurants Michelin Lonely Planet Conde Nast food guide`,
    ], 10);
    const { context } = await buildResearchContext(searchResults, 5);

    const tastePrompt = `You are a senior food & travel editor writing the definitive local taste guide for "${destination}". Your readers are discerning travellers who will cross-check everything — so every single item must be genuinely famous, regionally significant, or a well-known local institution. Nothing generic, nothing that could apply to any city. Write with authority and warmth. In the tagline and the closing tip you can let a little personality show — but the dish and place descriptions stay clear, specific, and informative.

RESEARCH CONTEXT:
${context}

PRIORITY RULE — THE CRUX FIRST:
The single most important job of this guide is to answer: "What are the absolute non-negotiables of ${destination}? The things that, if missed, make the trip feel incomplete?"
Apply this test to every item before including it: "Would a well-travelled food writer say — you went to ${destination} and didn't have/see/do THIS?" If yes, it belongs at the TOP of its section. If no, it goes below or is excluded.
- DISHES: Lead with the dishes that ARE ${destination} — the ones on every food map, in every travel magazine, that locals are proud of. Not just good food — defining food. Rank them so the most iconic appears first.
- PLACES: Lead with the unmissable landmark institutions — the restaurant/market/stall that has been there for generations, the one everyone references. Then add the newer celebrated ones.
- EXPERIENCES: Lead with the things that are uniquely possible HERE and nowhere else. Not generic "cooking class" — the specific morning market walk, the specific street that's famous for one dish, the festival food tradition.
Within each section, order by importance: most essential → highly recommended → interesting bonus. Never bury the headline item.

QUALITY BAR — an item only makes the list if it passes ALL of these:
1. It is specifically named (a real dish name, a real establishment name — never "local curry", "roadside stall", or "street market")
2. It is explicitly mentioned or strongly implied in the research context above
3. It is famous or regionally defining — the kind of thing written about in Lonely Planet, food magazines, or award lists
4. It would genuinely disappoint a knowledgeable traveller if they missed it
5. For PLACES: it must be a named institution with a reputation — a specific restaurant, a specific stall with a name, a named market. Not just "a good spot". Unnamed vendors, generic dhabas, and "local tea shops" do not qualify unless they are famous institutions known by name in travel writing.

For DISHES: include only the signature, regionally-defining dishes of ${destination}. The kind you read about before you visit. Describe what makes THIS version unique vs elsewhere.
For PLACES: only include restaurants, stalls, or markets that are named institutions — places with a reputation, a history, or a loyal following. Not just "a good place for pad thai".
For EXPERIENCES: only food-related experiences that are distinctly local — a specific morning market, a particular cooking style, a neighbourhood known for a single dish, a festival food tradition.

Return ONLY valid JSON (no markdown, no backticks):
{
  "headline": "${destination} — Local Flavours",
  "tagline": "one punchy line capturing this destination's food soul",
  "dishes": [
    {
      "emoji": "🍜",
      "name": "exact dish name",
      "desc": "what makes it special here specifically, and the best-known place to get it",
      "rating": 4.7,
      "priceRange": "₹80–150 per person",
      "bestTime": "breakfast",
      "tags": ["must-try"]
    }
  ],
  "places": [
    {
      "emoji": "📍",
      "name": "exact restaurant / stall / market name",
      "desc": "why it is an institution — its history, signature item, or what locals say about it",
      "rating": 4.5,
      "priceRange": "₹200–400 per person",
      "bestTime": "dinner",
      "tags": ["iconic"]
    }
  ],
  "experiences": [
    {
      "emoji": "✨",
      "name": "specific named experience",
      "desc": "why a traveller would regret missing this — be specific",
      "rating": 4.8,
      "priceRange": "free",
      "bestTime": "early morning",
      "tags": ["offbeat"]
    }
  ],
  "tip": "one ultra-specific insider tip — a timing hack, an off-menu order, a neighbourhood secret most tourists miss. Direct and specific, with a touch of personality if it fits."
}
Rules:
- 5–6 items in dishes, 4–5 in places, 3–4 in experiences
- Every entry must be specific, named, and pass the quality bar above
- Never repeat the same place across sections
- "rating" is a float 1.0–5.0 based on what the research context suggests about popularity/acclaim; omit if no signal
- "priceRange" is approximate cost per person; ALWAYS append "per person" e.g. "₹80–150 per person" or "free"; use local currency symbol
- "bestTime" is when to go: e.g. "breakfast", "lunch", "dinner", "early morning", "evening", "anytime", "weekends only"
- Tags choose from: must-try, must-do, iconic, heritage, scenic, culture, offbeat, hidden-gem, seasonal, local-favourite
- Use ONLY information grounded in the research context`;

    const tasteText = await callGemini({
      messages: [{ role: 'user', content: tastePrompt }],
      maxTokens: 3500, temperature: 0.15,
    });
    const data = await parseOrRepair(tasteText, 'local taste');
    console.log(`✅ [LOCAL TASTE] ${data.dishes?.length} dishes, ${data.places?.length} places`);

    // ── Persist to Supabase (upsert in case of race condition) ─────
    try {
      const { error: writeErr } = await sb
        .from('destination_taste')
        .upsert({ destination: destKey, data, updated_at: new Date().toISOString() });
      if (writeErr) throw writeErr;
      console.log(`💾 [LOCAL TASTE] Saved to Supabase: ${destKey}`);
    } catch (dbErr) {
      console.warn('⚠️  [LOCAL TASTE] Supabase write failed (non-fatal):', dbErr.message);
    }

    res.json(data);

  } catch (err) {
    console.error('❌ Local taste error:', err.message);
    res.status(500).json({ error: 'Could not fetch local taste data.' });
  }
});

// ─────────────────────────────────────────────────────────────────
// PHOTOS — ImageKit (primary) → Serper Images → Wikimedia Commons
// Cache hierarchy:
//   L1: in-memory Map (fast, per-process, 6h TTL)
//   L2: Supabase table photo_url_cache (persistent across restarts)
//   L3: IK HEAD check → upload → serve IK URL
// ─────────────────────────────────────────────────────────────────
const photoCache     = new Map();
const PHOTO_CACHE_MS = 6 * 60 * 60 * 1000;
const PHOTO_NOISE    = /flag|logo|map|seal|coat|icon|emblem|portrait|locator|location|blank|outline|stub/i;
const IK_UPLOAD_URL  = 'https://upload.imagekit.io/api/v1/files/upload';
const IK_API_URL     = 'https://api.imagekit.io/v1';

function ikAuthHeader() {
  return 'Basic ' + Buffer.from((process.env.IMAGEKIT_PRIVATE_KEY || '') + ':').toString('base64');
}
function ikNormalize(q) {
  return q.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 120);
}
function ikAutoUrl(filename) {
  const base = (process.env.IMAGEKIT_URL_ENDPOINT || '').replace(/\/$/, '');
  return `${base}/tb-photos/auto/${filename}.jpg`;
}
async function ikExists(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}
async function ikUploadFromUrl(sourceUrl, filename) {
  const form = new FormData();
  form.append('file', sourceUrl);       // IK accepts a URL directly
  form.append('fileName', filename + '.jpg');
  form.append('folder', '/tb-photos/auto');
  form.append('useUniqueFileName', 'false');
  const res = await fetch(IK_UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: ikAuthHeader() },
    body: form,
  });
  const data = await res.json();
  if (!data.url) throw new Error(`IK upload failed: ${data.message || JSON.stringify(data)}`);
  return data.url;
}

// ── Serper Images ────────────────────────────────────────────────
// Smart suffix: food/dish queries → no generic suffix (dish names don't need
// "travel photo"); attraction/shopping → "photo high resolution"
function photoSearchQuery(q) {
  const ql = q.toLowerCase();
  if (/\bfood\b|\bdish\b|\brestaurant\b|\bcuisine\b|\bstreet food\b|\bcafe\b|\bsweet\b/.test(ql)) {
    // For food: just the name, Serper already knows
    return q;
  }
  if (/\bhotel\b|\bstay\b|\bresort\b/.test(ql)) {
    return `${q} exterior interior`;
  }
  // Attraction / experience / shopping — use clean "photo" suffix
  return `${q} photo`;
}

async function serperImageSearch(q) {
  const key = process.env.SERPER_PHOTOS_API_KEY;
  if (!key) throw new Error('SERPER_PHOTOS_API_KEY not set');
  const res = await fetch('https://google.serper.dev/images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
    body: JSON.stringify({ q: photoSearchQuery(q), num: 10, gl: 'in', hl: 'en' }),
  });
  if (!res.ok) throw new Error(`Serper Images HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Serper Images: ${data.error}`);
  return (data.images || [])
    .filter(img =>
      img.imageUrl &&
      /\.(jpg|jpeg|png|webp)/i.test(img.imageUrl) &&
      !PHOTO_NOISE.test((img.title || '').toLowerCase())
    )
    .map(img => img.imageUrl)
    .slice(0, 3);
}

// ── Wikimedia Commons (fallback) ─────────────────────────────────
async function commonsSearch(q, limit = 15) {
  const url =
    `https://commons.wikimedia.org/w/api.php?action=query` +
    `&generator=search&gsrsearch=${encodeURIComponent(q)}` +
    `&gsrnamespace=6&gsrlimit=${limit}` +
    `&prop=imageinfo&iiprop=url|size&iiurlwidth=900` +
    `&format=json&origin=*`;
  const r = await fetch(url, { headers: { 'User-Agent': 'TravelBae/1.0 (contact@travelbae.app)' } });
  const data = await r.json();
  return Object.values(data.query?.pages || {})
    .filter(p => {
      const info = p.imageinfo?.[0];
      if (!info?.url) return false;
      if (PHOTO_NOISE.test((p.title || '').toLowerCase())) return false;
      if (!/\.(jpg|jpeg|png|webp)$/i.test(info.url)) return false;
      if (info.width && info.height && info.width < info.height) return false;
      return true;
    })
    .map(p => p.imageinfo[0].thumburl || p.imageinfo[0].url);
}
async function wikimediaFallback(q) {
  let urls = await commonsSearch(`${q} monument landmark historic`);
  if (urls.length < 3) urls = [...new Set([...urls, ...await commonsSearch(q)])];
  if (urls.length < 3) {
    const bare = q.split(',')[0].trim();
    if (bare !== q) urls = [...new Set([...urls, ...await commonsSearch(bare)])];
  }
  return urls.slice(0, 3);
}

// ── Route ────────────────────────────────────────────────────────
router.get('/photos', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });

  // L1: in-memory
  if (photoCache.has(q)) return res.json({ urls: photoCache.get(q) });

  // L2: Supabase persistent cache
  try {
    const { data: sbRow } = await sb
      .from('photo_url_cache')
      .select('urls')
      .eq('query', q)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (sbRow?.urls) {
      const urls = sbRow.urls;
      photoCache.set(q, urls);
      setTimeout(() => photoCache.delete(q), PHOTO_CACHE_MS);
      console.log(`📸 [PHOTOS] "${q}" → Supabase L2 hit`);
      return res.json({ urls });
    }
  } catch (sbErr) {
    console.warn(`⚠️ [PHOTOS] Supabase L2 read failed for "${q}":`, sbErr.message);
  }

  const filename  = ikNormalize(q);
  const ikUrl     = ikAutoUrl(filename);
  const ikEnabled = !!(process.env.IMAGEKIT_PRIVATE_KEY && process.env.IMAGEKIT_URL_ENDPOINT);

  // 1. ImageKit cache check
  if (ikEnabled && await ikExists(ikUrl)) {
    console.log(`📸 [PHOTOS] "${q}" → ImageKit hit`);
    photoCache.set(q, [ikUrl]);
    setTimeout(() => photoCache.delete(q), PHOTO_CACHE_MS);
    return res.json({ urls: [ikUrl] });
  }

  // 2. Serper Images (primary source)
  let rawUrls = [];
  let source  = 'none';
  try {
    rawUrls = await serperImageSearch(q);
    if (rawUrls.length > 0) source = 'serper';
  } catch (err) {
    console.warn(`⚠️ [PHOTOS] Serper failed for "${q}": ${err.message}`);
  }

  // 3. Wikimedia fallback
  if (rawUrls.length === 0) {
    try {
      rawUrls = await wikimediaFallback(q);
      if (rawUrls.length > 0) source = 'wikimedia';
    } catch (err) {
      console.warn(`⚠️ [PHOTOS] Wikimedia failed for "${q}": ${err.message}`);
    }
  }

  // 4. Upload first URL to ImageKit (fire-and-forget style — don't block response)
  let finalUrls = rawUrls;
  if (rawUrls.length > 0 && ikEnabled) {
    try {
      const uploaded = await ikUploadFromUrl(rawUrls[0], filename);
      finalUrls = [uploaded, ...rawUrls.slice(1)];
      source += '+imagekit';
    } catch (err) {
      console.warn(`⚠️ [PHOTOS] IK upload failed for "${q}": ${err.message}`);
    }
  }

  photoCache.set(q, finalUrls);
  setTimeout(() => photoCache.delete(q), PHOTO_CACHE_MS);

  // Persist to Supabase L2 (async, don't block response)
  if (finalUrls.length > 0) {
    const expiresAt = new Date(Date.now() + PHOTO_CACHE_MS).toISOString();
    sb.from('photo_url_cache')
      .upsert({ query: q, urls: finalUrls, expires_at: expiresAt })
      .then(({ error }) => {
        if (error) console.warn(`⚠️ [PHOTOS] Supabase L2 write failed for "${q}":`, error.message);
      })
      .catch(err => console.warn(`⚠️ [PHOTOS] Supabase L2 write failed for "${q}":`, err.message));
  }

  console.log(`📸 [PHOTOS] "${q}" → ${finalUrls.length} via ${source}`);
  res.json({ urls: finalUrls });
});

// ─────────────────────────────────────────────────────────────────
// IMAGEKIT AUTH — generate upload credentials for frontend direct upload
// Frontend uses these to upload user photos straight to ImageKit
// without the file going through our backend server
// ─────────────────────────────────────────────────────────────────
router.get('/imagekit-auth', (req, res) => {
  const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
  if (!privateKey) return res.status(500).json({ error: 'ImageKit not configured' });
  const token     = crypto.randomUUID();
  const expire    = Math.floor(Date.now() / 1000) + 3600;     // 1 hour
  const signature = crypto.createHmac('sha1', privateKey).update(token + expire).digest('hex');
  res.json({
    token,
    expire,
    signature,
    publicKey:   process.env.IMAGEKIT_PUBLIC_KEY,
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
  });
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
