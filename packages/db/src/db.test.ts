import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  assignments,
  coachStudentLinks,
  invites,
  linkIntents,
  playlists,
  programMemberships,
  programs,
  studentEmojiEnum,
  studies,
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
});
