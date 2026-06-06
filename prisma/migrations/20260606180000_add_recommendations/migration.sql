-- CreateTable
CREATE TABLE "DestinationHotel" (
    "id" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rating" DOUBLE PRECISION,
    "priceLevel" TEXT,
    "pricePerNight" TEXT,
    "imageUrl" TEXT,
    "address" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "amenities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DestinationHotel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DestinationHospital" (
    "id" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "is24h" BOOLEAN NOT NULL DEFAULT false,
    "phone" TEXT,
    "address" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DestinationHospital_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DestinationRental" (
    "id" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "rating" DOUBLE PRECISION,
    "phone" TEXT,
    "address" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "mapsUrl" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DestinationRental_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DestinationHotel_destination_idx" ON "DestinationHotel"("destination");

-- CreateIndex
CREATE INDEX "DestinationHospital_destination_idx" ON "DestinationHospital"("destination");

-- CreateIndex
CREATE INDEX "DestinationRental_destination_idx" ON "DestinationRental"("destination");
