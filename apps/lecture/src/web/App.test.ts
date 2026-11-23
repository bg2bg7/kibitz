import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("@suite/lecture web", () => {
  it("renders Hello World placeholder with link back to Kibitz homepage", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain("Hello, World!");
    expect(html).toContain("Lecture");
    expect(html).toContain('href="http://localhost:5170"');
  });
});
