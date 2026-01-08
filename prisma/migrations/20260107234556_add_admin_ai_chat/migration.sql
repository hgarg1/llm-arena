-- CreateTable
CREATE TABLE "AdminAiChat" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAiChat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAiChatMessage" (
    "id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAiChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminAiChat_user_id_idx" ON "AdminAiChat"("user_id");

-- CreateIndex
CREATE INDEX "AdminAiChatMessage_chat_id_created_at_idx" ON "AdminAiChatMessage"("chat_id", "created_at");

-- AddForeignKey
ALTER TABLE "AdminAiChat" ADD CONSTRAINT "AdminAiChat_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAiChatMessage" ADD CONSTRAINT "AdminAiChatMessage_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "AdminAiChat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
