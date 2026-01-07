-- AlterTable
ALTER TABLE "SubscriptionEntitlement" ADD COLUMN     "category_id" TEXT,
ADD COLUMN     "usage_limit" INTEGER,
ADD COLUMN     "usage_period" TEXT,
ADD COLUMN     "usage_unit" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "plan_id" TEXT;

-- CreateTable
CREATE TABLE "SubscriptionPlan" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description_short" TEXT NOT NULL,
    "description_long" TEXT NOT NULL,
    "price_cents" INTEGER,
    "currency" TEXT DEFAULT 'USD',
    "interval" TEXT DEFAULT 'month',
    "level" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPlanEntitlement" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "entitlement_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPlanEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionEntitlementCategory" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionEntitlementCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionEntitlementDependency" (
    "id" TEXT NOT NULL,
    "entitlement_id" TEXT NOT NULL,
    "depends_on_id" TEXT NOT NULL,

    CONSTRAINT "SubscriptionEntitlementDependency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPlan_key_key" ON "SubscriptionPlan"("key");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPlanEntitlement_plan_id_entitlement_id_key" ON "SubscriptionPlanEntitlement"("plan_id", "entitlement_id");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionEntitlementCategory_key_key" ON "SubscriptionEntitlementCategory"("key");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionEntitlementDependency_entitlement_id_depends_on_key" ON "SubscriptionEntitlementDependency"("entitlement_id", "depends_on_id");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "SubscriptionPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionEntitlement" ADD CONSTRAINT "SubscriptionEntitlement_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "SubscriptionEntitlementCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPlanEntitlement" ADD CONSTRAINT "SubscriptionPlanEntitlement_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "SubscriptionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPlanEntitlement" ADD CONSTRAINT "SubscriptionPlanEntitlement_entitlement_id_fkey" FOREIGN KEY ("entitlement_id") REFERENCES "SubscriptionEntitlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionEntitlementDependency" ADD CONSTRAINT "SubscriptionEntitlementDependency_entitlement_id_fkey" FOREIGN KEY ("entitlement_id") REFERENCES "SubscriptionEntitlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionEntitlementDependency" ADD CONSTRAINT "SubscriptionEntitlementDependency_depends_on_id_fkey" FOREIGN KEY ("depends_on_id") REFERENCES "SubscriptionEntitlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
