-- Per-category log webhooks, set from the dashboard. Each row points one log category
-- (moderation, temp_role, …) at a Discord webhook URL; a category with no row falls back
-- to the MOD_LOG_WEBHOOK_URL env var.
CREATE TABLE "log_webhooks" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "log_webhooks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "log_webhooks_key_key" ON "log_webhooks"("key");
