import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("@suite/seconds shell", () => {
  it("renders offline PWA status and projector-high-contrast ChessBoard", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain("100% Offline PWA");
    expect(html).toContain('data-theme="projector-high-contrast"');
  });
});
