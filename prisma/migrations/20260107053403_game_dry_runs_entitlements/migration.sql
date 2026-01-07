-- CreateTable
CREATE TABLE "GameDryRun" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "seed" INTEGER NOT NULL,
    "events" JSONB NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameDryRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionEntitlement" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionTierEntitlement" (
    "id" TEXT NOT NULL,
    "entitlement_id" TEXT NOT NULL,
    "tier" "SubscriptionTier" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionTierEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionEntitlement_key_key" ON "SubscriptionEntitlement"("key");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionTierEntitlement_entitlement_id_tier_key" ON "SubscriptionTierEntitlement"("entitlement_id", "tier");

-- AddForeignKey
ALTER TABLE "GameDryRun" ADD CONSTRAINT "GameDryRun_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "GameDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionTierEntitlement" ADD CONSTRAINT "SubscriptionTierEntitlement_entitlement_id_fkey" FOREIGN KEY ("entitlement_id") REFERENCES "SubscriptionEntitlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
