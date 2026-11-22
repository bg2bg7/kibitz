import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("@suite/arbiter shell", () => {
  it("renders offline PWA status and shared ChessBoard", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain("100% Offline PWA");
    expect(html).toContain('data-testid="chess-board"');
  });
});
