ALTER TABLE "User"
ADD COLUMN "avatar_data" BYTEA,
ADD COLUMN "avatar_content_type" TEXT,
ADD COLUMN "avatar_file_name" TEXT,
ADD COLUMN "avatar_updated_at" TIMESTAMP(3);
