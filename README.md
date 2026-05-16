# TravelBae Backend — Complete Setup Guide

You're a frontend developer. This guide is written for you.
Follow every step in order. Don't skip anything.

---

## What this backend does

| What your app needs | This backend provides |
|---|---|
| Real user accounts | `POST /auth/signup` and `POST /auth/login` |
| Save trips to a database | `POST /trips` |
| Join a trip with a code | `POST /trips/join` |
| Load a trip's data | `GET /trips/:id` |
| Add/delete expenses | `POST /trips/:id/expenses` |
| Add/delete contacts | `POST /trips/:id/contacts` |
| Add/delete photos | `POST /trips/:id/photos` |
| Add/delete itinerary items | `POST /trips/:id/itinerary` |
| AI chatbot (API key hidden) | `POST /ai/chat` |
| AI itinerary generator | `POST /ai/itinerary` |

---

## STEP 1 — Install PostgreSQL on your server

If you haven't already:

```bash
sudo apt update
sudo apt install postgresql postgresql-contrib
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

Create a database for TravelBae:

```bash
sudo -u postgres psql
```

Inside the psql shell, type these commands:

```sql
CREATE USER travelbae WITH PASSWORD 'choose-a-strong-password';
CREATE DATABASE travelbae OWNER travelbae;
\q
```

Now you have a database. Your connection string will be:
```
postgresql://travelbae:choose-a-strong-password@localhost:5432/travelbae
```

---

## STEP 2 — Copy and install the backend

```bash
# Go to your server's home folder
cd ~

# Create the backend folder and enter it
mkdir travelbae-backend && cd travelbae-backend
```

Copy all the files from this zip into this folder, keeping the folder structure.

Then install all dependencies:

```bash
npm install
```

---

## STEP 3 — Create your .env file

```bash
cp .env.example .env
nano .env
```

Fill in all four values:

```
DATABASE_URL="postgresql://travelbae:your-password@localhost:5432/travelbae"
JWT_SECRET="paste-a-long-random-string-here"
ANTHROPIC_API_KEY="sk-ant-your-key-here"
PORT=4000
```

To generate a secure JWT_SECRET, run this in terminal:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Copy the output and paste it as your JWT_SECRET.

---

## STEP 4 — Set up the database tables

This command reads your `prisma/schema.prisma` file and creates all the tables in PostgreSQL:

```bash
npx prisma migrate dev --name init
```

You'll see something like:
```
✔ Generated Prisma Client
✔ Applied migration `init`
```

That means your database is ready.

---

## STEP 5 — Start the server

```bash
npm start
```

You should see:
```
✅ Server running at http://localhost:4000
```

Test it in your browser or with curl:
```bash
curl http://localhost:4000/
# Should return: {"status":"TravelBae backend is running 🚀"}
```

For development, use nodemon so the server auto-restarts when you save files:
```bash
npm run dev
```

---

## STEP 6 — Update your React app to call the backend

### 6a. Create a config file in your React project

Create `src/api.js`:

```javascript
// src/api.js
// All your API calls go through here.

const BASE = 'http://localhost:4000'; // change to your server URL in production

// Gets the stored login token
function getToken() {
  return localStorage.getItem('travelbae_token');
}

