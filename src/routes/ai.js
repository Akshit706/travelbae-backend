// src/routes/ai.js
// AI proxy using Google Gemini (gemini-1.5-flash).
// Your frontend calls /ai/chat — this server calls Gemini using the key in .env.
// The API key never touches the browser.
//
// POST /ai/chat       — chatbot message
// POST /ai/itinerary  — generate a trip itinerary

const express = require('express');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// Gemini API endpoint
function geminiUrl() {
  return `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
}

// Internal helper: call Gemini
// Gemini doesn't have a "system" field like Anthropic/OpenAI.
// We prepend the system prompt as the first user turn instead.
async function callGemini({ system, messages, maxTokens = 1000 }) {
  const contents = [];

  // Inject system prompt as first user message if provided
  if (system) {
    contents.push({
      role: 'user',
      parts: [{ text: `[Instructions for you]: ${system}` }],
    });
    // Gemini requires alternating turns, so add a dummy model ack
    contents.push({
      role: 'model',
      parts: [{ text: 'Understood. I will follow those instructions.' }],
    });
  }

  // Add the actual conversation messages
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
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.7,
      },
    }),
  });

  const data = await res.json();

  if (data.error) {
    throw new Error(data.error.message || 'Gemini API error');
  }

  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── TRIP CHATBOT ────────────────────────────────────────
// Body: { system, messages }
// messages = [{ role: 'user' | 'assistant', content: string }]
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

// ── GENERATE ITINERARY ──────────────────────────────────
// Body: { destination, days, interests }
router.post('/itinerary', async (req, res) => {
  const { destination, days, interests } = req.body;

  if (!destination || !days) {
    return res.status(400).json({ error: 'destination and days are required.' });
  }

  const prompt = `
    Create a detailed ${days}-day travel itinerary for ${destination}.
    ${interests?.length ? `Traveller interests: ${interests.join(', ')}.` : ''}
    
    Return ONLY valid JSON in this exact format, no explanation, no markdown, no backticks:
    {
      "days": [
        {
          "day": 1,
          "items": [
            { "time": "09:00 AM", "title": "Activity name", "note": "Short tip", "icon": "🏰" }
          ]
        }
      ]
    }
  `;

  try {
    const text = await callGemini({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 1500,
    });

    const clean = text.replace(/```json|```/g, '').trim();
    const itinerary = JSON.parse(clean);
    res.json({ itinerary });
  } catch (err) {
    console.error('Gemini itinerary error:', err.message);
    res.status(500).json({ error: 'Could not generate itinerary.' });
  }
});

module.exports = router;
