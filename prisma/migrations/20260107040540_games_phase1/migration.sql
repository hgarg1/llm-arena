-- CreateEnum
CREATE TYPE "GameStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'LIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "GameSettingType" AS ENUM ('BOOLEAN', 'INT', 'FLOAT', 'ENUM', 'TEXT');

-- CreateTable
CREATE TABLE "GameDefinition" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description_short" TEXT,
    "description_long" TEXT,
    "status" "GameStatus" NOT NULL DEFAULT 'DRAFT',
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "max_players" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameSetting" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" "GameSettingType" NOT NULL,
    "min_value" JSONB,
    "max_value" JSONB,
    "default_value" JSONB,
    "enum_options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tier_required" "SubscriptionTier" NOT NULL DEFAULT 'FREE',
    "help_text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameUISchema" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "create_form_layout" JSONB,
    "summary_template" JSONB,
    "labels" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameUISchema_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameRelease" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "status" "GameStatus" NOT NULL DEFAULT 'DRAFT',
    "publish_at" TIMESTAMP(3),
    "published_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameRelease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameRevision" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GameDefinition_key_key" ON "GameDefinition"("key");

-- CreateIndex
CREATE UNIQUE INDEX "GameSetting_game_id_key_key" ON "GameSetting"("game_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "GameUISchema_game_id_key" ON "GameUISchema"("game_id");

-- CreateIndex
CREATE UNIQUE INDEX "GameRevision_game_id_revision_key" ON "GameRevision"("game_id", "revision");

-- AddForeignKey
ALTER TABLE "GameSetting" ADD CONSTRAINT "GameSetting_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "GameDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameUISchema" ADD CONSTRAINT "GameUISchema_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "GameDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameRelease" ADD CONSTRAINT "GameRelease_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "GameDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameRevision" ADD CONSTRAINT "GameRevision_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "GameDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
