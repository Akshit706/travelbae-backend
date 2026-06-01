-- AlterTable
ALTER TABLE "ClubProfile" ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION,
ADD COLUMN     "photoUrl" TEXT;

-- CreateIndex
CREATE INDEX "ClubProfile_latitude_longitude_idx" ON "ClubProfile"("latitude", "longitude");
