CREATE TYPE "public"."object_deletion_status" AS ENUM('pending', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "study_object_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"pgna_object_key" text NOT NULL,
	"status" "object_deletion_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "study_object_deletions_pgna_object_key_unique" UNIQUE("pgna_object_key")
);
--> statement-breakpoint
ALTER TABLE "studies" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "studies" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "studies_owner_idempotency_key_idx" ON "studies" USING btree ("owner_user_id","idempotency_key") WHERE "studies"."idempotency_key" is not null;