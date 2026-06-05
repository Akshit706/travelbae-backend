-- CreateTable
CREATE TABLE "DestinationTaste" (
    "id"          TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "data"        JSONB NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DestinationTaste_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DestinationTaste_destination_key" ON "DestinationTaste"("destination");

-- CreateIndex
CREATE INDEX "DestinationTaste_destination_idx" ON "DestinationTaste"("destination");
