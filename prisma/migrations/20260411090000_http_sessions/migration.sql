-- Server-side sessions for deployments without a shared in-memory store (serverless).
CREATE TABLE "HttpSession" (
  "sid" TEXT NOT NULL,
  "sess" JSONB NOT NULL,
  "expire" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HttpSession_pkey" PRIMARY KEY ("sid")
);
CREATE INDEX "HttpSession_expire_idx" ON "HttpSession"("expire");
