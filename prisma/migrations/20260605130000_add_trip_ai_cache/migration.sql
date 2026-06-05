-- Add AI-cache columns to Trip so itinerary/taste persists in DB
-- and is shared across all trip members on any device.
ALTER TABLE "Trip" ADD COLUMN "cachedItinerary" JSONB;
ALTER TABLE "Trip" ADD COLUMN "cachedTaste"     JSONB;
