import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("@suite/seconds shell", () => {
  it("renders Hello World placeholder with 100% Offline PWA badge and link back to Kibitz homepage", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain("Hello, World!");
    expect(html).toContain("100% Offline PWA");
    expect(html).toContain('href="http://localhost:5170"');
  });
});
