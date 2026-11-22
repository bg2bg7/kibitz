import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChessBoard } from "./index.js";

describe("@suite/board-ui", () => {
  it("renders a 64-square board with arrows and projector theme", () => {
    const html = renderToStaticMarkup(
      createElement(ChessBoard, {
        orientation: "black",
        theme: "projector-high-contrast",
        arrows: [{ color: "G", from: "e2", to: "e4" }],
        highlights: [{ color: "Y", square: "e4" }],
      }),
    );

    expect(html).toContain('data-theme="projector-high-contrast"');
    expect(html).toContain('data-orientation="black"');
    expect(html).toContain("<svg");
    expect(html).toContain("Square e4");
  });
});
