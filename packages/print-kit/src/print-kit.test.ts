import { INITIAL_FEN } from "@suite/chess-core";
import { describe, expect, it } from "vitest";
import { buildWorksheetSpec, renderBoardDiagramSvg } from "./index.js";

describe("@suite/print-kit", () => {
  it("renders a valid SVG diagram and builds a puzzle worksheet spec", () => {
    const svg = renderBoardDiagramSvg(INITIAL_FEN, { caption: "White to move" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("White to move");

    const doc = buildWorksheetSpec(
      "Tactics Sheet 1",
      [{ title: "Puzzle #1", fen: INITIAL_FEN, kibitzStudyUrl: "https://kibitz.example/p/1" }],
      [svg],
    );
    expect(doc.kind).toBe("puzzle-worksheet");
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0]?.svgDiagrams).toHaveLength(1);
  });
});
