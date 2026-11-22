import { boolean, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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

export const studies = pgTable("studies", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  programId: uuid("program_id").references(() => programs.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  pgnaObjectKey: text("pgna_object_key").notNull(),
  visibility: studyVisibilityEnum("visibility").notNull().default("private"),
  moderationStatus: moderationStatusEnum("moderation_status").notNull().default("pending"),
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
