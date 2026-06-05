// // src/routes/ai.js
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

const express = require('express');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ── Gemini URLs ─────────────────────────────────────────
// function geminiUrl(model = 'gemini-3.1-flash-lite') {
function geminiUrl(model = 'gemini-2.5-flash') {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
}

// ── Core Gemini caller (no grounding) ───────────────────
async function callGemini({ system, messages, maxTokens = 1000, temperature = 0.7 }) {
  const contents = [];

  if (system) {
    contents.push({ role: 'user', parts: [{ text: `[Instructions]: ${system}` }] });
    contents.push({ role: 'model', parts: [{ text: 'Understood.' }] });
  }

  for (const msg of messages) {
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    });
  }

  const res = await fetch(geminiUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      generationConfig: { maxOutputTokens: maxTokens, temperature },
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Gemini API error');
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── Gemini with Google Search Grounding ─────────────────
// Uses real-time web search to pull data from TripAdvisor,
// Lonely Planet, Google Travel, Nomadic Matt, WikiVoyage etc.
async function callGeminiWithSearch({ prompt, maxTokens = 8000, temperature = 0.3 }) {
  // const res = await fetch(geminiUrl('gemini-3.1-flash-lite'), {
  const res = await fetch(geminiUrl('gemini-2.5-flash'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature,
      },
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Gemini Search error');

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const groundingMetadata = data.candidates?.[0]?.groundingMetadata || null;

  return { text, groundingMetadata };
}

function extractJsonObject(text) {
  const clean = String(text || '').replace(/```json|```/gi, '').trim();
  const start = clean.indexOf('{');
  if (start === -1) throw new Error('No JSON object start found.');

  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let i = start; i < clean.length; i += 1) {
    const ch = clean[i];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (ch === '\\') {
        escaping = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return clean.slice(start, i + 1);
    }
  }

  const end = clean.lastIndexOf('}');
  if (end !== -1 && end > start) return clean.slice(start, end + 1);
  throw new Error('No complete JSON object found.');
}

function parseJsonLenient(text) {
  const candidate = extractJsonObject(text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(candidate);
}

async function parseOrRepairJson(rawText, shapeHint = 'itinerary') {
  try {
    return parseJsonLenient(rawText);
  } catch (firstErr) {
    const repairPrompt = `
You will receive malformed JSON that should represent a ${shapeHint} object.
Return ONLY corrected valid JSON with the same data intent.
Do not add markdown fences. Do not add comments.

MALFORMED JSON:
${String(rawText || '').slice(0, 120000)}
`;

    const repairedText = await callGemini({
      messages: [{ role: 'user', content: repairPrompt }],
      maxTokens: 9000,
      temperature: 0,
    });

    try {
      return parseJsonLenient(repairedText);
    } catch {
      throw firstErr;
    }
  }
}

// ── CHATBOT ─────────────────────────────────────────────
router.post('/chat', async (req, res) => {
  const { system, messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required.' });
  }
  try {
    const reply = await callGemini({ system, messages, maxTokens: 500 });
    res.json({ reply });
  } catch (err) {
    console.error('Gemini chat error:', err.message);
    res.status(500).json({ error: 'AI service unavailable. Try again.' });
  }
});

// ── ITINERARY ────────────────────────────────────────────
// Body: { destination, days, budget, people, interests }
router.post('/itinerary', async (req, res) => {
  const { destination, days, budget, people = 1, interests = [], customDescription } = req.body;

  if (!destination || !days) {
    return res.status(400).json({ error: 'destination and days are required.' });
  }

  const budgetPerDay = budget ? Math.round(budget / days) : null;
  const interestStr = interests.length ? interests.join(', ') : 'general sightseeing, food, culture';

  try {
    // ── PHASE 1: Research via Google Search Grounding ──
    // Pull real ranked data from top travel sites
    const researchPrompt = `
You are a world-class travel researcher. Search the web RIGHT NOW for the most up-to-date, highly-rated travel information about "${destination}".

Search across these sources: TripAdvisor, Google Travel, Lonely Planet, Nomadic Matt, WikiVoyage, Condé Nast Traveler, Travel + Leisure, local tourism boards, and recent travel blogs from 2024-2025.

For "${destination}", find and RANK the following by popularity, rating, and traveller reviews:

1. TOP 20 ATTRACTIONS (rank by TripAdvisor/Google rating, include opening hours, entry fees in INR if applicable, best time to visit, how long to spend)
2. TOP 15 RESTAURANTS & STREET FOOD (rank by reviews, include signature dishes, price range, area/neighbourhood)  
3. TOP 10 LOCAL EXPERIENCES (unique things only locals know, hidden gems, cultural immersions)
4. TOP 5 SHOPPING SPOTS (local markets, what to buy)
5. PRACTICAL INFO (best areas to stay, local transport options, average costs, safety tips, weather for this time of year)
6. WHAT TO AVOID (overrated spots, tourist traps, scam alerts)

${budgetPerDay ? `Budget: ₹${budget} total (₹${budgetPerDay}/day) for ${people} person(s). Filter recommendations accordingly.` : ''}
Interests: ${interestStr}

Return this as structured data I can use to build an itinerary. Be extremely specific with names, locations, ratings.
`;

    let researchData = '';
    let sources = [];

    try {
      const { text, groundingMetadata } = await callGeminiWithSearch({
        prompt: researchPrompt,
        maxTokens: 6000,
        temperature: 0.2,
      });
      researchData = text;

      // Extract source URLs from grounding metadata
      if (groundingMetadata?.groundingChunks) {
        sources = groundingMetadata.groundingChunks
          .filter(c => c.web?.uri)
          .map(c => ({ title: c.web.title || c.web.uri, url: c.web.uri }))
          .slice(0, 8);
      }
    } catch (searchErr) {
      console.warn('Search grounding failed, falling back to trained knowledge:', searchErr.message);
      // Fallback: use Gemini's trained knowledge without grounding
      researchData = await callGemini({
        messages: [{ role: 'user', content: researchPrompt }],
        maxTokens: 4000,
        temperature: 0.3,
      });
    }

    // ── PHASE 2: Build the itinerary from research ──
    const itineraryPrompt = `
You are the world's best travel planner — better than any app or website. 
Using the research below, build the PERFECT ${days}-day itinerary for ${destination}.

RESEARCH DATA:
${researchData}

TRIP DETAILS:
- Destination: ${destination}
- Duration: ${days} days
- People: ${people}
- Budget: ${budget ? `₹${budget} total (₹${budgetPerDay}/day per group)` : 'flexible'}
- Interests: ${interestStr}
${customDescription ? `- Special instructions from traveler (HIGHEST PRIORITY — follow these closely): "${customDescription}"` : ''}

ITINERARY RULES:
1. Order activities logically by geography — cluster nearby spots on the same day to minimise travel
2. Start mornings with the most popular/crowded spots (beat the crowd)
3. Mix top-rated attractions with hidden gems and local experiences
4. Include specific meal recommendations at each mealtime — name the restaurant/stall and what to order
5. Add realistic time estimates for each activity
6. Include practical tips (how to get there, what to wear, what to bring, best photo spots)
7. First day: arrive + light exploration + orientation. Last day: checkout-friendly activities
8. If budget provided, stay within it and note approximate costs
9. Include at least one unique local experience per day that tourists usually miss

Return ONLY valid JSON — no markdown, no backticks, no explanation:
{
  "headline": "The Perfect ${days}-Day ${destination} Experience",
  "summary": "2-sentence compelling summary of this itinerary",
  "totalEstimatedCost": "₹XX,XXX",
  "bestTimeToVisit": "string",
  "quickTips": ["tip1", "tip2", "tip3", "tip4"],
  "days": [
    {
      "day": 1,
      "title": "Day theme e.g. Old City & Street Food Trail",
      "theme": "one-line mood e.g. History, architecture & authentic flavours",
      "estimatedCost": "₹X,XXX",
      "weather": { "high": 28, "low": 14, "condition": "Clear", "tip": "Wear sunscreen" },
      "activities": [
        {
          "time": "08:00 AM",
          "name": "Specific place name",
          "type": "attraction|food|experience|transport|hotel|shopping",
          "duration": "1.5 hours",
          "note": "Specific insider tip — what to see, what to order, hidden detail",
          "cost": "₹200 per person",
          "rating": "4.7 ⭐",
          "icon": "🏰",
          "mustDo": true
        }
      ]
    }
  ]
}
`;

    const itineraryText = await callGemini({
      messages: [{ role: 'user', content: itineraryPrompt }],
      maxTokens: 8000,
      temperature: 0.4,
    });

    const itinerary = await parseOrRepairJson(itineraryText, 'travel itinerary');

    res.json({ itinerary, sources });

  } catch (err) {
    console.error('Itinerary generation error:', err.message);
    res.status(500).json({ error: 'Could not generate itinerary. Please try again.' });
  }
});

// ── LOCAL TASTE (food + places + experiences) ────────────
// Body: { destination }
router.post('/local-taste', async (req, res) => {
  const { destination } = req.body;
  if (!destination) return res.status(400).json({ error: 'destination is required.' });

  try {
    const prompt = `
Search the web for the most authentic, highly-rated local food experiences, must-visit places, and unique experiences in "${destination}". 
Use TripAdvisor, Zomato, local food blogs, Google reviews from 2024-2025.

Return ONLY valid JSON:
{
  "headline": "${destination} — Local Flavours",
  "tagline": "compelling one-liner",
  "dishes": [
    { "emoji": "🍜", "name": "dish name", "desc": "where to get it and why it's special", "tags": ["must-try"] }
  ],
  "places": [
    { "emoji": "📍", "name": "place name", "desc": "what makes it special", "tags": ["iconic"] }
  ],
  "experiences": [
    { "emoji": "✨", "name": "experience name", "desc": "why locals love it", "tags": ["offbeat"] }
  ],
  "tip": "single best insider tip a local would give"
}

4 items each. Only real, specific, highly-rated options.
`;

    let text;
    try {
      const result = await callGeminiWithSearch({ prompt, maxTokens: 2000, temperature: 0.3 });
      text = result.text;
    } catch {
      text = await callGemini({ messages: [{ role: 'user', content: prompt }], maxTokens: 2000 });
    }

    const data = await parseOrRepairJson(text, 'local taste guide');
    res.json(data);
  } catch (err) {
    console.error('Local taste error:', err.message);
    res.status(500).json({ error: 'Could not fetch local taste data.' });
  }
});


const photoCache = new Map();

// Shared noise filter – skip flags, maps, logos, portraits, SVG/GIF
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
      const fname = (p.title || '').toLowerCase();
      if (PHOTO_NOISE_RE.test(fname)) return false;
      if (!/\.(jpg|jpeg|png|webp)$/i.test(info.url)) return false;
      // prefer landscape / reasonable size
      if (info.width && info.height && info.width < info.height) return false;
      return true;
    })
    .map(p => p.imageinfo[0].thumburl || p.imageinfo[0].url);
}

router.get('/photos', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });

  if (photoCache.has(q)) {
    return res.json({ urls: photoCache.get(q) });
  }

  try {
    // Pass 1 — landmark-specific
    let urls = await commonsSearch(`${q} monument landmark historic`);

    // Pass 2 — broader if still short
    if (urls.length < 3) {
      const more = await commonsSearch(q);
      urls = [...new Set([...urls, ...more])];
    }

    // Pass 3 — strip qualifiers, bare city/place name
    if (urls.length < 3) {
      const bare = q.split(',')[0].trim();
      if (bare !== q) {
        const more = await commonsSearch(bare);
        urls = [...new Set([...urls, ...more])];
      }
    }

    const result = urls.slice(0, 3);
    photoCache.set(q, result);
    setTimeout(() => photoCache.delete(q), 60 * 60 * 1000);

    res.json({ urls: result });
  } catch (err) {
    console.error('Wikimedia photos error:', err.message);
    res.status(500).json({ error: 'Could not fetch photos' });
  }
});



module.exports = router;
