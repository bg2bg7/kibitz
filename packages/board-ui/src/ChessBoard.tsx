import { useState, type CSSProperties } from "react";
import { ChessPosition, INITIAL_FEN, type BoardPiece } from "@suite/chess-core";

export type BoardTheme = "default" | "projector-high-contrast";
export type BoardAnnotationColor = "G" | "R" | "Y" | "B";

export interface BoardArrow {
  color: BoardAnnotationColor;
  from: string;
  to: string;
}

export interface BoardHighlight {
  color: BoardAnnotationColor;
  square: string;
}

export interface ChessBoardProps {
  fen?: string;
  orientation?: "white" | "black";
  lastMove?: { from: string; to: string } | null;
  arrows?: readonly BoardArrow[];
  highlights?: readonly BoardHighlight[];
  interactive?: boolean;
  onMove?: (move: { from: string; to: string }) => void;
  theme?: BoardTheme;
  className?: string;
}

const PIECE_UNICODE: Record<string, string> = {
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

const ANNOTATION_COLORS: Record<BoardAnnotationColor, string> = {
  G: "rgba(21, 128, 61, 0.72)",
  R: "rgba(220, 38, 38, 0.72)",
  Y: "rgba(202, 138, 4, 0.72)",
  B: "rgba(37, 99, 235, 0.72)",
};

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const RANKS = ["8", "7", "6", "5", "4", "3", "2", "1"] as const;

function squareToCoords(square: string, orientation: "white" | "black"): { x: number; y: number } {
  const fileIndex = FILES.indexOf(square[0] as (typeof FILES)[number]);
  const rankIndex = RANKS.indexOf(square[1] as (typeof RANKS)[number]);
  const col = orientation === "white" ? fileIndex : 7 - fileIndex;
  const row = orientation === "white" ? rankIndex : 7 - rankIndex;
  return { x: col * 100 + 50, y: row * 100 + 50 };
}

export function ChessBoard({
  fen = INITIAL_FEN,
  orientation = "white",
  lastMove = null,
  arrows = [],
  highlights = [],
  interactive = false,
  onMove,
  theme = "default",
  className,
}: ChessBoardProps) {
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);

  let pieces: BoardPiece[] = [];
  try {
    pieces = new ChessPosition(fen).getPieces();
  } catch {
    pieces = new ChessPosition(INITIAL_FEN).getPieces();
  }

  const pieceBySquare = new Map<string, BoardPiece>();
  for (const piece of pieces) {
    pieceBySquare.set(piece.square, piece);
  }

  const highlightBySquare = new Map<string, BoardHighlight>();
  for (const highlight of highlights) {
    highlightBySquare.set(highlight.square, highlight);
  }

  const orderedFiles = orientation === "white" ? FILES : [...FILES].reverse();
  const orderedRanks = orientation === "white" ? RANKS : [...RANKS].reverse();

  const lightSquareColor = theme === "projector-high-contrast" ? "#ffffff" : "#f0d9b5";
  const darkSquareColor = theme === "projector-high-contrast" ? "#1e293b" : "#b58863";
  const borderColor = theme === "projector-high-contrast" ? "#0f172a" : "#785a3a";

  const handleSquareClick = (square: string) => {
    if (!interactive || !onMove) return;
    if (!selectedSquare) {
      if (pieceBySquare.has(square)) {
        setSelectedSquare(square);
      }
      return;
    }
    if (selectedSquare === square) {
      setSelectedSquare(null);
      return;
    }
    onMove({ from: selectedSquare, to: square });
    setSelectedSquare(null);
  };

  const containerStyle: CSSProperties = {
    position: "relative",
    width: "100%",
    maxWidth: "480px",
    aspectRatio: "1 / 1",
    border: `3px solid ${borderColor}`,
    borderRadius: "6px",
    overflow: "hidden",
    userSelect: "none",
  };

  return (
    <div
      className={className}
      data-testid="chess-board"
      data-theme={theme}
      data-orientation={orientation}
      style={containerStyle}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(8, minmax(0, 1fr))",
          gridTemplateRows: "repeat(8, minmax(0, 1fr))",
          width: "100%",
          height: "100%",
        }}
      >
        {orderedRanks.map((rank, rIdx) =>
          orderedFiles.map((file, fIdx) => {
            const square = `${file}${rank}`;
            const isLight = (rIdx + fIdx) % 2 === 0;
            const piece = pieceBySquare.get(square);
            const highlight = highlightBySquare.get(square);
            const isLastMove = lastMove?.from === square || lastMove?.to === square;
            const isSelected = selectedSquare === square;

            let backgroundColor = isLight ? lightSquareColor : darkSquareColor;
            if (isLastMove) {
              backgroundColor = theme === "projector-high-contrast" ? "#fde047" : "#cdd26a";
            }
            if (isSelected) {
              backgroundColor = "#38bdf8";
            }

            return (
              <button
                key={square}
                type="button"
                aria-label={`Square ${square}`}
                onClick={() => handleSquareClick(square)}
                style={{
                  position: "relative",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                  border: "none",
                  backgroundColor,
                  cursor: interactive ? "pointer" : "default",
                  fontSize: "clamp(1.25rem, 4vw, 2.25rem)",
                  lineHeight: 1,
                }}
              >
                {highlight ? (
                  <span
                    style={{
                      position: "absolute",
                      inset: "8%",
                      borderRadius: "9999px",
                      border: `4px solid ${ANNOTATION_COLORS[highlight.color]}`,
                      pointerEvents: "none",
                    }}
                  />
                ) : null}
                {piece ? (
                  <span
                    style={{
                      color:
                        theme === "projector-high-contrast" && !isLight && piece.color === "w"
                          ? "#f8fafc"
                          : "#111827",
                    }}
                  >
                    {PIECE_UNICODE[`${piece.color}${piece.type}`]}
                  </span>
                ) : null}
              </button>
            );
          }),
        )}
      </div>

      {arrows.length > 0 ? (
        <svg
          viewBox="0 0 800 800"
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
          }}
        >
          {arrows.map((arrow, idx) => {
            const from = squareToCoords(arrow.from, orientation);
            const to = squareToCoords(arrow.to, orientation);
            return (
              <line
                key={`${arrow.color}-${arrow.from}-${arrow.to}-${idx}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke={ANNOTATION_COLORS[arrow.color]}
                strokeWidth={18}
                strokeLinecap="round"
              />
            );
          })}
        </svg>
      ) : null}
    </div>
  );
}
