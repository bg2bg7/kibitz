/**
 * Client-side PDF layout specifications for wall charts, pairing slips,
 * certificates, and QR-linked puzzle worksheets. Pure client-side (zero server calls).
 */

export type PrintDocumentKind = "wall-chart" | "pairing-slips" | "certificate" | "puzzle-worksheet";

export interface PuzzleWorksheetItem {
  title: string;
  fen: string;
  kibitzStudyUrl?: string;
}

export interface PrintDocumentSpec {
  kind: PrintDocumentKind;
  title: string;
  pageSize: "letter" | "a4";
  orientation: "portrait" | "landscape";
  sections: Array<{ heading: string; svgDiagrams?: string[]; lines: string[] }>;
}

export function buildWorksheetSpec(
  title: string,
  items: readonly PuzzleWorksheetItem[],
  svgByIndex: readonly string[],
): PrintDocumentSpec {
  return {
    kind: "puzzle-worksheet",
    title,
    pageSize: "letter",
    orientation: "portrait",
    sections: items.map((item, idx) => ({
      heading: item.title,
      svgDiagrams: svgByIndex[idx] ? [svgByIndex[idx]] : [],
      lines: item.kibitzStudyUrl ? [`QR Link: ${item.kibitzStudyUrl}`] : [],
    })),
  };
}
