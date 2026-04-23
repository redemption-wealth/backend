-- Drop absolute unique constraint on admins.email
DROP INDEX "admins_email_key";

-- Create partial unique index: email only unique among non-deleted admins
CREATE UNIQUE INDEX "admins_email_unique" ON "admins"("email") WHERE "deleted_at" IS NULL;
