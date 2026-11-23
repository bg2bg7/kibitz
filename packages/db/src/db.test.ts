import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  assignments,
  coachStudentLinks,
  invites,
  linkIntents,
  objectDeletionStatusEnum,
  playlists,
  programMemberships,
  programs,
  studentEmojiEnum,
  studies,
  studyObjectDeletions,
  tournamentGames,
  tournaments,
  users,
} from "./schema/index.js";

describe("@suite/db schema blueprint", () => {
  it("defines all required tables with Zero-PII user design", () => {
    expect(getTableName(users)).toBe("users");
    expect(getTableName(invites)).toBe("invites");
    expect(getTableName(programs)).toBe("programs");
    expect(getTableName(programMemberships)).toBe("program_memberships");
    expect(getTableName(linkIntents)).toBe("link_intents");
    expect(getTableName(coachStudentLinks)).toBe("coach_student_links");
    expect(getTableName(studies)).toBe("studies");
    expect(getTableName(studyObjectDeletions)).toBe("study_object_deletions");
    expect(getTableName(playlists)).toBe("playlists");
    expect(getTableName(assignments)).toBe("assignments");
    expect(getTableName(tournaments)).toBe("tournaments");
    expect(getTableName(tournamentGames)).toBe("tournament_games");

    const userCols = Object.keys(getTableColumns(users));
    expect(userCols).toEqual(["id", "handle", "passwordHash", "role", "createdAt"]);
    expect(userCols).not.toContain("email");
    expect(userCols).not.toContain("realName");

    const studyCols = Object.keys(getTableColumns(studies));
    expect(studyCols).toContain("tags");
    expect(studyCols).toContain("deletedAt");
    expect(studyCols).toContain("idempotencyKey");
  });

  it("restricts student assignment responses to the fixed curated emoji enum", () => {
    expect(studentEmojiEnum.enumValues).toEqual([
      "thumbs_up",
      "lightbulb",
      "thinking",
      "fire",
      "handshake",
      "star",
    ]);
  });

  it("defines additive LEC-04 deletion tombstones, outbox table, and SCR-05 idempotency key index", () => {
    expect(objectDeletionStatusEnum.enumValues).toEqual(["pending", "completed", "failed"]);

    const studyColumns = getTableColumns(studies);
    expect(studyColumns.deletedAt.name).toBe("deleted_at");
    expect(studyColumns.deletedAt.notNull).toBe(false);
    expect(studyColumns.idempotencyKey.name).toBe("idempotency_key");
    expect(studyColumns.idempotencyKey.notNull).toBe(false);

    const studiesConfig = getTableConfig(studies);
    const idempotencyIdx = studiesConfig.indexes.find(
      (idx) => idx.config.name === "studies_owner_idempotency_key_idx",
    );
    expect(idempotencyIdx).toBeDefined();
    expect(idempotencyIdx?.config.unique).toBe(true);
    expect(idempotencyIdx?.config.where).toBeDefined();

    const deletionCols = getTableColumns(studyObjectDeletions);
    expect(Object.keys(deletionCols)).toEqual([
      "id",
      "studyId",
      "pgnaObjectKey",
      "status",
      "attemptCount",
      "lastError",
      "nextAttemptAt",
      "completedAt",
      "createdAt",
      "updatedAt",
    ]);
    expect(deletionCols.pgnaObjectKey.isUnique).toBe(true);
    expect(deletionCols.status.default).toBe("pending");
    expect(deletionCols.attemptCount.default).toBe(0);

    // Deliberately no cascading FK to studies so retained object keys outlive study row cleanup.
    const deletionsConfig = getTableConfig(studyObjectDeletions);
    expect(deletionsConfig.foreignKeys).toEqual([]);
  });
});
