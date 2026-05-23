-- CreateTable
CREATE TABLE "ClubProfile" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "creatorUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'listed',
    "title" TEXT NOT NULL,
    "about" TEXT NOT NULL,
    "lookingFor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubJoinRequest" (
    "id" TEXT NOT NULL,
    "targetTripId" TEXT NOT NULL,
    "requesterTripId" TEXT NOT NULL,
    "requesterUserId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubJoinRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClubProfile_tripId_key" ON "ClubProfile"("tripId");

-- CreateIndex
CREATE INDEX "ClubProfile_status_idx" ON "ClubProfile"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ClubJoinRequest_targetTripId_requesterTripId_key" ON "ClubJoinRequest"("targetTripId", "requesterTripId");

-- CreateIndex
CREATE INDEX "ClubJoinRequest_targetTripId_status_idx" ON "ClubJoinRequest"("targetTripId", "status");

-- CreateIndex
CREATE INDEX "ClubJoinRequest_requesterTripId_status_idx" ON "ClubJoinRequest"("requesterTripId", "status");

-- AddForeignKey
ALTER TABLE "ClubProfile" ADD CONSTRAINT "ClubProfile_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubProfile" ADD CONSTRAINT "ClubProfile_creatorUserId_fkey" FOREIGN KEY ("creatorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubJoinRequest" ADD CONSTRAINT "ClubJoinRequest_targetTripId_fkey" FOREIGN KEY ("targetTripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubJoinRequest" ADD CONSTRAINT "ClubJoinRequest_requesterTripId_fkey" FOREIGN KEY ("requesterTripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubJoinRequest" ADD CONSTRAINT "ClubJoinRequest_requesterUserId_fkey" FOREIGN KEY ("requesterUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
