-- CreateEnum
CREATE TYPE "JobInterviewStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'CANCELED', 'NO_SHOW', 'RESCHEDULE');

-- AlterTable
ALTER TABLE "JobApplication" ADD COLUMN     "interview_location" TEXT,
ADD COLUMN     "interview_notes" TEXT,
ADD COLUMN     "interview_scheduled_at" TIMESTAMP(3),
ADD COLUMN     "interview_status" "JobInterviewStatus",
ADD COLUMN     "last_contacted_at" TIMESTAMP(3),
ADD COLUMN     "review_rubric" JSONB,
ADD COLUMN     "review_score" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "JobPosting" ADD COLUMN     "review_rubric" JSONB;
