import { integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity.js";

export const tournamentStatusEnum = pgEnum("tournament_status", [
  "scheduled",
  "active",
  "finished",
]);

export interface TournamentTimeControl {
  initialMs: number;
  incrementMs: number;
}

export const tournaments = pgTable("tournaments", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizerUserId: uuid("organizer_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  title: text("title").notNull(),
  timeControl: jsonb("time_control").$type<TournamentTimeControl>().notNull(),
  status: tournamentStatusEnum("status").notNull().default("scheduled"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const tournamentGames = pgTable("tournament_games", {
  id: uuid("id").defaultRandom().primaryKey(),
  tournamentId: uuid("tournament_id")
    .notNull()
    .references(() => tournaments.id, { onDelete: "cascade" }),
  round: integer("round").notNull(),
  whiteUserId: uuid("white_user_id").references(() => users.id, { onDelete: "set null" }),
  blackUserId: uuid("black_user_id").references(() => users.id, { onDelete: "set null" }),
  result: text("result").notNull().default("*"),
  pgn: text("pgn").notNull().default(""),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});
