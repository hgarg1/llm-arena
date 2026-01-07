-- CreateEnum
CREATE TYPE "StripePriceStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'LEGACY');

-- CreateEnum
CREATE TYPE "StripeSubscriptionTarget" AS ENUM ('USER', 'ORG');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "stripe_customer_id" TEXT;

-- AlterTable
ALTER TABLE "SubscriptionPlan" ADD COLUMN     "stripe_product_active" BOOLEAN,
ADD COLUMN     "stripe_product_id" TEXT,
ADD COLUMN     "stripe_product_metadata" JSONB;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "stripe_customer_id" TEXT;

-- CreateTable
CREATE TABLE "SubscriptionPlanPrice" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "stripe_price_id" TEXT NOT NULL,
    "stripe_product_id" TEXT,
    "nickname" TEXT,
    "currency" TEXT,
    "unit_amount" INTEGER,
    "interval" TEXT,
    "interval_count" INTEGER,
    "status" "StripePriceStatus" NOT NULL DEFAULT 'ACTIVE',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "stripe_active" BOOLEAN,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPlanPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeSubscription" (
    "id" TEXT NOT NULL,
    "stripe_subscription_id" TEXT NOT NULL,
    "stripe_customer_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "plan_id" TEXT,
    "price_id" TEXT,
    "product_id" TEXT,
    "target_type" "StripeSubscriptionTarget" NOT NULL,
    "target_id" TEXT NOT NULL,
    "current_period_start" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "canceled_at" TIMESTAMP(3),
    "trial_end" TIMESTAMP(3),
    "quantity" INTEGER,
    "raw" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPlanPrice_stripe_price_id_key" ON "SubscriptionPlanPrice"("stripe_price_id");

-- CreateIndex
CREATE INDEX "SubscriptionPlanPrice_plan_id_status_idx" ON "SubscriptionPlanPrice"("plan_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StripeSubscription_stripe_subscription_id_key" ON "StripeSubscription"("stripe_subscription_id");

-- CreateIndex
CREATE INDEX "StripeSubscription_target_type_target_id_idx" ON "StripeSubscription"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "StripeSubscription_stripe_customer_id_idx" ON "StripeSubscription"("stripe_customer_id");

-- AddForeignKey
ALTER TABLE "SubscriptionPlanPrice" ADD CONSTRAINT "SubscriptionPlanPrice_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "SubscriptionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StripeSubscription" ADD CONSTRAINT "StripeSubscription_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "SubscriptionPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
