import { ChessPosition, INITIAL_FEN } from "@suite/chess-core";

export interface DiagramRenderOptions {
  sizePx?: number;
  orientation?: "white" | "black";
  caption?: string;
}

const PRINT_GLYPHS: Record<string, string> = {
  wp: "♙",
  wn: "♘",
  wb: "♗",
  wr: "♖",
  wq: "♕",
  wk: "♔",
  bp: "♟",
  bn: "♞",
  bb: "♝",
  br: "♜",
  bq: "♛",
  bk: "♚",
};

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const RANKS = ["8", "7", "6", "5", "4", "3", "2", "1"] as const;

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Renders a self-contained high-DPI SVG chess diagram suitable for client-side PDF printouts.
 */
export function renderBoardDiagramSvg(
  fen: string = INITIAL_FEN,
  options: DiagramRenderOptions = {},
): string {
  const sizePx = options.sizePx ?? 320;
  const orientation = options.orientation ?? "white";
  const squareSize = sizePx / 8;

  const pieces = new ChessPosition(fen).getPieces();
  const pieceMap = new Map(pieces.map((p) => [p.square, p]));

  const orderedFiles = orientation === "white" ? FILES : [...FILES].reverse();
  const orderedRanks = orientation === "white" ? RANKS : [...RANKS].reverse();

  const elements: string[] = [];
  orderedRanks.forEach((rank, rIdx) => {
    orderedFiles.forEach((file, fIdx) => {
      const x = fIdx * squareSize;
      const y = rIdx * squareSize;
      const fill = (rIdx + fIdx) % 2 === 0 ? "#ffffff" : "#d4d4d8";
      elements.push(
        `<rect x="${x}" y="${y}" width="${squareSize}" height="${squareSize}" fill="${fill}" />`,
      );
      const piece = pieceMap.get(`${file}${rank}`);
      if (piece) {
        const glyph = PRINT_GLYPHS[`${piece.color}${piece.type}`] ?? "";
        elements.push(
          `<text x="${x + squareSize / 2}" y="${y + squareSize * 0.76}" text-anchor="middle" font-size="${squareSize * 0.72}" font-family="serif" fill="#111111">${glyph}</text>`,
        );
      }
    });
  });

  const captionHeight = options.caption ? 24 : 0;
  const captionSvg = options.caption
    ? `<text x="${sizePx / 2}" y="${sizePx + 18}" text-anchor="middle" font-size="14" font-family="sans-serif" fill="#111111">${escapeXmlText(options.caption)}</text>`
    : "";

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx + captionHeight}" viewBox="0 0 ${sizePx} ${sizePx + captionHeight}">`,
    ...elements,
    `<rect x="0" y="0" width="${sizePx}" height="${sizePx}" fill="none" stroke="#111111" stroke-width="2" />`,
    captionSvg,
    "</svg>",
  ].join("");
}
