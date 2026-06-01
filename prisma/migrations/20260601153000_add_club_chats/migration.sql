-- CreateTable
CREATE TABLE "ClubChat" (
    "id" TEXT NOT NULL,
    "tripAId" TEXT NOT NULL,
    "tripBId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubChat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubChatMessage" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "senderTripId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClubChat_tripAId_tripBId_key" ON "ClubChat"("tripAId", "tripBId");

-- CreateIndex
CREATE INDEX "ClubChat_tripAId_idx" ON "ClubChat"("tripAId");

-- CreateIndex
CREATE INDEX "ClubChat_tripBId_idx" ON "ClubChat"("tripBId");

-- CreateIndex
CREATE INDEX "ClubChatMessage_chatId_createdAt_idx" ON "ClubChatMessage"("chatId", "createdAt");

-- CreateIndex
CREATE INDEX "ClubChatMessage_senderTripId_idx" ON "ClubChatMessage"("senderTripId");

-- AddForeignKey
ALTER TABLE "ClubChat" ADD CONSTRAINT "ClubChat_tripAId_fkey" FOREIGN KEY ("tripAId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubChat" ADD CONSTRAINT "ClubChat_tripBId_fkey" FOREIGN KEY ("tripBId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubChatMessage" ADD CONSTRAINT "ClubChatMessage_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "ClubChat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubChatMessage" ADD CONSTRAINT "ClubChatMessage_senderTripId_fkey" FOREIGN KEY ("senderTripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubChatMessage" ADD CONSTRAINT "ClubChatMessage_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;