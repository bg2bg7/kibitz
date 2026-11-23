import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("@suite/hall web", () => {
  it("renders Hello World placeholder with scheduled-tournament badge and link back to Kibitz homepage", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain("Hello, World!");
    expect(html).toContain("Hall");
    expect(html).toContain("No Chat");
    expect(html).toContain('href="http://localhost:5170"');
  });
});
