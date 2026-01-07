-- AlterTable
ALTER TABLE "User" ADD COLUMN     "chat_notifications_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "chat_notifications_rate_limit" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "chat_notifications_sound" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "chat_presence_visible" BOOLEAN NOT NULL DEFAULT true;
