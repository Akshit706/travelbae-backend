-- CreateTable
CREATE TABLE "ClubChatSplitExpense" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "desc" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "paidByKey" TEXT NOT NULL,
    "splitWithKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdByTripId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubChatSplitExpense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClubChatSplitExpense_chatId_createdAt_idx" ON "ClubChatSplitExpense"("chatId", "createdAt");

-- AddForeignKey
ALTER TABLE "ClubChatSplitExpense" ADD CONSTRAINT "ClubChatSplitExpense_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "ClubChat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