// The main fetch wrapper — automatically adds the auth header
async function apiFetch(path, options = {}) {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

// Auth
export const signup = (name, email, password) =>
  apiFetch('/auth/signup', { method: 'POST', body: { name, email, password } });

export const login = (email, password) =>
  apiFetch('/auth/login', { method: 'POST', body: { email, password } });

export const getMe = () => apiFetch('/auth/me');

// Trips
export const getTrips = () => apiFetch('/trips');
export const getTrip = (id) => apiFetch(`/trips/${id}`);
export const createTrip = (data) => apiFetch('/trips', { method: 'POST', body: data });
export const joinTrip = (shareCode, nickname) =>
  apiFetch('/trips/join', { method: 'POST', body: { shareCode, nickname } });

// Expenses
export const getExpenses = (tripId) => apiFetch(`/trips/${tripId}/expenses`);
export const addExpense = (tripId, data) =>
  apiFetch(`/trips/${tripId}/expenses`, { method: 'POST', body: data });
export const deleteExpense = (tripId, expId) =>
  apiFetch(`/trips/${tripId}/expenses/${expId}`, { method: 'DELETE' });

// Contacts
export const getContacts = (tripId) => apiFetch(`/trips/${tripId}/contacts`);
export const addContact = (tripId, data) =>
  apiFetch(`/trips/${tripId}/contacts`, { method: 'POST', body: data });
export const deleteContact = (tripId, cid) =>
  apiFetch(`/trips/${tripId}/contacts/${cid}`, { method: 'DELETE' });

// Photos
export const getPhotos = (tripId) => apiFetch(`/trips/${tripId}/photos`);
export const addPhoto = (tripId, url) =>
  apiFetch(`/trips/${tripId}/photos`, { method: 'POST', body: { url } });

// Itinerary
export const getItinerary = (tripId) => apiFetch(`/trips/${tripId}/itinerary`);
export const addItineraryItem = (tripId, data) =>
  apiFetch(`/trips/${tripId}/itinerary`, { method: 'POST', body: data });

// AI (replaces your direct Anthropic calls)
export const aiChat = (system, messages) =>
  apiFetch('/ai/chat', { method: 'POST', body: { system, messages } });
export const aiItinerary = (destination, days, interests) =>
  apiFetch('/ai/itinerary', { method: 'POST', body: { destination, days, interests } });
```

### 6b. Replace the callClaude functions in your app

In your `TravelBae.jsx`, find these functions:

```javascript
async function callClaude(prompt, max_tokens=1200) { ... }
async function callClaudeJSON(prompt, max_tokens=1200) { ... }
async function callClaudeWithSystem(system, messages, max_tokens=400) { ... }
```

Replace them with:

```javascript
import { aiChat, aiItinerary } from './api';

// Simple prompt → text response
async function callClaude(prompt) {
  const { reply } = await aiChat(null, [{ role: 'user', content: prompt }]);
  return reply;
}

// Prompt → parsed JSON
async function callClaudeJSON(prompt) {
  const text = await callClaude(prompt);
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// System prompt + message history
async function callClaudeWithSystem(system, messages) {
  const { reply } = await aiChat(system, messages);
  return reply;
}
```

---

## API Reference

### Auth

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/auth/signup` | `{name, email, password}` | `{token, user}` |
| POST | `/auth/login` | `{email, password}` | `{token, user}` |
| GET | `/auth/me` | — | `{user}` |

### Trips

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/trips` | — | `{trips}` |
| POST | `/trips` | `{groupName, destination, emoji, arrival, departure, isSolo, budget, nickname}` | `{trip}` |
| GET | `/trips/:id` | — | `{trip, myNickname}` |
| POST | `/trips/join` | `{shareCode, nickname}` | `{trip, message}` |

### Expenses

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/trips/:id/expenses` | — | `{expenses}` |
| POST | `/trips/:id/expenses` | `{desc, amount, paidBy, cat, split[], note, date}` | `{expense}` |
| DELETE | `/trips/:id/expenses/:expId` | — | `{message}` |

### AI

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/ai/chat` | `{system?, messages[]}` | `{reply}` |
| POST | `/ai/itinerary` | `{destination, days, interests[]}` | `{itinerary}` |

---

## Deploy to Render (when you're ready)

1. Push your backend folder to a GitHub repo
2. Go to render.com → New → Web Service → connect the repo
3. Set Build Command: `npm install && npx prisma generate`
4. Set Start Command: `npx prisma migrate deploy && node src/index.js`
5. Add all your .env variables in Render's Environment section
6. Render also has a free PostgreSQL database — create one and copy its URL as DATABASE_URL

Your backend will be live at `https://your-app.onrender.com`.
Update `BASE` in your `src/api.js` to that URL.

---

## Common problems

**"Cannot connect to database"**
→ Check your DATABASE_URL in .env. Make sure PostgreSQL is running: `sudo systemctl status postgresql`

**"Invalid token"**
→ The JWT_SECRET in .env changed, or the token expired. Log in again.

**"relation does not exist"**
→ You haven't run `npx prisma migrate dev --name init` yet.

**AI returns an error**
→ Check your ANTHROPIC_API_KEY in .env. Make sure it starts with `sk-ant-`.
