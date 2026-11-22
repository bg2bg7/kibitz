import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parsePgnGames, serializePgnGames } from "@suite/chess-core";
import { compilePgna } from "@suite/pgna";
import { App } from "./App";
import {
  deleteLocalDraft,
  listLocalDrafts,
  loadLocalDraft,
  saveLocalDraft,
} from "./local/draftStore";
import { createBlankDraft, createDemoItalianDraft } from "./local/draftWorkspace";
import {
  appendNodeToTimeline,
  deleteNodeSubtree,
  indexStudyGames,
  playMoveAtNode,
  promoteVariation,
  reorderTimelineEntries,
  toggleBoardArrow,
  toggleBoardHighlight,
  toggleNodeNag,
  updateAtTagDuration,
} from "./local/studyTree";

describe("@suite/scribe studio", () => {
  it("renders local-first PGNA v1.0 authoring studio, ChessBoard, and compiled timeline", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain("PGNA v1.0");
    expect(html).toContain('data-testid="chess-board"');
    expect(html).toContain("Italian Game Essentials");
    expect(html).toContain("Compiled Linear Timeline");
    expect(html).toContain("↩ Return");
  });

  it("supports branching variations, promotion, annotations, silent return pauses, and timeline reordering", () => {
    const draft = createBlankDraft("Sicilian Lesson");
    let games = parsePgnGames(draft.pgnText);

    // Play 1. e4 e5 and branch 1... c5
    const m1 = playMoveAtNode(games, "g0", { from: "e2", to: "e4" })!;
    expect(m1.nextNodeId).toBe("g0/0");
    games = m1.games;

    const m2 = playMoveAtNode(games, "g0/0", { from: "e7", to: "e5" })!;
    expect(m2.nextNodeId).toBe("g0/0.0");
    games = m2.games;

    const mVar = playMoveAtNode(games, "g0/0", { from: "c7", to: "c5" })!;
    expect(mVar.nextNodeId).toBe("g0/0.1");
    games = mVar.games;

    // Annotate 1. e4 with arrow, highlight, and NAG
    games = toggleBoardArrow(games, "g0/0", "e2", "e4", "G");
    games = toggleBoardHighlight(games, "g0/0", "e4", "Y");
    games = toggleNodeNag(games, "g0/0", "$1");

    // Schedule 1. e4 (#1), variation 1... c5 (#2), silent return pause to 1. e4 (#3), and 1... e5 (#4)
    games = appendNodeToTimeline(games, "g0/0");
    games = appendNodeToTimeline(games, "g0/0.1");
    games = appendNodeToTimeline(games, "g0/0", 750);
    games = appendNodeToTimeline(games, "g0/0.0");

    // Update revisit duration on 2nd [%at] tag of g0/0
    games = updateAtTagDuration(games, "g0/0", 1, 1200);

    const compiled = compilePgna({
      manifest: draft.manifest,
      pgnText: serializePgnGames(games),
    });

    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(compiled.timeline.entries).toHaveLength(4);
    expect(compiled.timeline.entries[2]?.nodeId).toBe("g0/0");
    expect(compiled.timeline.entries[2]?.isRevisit).toBe(true);
    expect(compiled.timeline.entries[2]?.audio).toBeNull();
    expect(
      (compiled.timeline.entries[2]?.endMs ?? 0) - (compiled.timeline.entries[2]?.startMs ?? 0),
    ).toBe(1200);

    // Reorder timeline entry 3 (1... e5) before entry 2 (silent return)
    const reorderedGames = reorderTimelineEntries(games, compiled.timeline.entries, 3, 2);
    const recompiled = compilePgna({
      manifest: draft.manifest,
      pgnText: serializePgnGames(reorderedGames),
    });
    expect(recompiled.timeline.entries.map((e) => e.nodeId)).toEqual([
      "g0/0",
      "g0/0.1",
      "g0/0.0",
      "g0/0",
    ]);

    // Promote 1... c5 to mainline and verify tree
    const promoted = promoteVariation(games, "g0/0.1");
    expect(promoted.nextNodeId).toBe("g0/0.0");
    const idx = indexStudyGames(promoted.games);
    expect(idx.nodesById["g0/0.0"]?.san).toBe("c5");

    // Delete variation 1... e5 (now at g0/0.1)
    const deleted = deleteNodeSubtree(promoted.games, "g0/0.1");
    expect(deleted.fallbackNodeId).toBe("g0/0");
    expect(indexStudyGames(deleted.games).nodesById["g0/0"]?.childIds).toEqual(["g0/0.0"]);
  });

  it("persists local drafts via draftStore fallback cleanly", async () => {
    const demo = createDemoItalianDraft();
    await saveLocalDraft(demo);

    const loaded = await loadLocalDraft(demo.id);
    expect(loaded?.manifest.title).toBe("Italian Game Essentials");

    const list = await listLocalDrafts();
    expect(list.some((d) => d.id === demo.id)).toBe(true);

    await deleteLocalDraft(demo.id);
    expect(await loadLocalDraft(demo.id)).toBeNull();
  });
});
