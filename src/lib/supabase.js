// src/lib/supabase.js
// Single shared Supabase client for the backend.
// Uses the service role key so it bypasses Row Level Security.
// Always import this instead of creating a new client elsewhere.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL     || '',
  process.env.SUPABASE_SERVICE_KEY || '',
);

module.exports = supabase;
