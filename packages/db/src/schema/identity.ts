import { sql } from "drizzle-orm";
import {
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", ["admin", "moderator", "coach", "student"]);
export const programRoleEnum = pgEnum("program_role", ["director", "coach", "student"]);

/**
 * Pseudonymous user identities. Deliberately avoids PII (no real names, no student emails).
 * Handles are unique case-insensitively via functional unique index on lower(handle).
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    handle: text("handle").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRoleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("users_handle_lower_idx").on(sql`lower(${table.handle})`)],
);

export const programs = pgTable("programs", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const invites = pgTable("invites", {
  code: text("code").primaryKey(),
  createdByUserId: uuid("created_by_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  assignedRole: userRoleEnum("assigned_role").notNull(),
  programId: uuid("program_id").references(() => programs.id, { onDelete: "set null" }),
  maxUses: integer("max_uses").notNull().default(1),
  usedCount: integer("used_count").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const programMemberships = pgTable(
  "program_memberships",
  {
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: programRoleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.programId, table.userId] })],
);

/**
 * Double-blind matching table.
 * When both (A -> B.handle) and (B -> A.handle) exist, materialize into `coach_student_links`
 * and delete pending intents without leaking handle existence beforehand.
 */
export const linkIntents = pgTable(
  "link_intents",
  {
    initiatorUserId: uuid("initiator_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetHandle: text("target_handle").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.initiatorUserId, table.targetHandle] })],
);

export const coachStudentLinks = pgTable(
  "coach_student_links",
  {
    coachUserId: uuid("coach_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    studentUserId: uuid("student_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.coachUserId, table.studentUserId] })],
);
