-- CreateEnum
CREATE TYPE "StripeMode" AS ENUM ('TEST', 'LIVE');

-- AlterTable
ALTER TABLE "StripeSubscription" ADD COLUMN     "stripe_mode" "StripeMode" NOT NULL DEFAULT 'TEST';

-- AlterTable
ALTER TABLE "SubscriptionPlanPrice" ADD COLUMN     "created_by" TEXT,
ADD COLUMN     "mode" "StripeMode" NOT NULL DEFAULT 'TEST';

-- CreateTable
CREATE TABLE "SubscriptionPlanStripeProduct" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "stripe_product_id" TEXT NOT NULL,
    "mode" "StripeMode" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPlanStripeProduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPlanStripeProduct_stripe_product_id_key" ON "SubscriptionPlanStripeProduct"("stripe_product_id");

-- CreateIndex
CREATE INDEX "SubscriptionPlanStripeProduct_plan_id_mode_active_idx" ON "SubscriptionPlanStripeProduct"("plan_id", "mode", "active");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPlanStripeProduct_plan_id_mode_key" ON "SubscriptionPlanStripeProduct"("plan_id", "mode");

-- CreateIndex
CREATE INDEX "SubscriptionPlanPrice_plan_id_mode_status_idx" ON "SubscriptionPlanPrice"("plan_id", "mode", "status");

-- AddForeignKey
ALTER TABLE "SubscriptionPlanStripeProduct" ADD CONSTRAINT "SubscriptionPlanStripeProduct_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "SubscriptionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPlanStripeProduct" ADD CONSTRAINT "SubscriptionPlanStripeProduct_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPlanPrice" ADD CONSTRAINT "SubscriptionPlanPrice_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
