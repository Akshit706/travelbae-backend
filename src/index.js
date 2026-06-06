// src/index.js
// This is the main file that starts your server.
// Run it with: node src/index.js

require('dotenv').config(); // loads your .env file
const express = require('express');
const cors = require('cors');

const authRoutes      = require('./routes/auth');
const tripRoutes      = require('./routes/trips');
const expenseRoutes   = require('./routes/expenses');
const contactRoutes   = require('./routes/contacts');
const photoRoutes     = require('./routes/photos');
const itineraryRoutes = require('./routes/itinerary');
const aiRoutes            = require('./routes/ai');
const recommendationRoutes = require('./routes/recommendations');


const app = express();

// Allow your React frontend to call this server
app.use(cors({
  origin: '*', // in production, change this to your actual frontend URL
}));

// Parse incoming JSON request bodies
app.use(express.json());

// Health check — visit http://localhost:4000/ to confirm the server is running
app.get('/', (req, res) => {
  res.json({ status: 'TravelBae backend is running 🚀' });
});

// All routes
app.use('/auth',      authRoutes);
app.use('/trips',     tripRoutes);
app.use('/trips',     expenseRoutes);
app.use('/trips',     contactRoutes);
app.use('/trips',     photoRoutes);
app.use('/trips',     itineraryRoutes);
app.use('/ai',        aiRoutes);
app.use('/ai',        recommendationRoutes);

// Global error handler — catches any unhandled errors
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});

app.use('/ai', require('./routes/ai'));