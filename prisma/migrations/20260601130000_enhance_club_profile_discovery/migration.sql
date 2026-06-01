-- Add richer club discovery profile fields
ALTER TABLE "ClubProfile"
  ADD COLUMN "vibe" TEXT,
  ADD COLUMN "genderMix" TEXT,
  ADD COLUMN "boysCount" INTEGER,
  ADD COLUMN "girlsCount" INTEGER,
  ADD COLUMN "coverTags" TEXT[] DEFAULT ARRAY[]::TEXT[];
