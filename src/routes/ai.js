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
async function buildResearchContext(searchResults) {
  const organic = searchResults.filter(r => r.type === 'organic');
  const sorted  = [...organic].sort((a, b) => preferScore(b.url) - preferScore(a.url));
  const toFetch = sorted.filter(r => shouldFetch(r.url)).slice(0, FETCH_TOP_N);

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
    arrivalSlot, departureSlot,
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
    const searchResults = await serperMultiSearch([
      `${destination} top attractions things to do travel guide`,
      `${destination} best restaurants local food street food where to eat`,
      `${destination} hidden gems offbeat local tips travel`,
      `${destination} travel tips practical guide transport budget`,
    ], 8);
    const { context: researchContext, sources } = await buildResearchContext(searchResults);

    // ── PHASE 2: Structured extraction ────────────────────────
    console.log('\n🧠 PHASE 2: Structured extraction');
    // Scale extraction and build limits based on trip length
    const maxAttractions    = Math.min(Math.max(20, clampedDays * 2), 50);
    const maxRestaurants    = Math.min(Math.max(12, clampedDays), 30);
    const maxExperiences    = Math.min(Math.max(6,  Math.floor(clampedDays / 2)), 15);
    // ~1400 tokens/day for activities + metadata, minimum 8000, cap at model limit
    const phase3Tokens      = Math.min(Math.max(8000, clampedDays * 1400), 65000);
    const phase2Tokens      = Math.min(Math.max(6000, clampedDays * 300),  16000);

    const extractionPrompt = `You are a travel data analyst. Extract structured travel information from the research context below.

DESTINATION: ${destination}
${budget ? `BUDGET: ₹${budget} total (₹${budgetPerDay}/day) for ${people} person(s)` : ''}
INTERESTS: ${interestStr}

RESEARCH CONTEXT:
${researchContext}

Return ONLY valid JSON (no markdown, no backticks). Use ONLY information from the context. Omit any field you cannot find — never invent data:
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
      "name": "exact place name",
      "type": "temple|museum|market|beach|viewpoint|park|heritage|experience",
      "rating": "4.5",
      "area": "neighbourhood",
      "opening_hours": "9 AM – 6 PM",
      "entry_fee": "₹200 or Free",
      "duration": "1-2 hours",
      "best_for": "what it is famous for",
      "insider_tip": "specific tip tourists miss",
      "priority": "must_do|recommended|if_time_permits"
    }
  ],
  "restaurants": [
    {
      "name": "exact name",
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
  "areas_to_stay": ["area1 — why","area2 — why"],
  "what_to_avoid": ["avoid1","avoid2","avoid3"]
}
Max: ${maxAttractions} attractions, ${maxRestaurants} restaurants, ${maxExperiences} local_experiences.`;

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

    const itineraryPrompt = `You are an expert travel planner. Build a PERFECT ${clampedDays}-day itinerary for ${destination} using ONLY the structured research data below. Do not invent places not in the data.

RESEARCH DATA:
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

RULES:
1. Cluster nearby places on the same day — minimise backtracking
2. Mornings: popular/crowded spots. Afternoons: leisurely. Evenings: food, markets, sunset
3. Day 1: gentle arrival + orientation. Day ${clampedDays}: checkout-friendly, near transport
4. Every meal slot must name a specific restaurant/stall + what to order
5. At least one local/hidden-gem experience per day
6. Stay within budget; note approximate costs
7. Add a "proTip" per day (something most tourists miss)

Return ONLY valid JSON, no markdown, no backticks, no comments:
{
  "headline": "compelling ${clampedDays}-day title",
  "summary": "2-sentence hook",
  "totalEstimatedCost": "₹XX,XXX",
  "bestTimeToVisit": "string",
  "quickTips": ["tip1","tip2","tip3","tip4"],
  "days": [
    {
      "day": 1,
      "title": "Theme e.g. Old City & Street Food Trail",
      "theme": "one-line mood",
      "estimatedCost": "₹X,XXX",
      "proTip": "insider tip most tourists miss",
      "weather": { "high": 32, "low": 24, "condition": "Sunny", "tip": "Carry water" },
      "activities": [
        {
          "time": "08:00 AM",
          "name": "Exact place name from research",
          "type": "attraction|food|experience|transport|hotel|shopping",
          "duration": "1.5 hours",
          "note": "specific insider detail",
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
      maxTokens: phase3Tokens, temperature: 0.3,
    });
    console.log(`✅ [PHASE 3] ${itineraryText.length} chars`);

    const itinerary = await parseOrRepair(itineraryText, 'itinerary');
    const actCount  = itinerary.days?.reduce((s, d) => s + (d.activities?.length || 0), 0) || 0;
    console.log(`🎉 [ITINERARY] Done — ${itinerary.days?.length || 0} days, ${actCount} activities`);

    res.json({ itinerary, sources });

  } catch (err) {
    console.error('❌ Itinerary error:', err.message);
    res.status(500).json({ error: 'Could not generate itinerary. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────
// LOCAL TASTE
// ─────────────────────────────────────────────────────────────────
router.post('/local-taste', async (req, res) => {
  const { destination } = req.body;
  if (!destination) return res.status(400).json({ error: 'destination is required.' });

  console.log(`\n🍜 LOCAL TASTE: ${destination}`);
  try {
    const searchResults = await serperMultiSearch([
      `${destination} must eat local food dishes authentic cuisine`,
      `${destination} best street food stalls local restaurants hidden gems`,
    ], 8);
    const { context } = await buildResearchContext(searchResults);

    const tastePrompt = `You are a food travel writer. Extract a local taste guide for "${destination}" using ONLY the research context below.

RESEARCH CONTEXT:
${context}

Return ONLY valid JSON (no markdown, no backticks):
{
  "headline": "${destination} — Local Flavours",
  "tagline": "one-liner about this destination's food identity",
  "dishes": [
    { "emoji": "🍜", "name": "exact dish name", "desc": "where to get it and what makes it special", "tags": ["must-try"] }
  ],
  "places": [
    { "emoji": "📍", "name": "exact place name", "desc": "what makes it unmissable", "tags": ["iconic"] }
  ],
  "experiences": [
    { "emoji": "✨", "name": "experience name", "desc": "why locals love it", "tags": ["offbeat"] }
  ],
  "tip": "single best insider tip a local would give"
}
Rules:
- Exactly 4 items in each array
- Every entry must be specific and named — no generics
- Tags: must-try, must-do, iconic, heritage, scenic, culture, offbeat, hidden-gem, seasonal
- Use ONLY information from the context`;

    const tasteText = await callGemini({
      messages: [{ role: 'user', content: tastePrompt }],
      maxTokens: 2000, temperature: 0.1,
    });
    const data = await parseOrRepair(tasteText, 'local taste');
    console.log(`✅ [LOCAL TASTE] ${data.dishes?.length} dishes, ${data.places?.length} places`);
    res.json(data);

  } catch (err) {
    console.error('❌ Local taste error:', err.message);
    res.status(500).json({ error: 'Could not fetch local taste data.' });
  }
});

// ─────────────────────────────────────────────────────────────────
// PHOTOS — Wikimedia Commons, 1-hour cache
// ─────────────────────────────────────────────────────────────────
const photoCache  = new Map();
const PHOTO_NOISE = /flag|logo|map|seal|coat|icon|emblem|portrait|locator|location|blank|outline|stub/i;

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
