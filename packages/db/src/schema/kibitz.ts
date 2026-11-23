import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { programs, users } from "./identity.js";

export const studyVisibilityEnum = pgEnum("study_visibility", [
  "public_moderated",
  "coach_students",
  "program",
  "private",
]);

export const moderationStatusEnum = pgEnum("moderation_status", [
  "pending",
  "approved",
  "rejected",
]);

export const studentEmojiEnum = pgEnum("student_emoji", [
  "thumbs_up",
  "lightbulb",
  "thinking",
  "fire",
  "handshake",
  "star",
]);

export const objectDeletionStatusEnum = pgEnum("object_deletion_status", [
  "pending",
  "completed",
  "failed",
]);

export const studies = pgTable(
  "studies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    programId: uuid("program_id").references(() => programs.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    pgnaObjectKey: text("pgna_object_key").notNull(),
    visibility: studyVisibilityEnum("visibility").notNull().default("private"),
    moderationStatus: moderationStatusEnum("moderation_status").notNull().default("pending"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("studies_owner_idempotency_key_idx")
      .on(table.ownerUserId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  ],
);

/**
 * Durable outbox for S3/object-storage `.pgna` deletions (LEC-04).
 * Deliberately omits a cascading FK to `studies` so retained object keys outlive study row cleanup.
 */
export const studyObjectDeletions = pgTable("study_object_deletions", {
  id: uuid("id").defaultRandom().primaryKey(),
  studyId: uuid("study_id").notNull(),
  pgnaObjectKey: text("pgna_object_key").notNull().unique(),
  status: objectDeletionStatusEnum("status").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastError: text("last_error"),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const playlists = pgTable("playlists", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  programId: uuid("program_id").references(() => programs.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  isPublic: boolean("is_public").notNull().default(false),
  orderedStudyIds: jsonb("ordered_study_ids").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const assignments = pgTable("assignments", {
  id: uuid("id").defaultRandom().primaryKey(),
  coachUserId: uuid("coach_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  studentUserId: uuid("student_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  studyId: uuid("study_id")
    .notNull()
    .references(() => studies.id, { onDelete: "cascade" }),
  dueAt: timestamp("due_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  studentEmoji: studentEmojiEnum("student_emoji"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
