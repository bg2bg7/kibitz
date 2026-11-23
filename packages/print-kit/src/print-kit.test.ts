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

  it("XML-escapes diagram captions without dropping punctuation or allowing tag injection", () => {
    const decodeXmlEntities = (raw: string): string =>
      raw
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");

    const caption = 'White > Black & e4 < d4 ("Main" \'Line\')';
    const svg = renderBoardDiagramSvg(INITIAL_FEN, { caption });

    const captionMatch = /<text[^>]*font-family="sans-serif"[^>]*>([^<]*)<\/text>/.exec(svg);
    expect(captionMatch).not.toBeNull();

    const rawCaptionXml = captionMatch![1]!;
    expect(rawCaptionXml).toBe("White &gt; Black &amp; e4 &lt; d4 (&quot;Main&quot; &#39;Line&#39;)");
    // No bare unescaped ampersands
    expect(rawCaptionXml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#39;)/);
    // Decodes back to exact original text with zero dropped punctuation
    expect(decodeXmlEntities(rawCaptionXml)).toBe(caption);

    // Angle brackets in captions cannot break XML structure or inject tags
    const tagLikeCaption = '<script>alert("x")</script> & 1 < 2 > 0';
    const safeSvg = renderBoardDiagramSvg(INITIAL_FEN, { caption: tagLikeCaption });
    expect(safeSvg).not.toContain("<script>");
    expect(safeSvg).not.toContain("</script>");
    const safeCaptionMatch = /<text[^>]*font-family="sans-serif"[^>]*>([^<]*)<\/text>/.exec(
      safeSvg,
    );
    expect(safeCaptionMatch).not.toBeNull();
    expect(decodeXmlEntities(safeCaptionMatch![1]!)).toBe(tagLikeCaption);
  });
});
