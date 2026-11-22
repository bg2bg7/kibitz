import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("@suite/scribe shell", () => {
  it("renders local-first PGNA v1.0 authoring shell and ChessBoard", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain("PGNA v1.0");
    expect(html).toContain('data-testid="chess-board"');
  });
});
