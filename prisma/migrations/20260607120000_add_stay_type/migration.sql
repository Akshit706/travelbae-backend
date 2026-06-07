-- AlterTable: add stayType to DestinationHotel
ALTER TABLE "DestinationHotel" ADD COLUMN "stayType" TEXT NOT NULL DEFAULT 'hotel';
