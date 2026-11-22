import { useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { ChessPosition, INITIAL_FEN, type AppliedMove, type BoardPiece } from "@suite/chess-core";

export type BoardTheme = "default" | "projector-high-contrast";
export type BoardAnnotationColor = "G" | "R" | "Y" | "B";
export type PromotionPiece = "q" | "r" | "b" | "n";

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
  onMove?: (move: { from: string; to: string; promotion?: PromotionPiece }) => void;
  annotationColor?: BoardAnnotationColor;
  onToggleHighlight?: (square: string, color: BoardAnnotationColor) => void;
  onToggleArrow?: (from: string, to: string, color: BoardAnnotationColor) => void;
  showCoordinates?: boolean;
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

const PIECE_FILLED_UNICODE: Record<string, string> = {
  wp: "♟",
  wn: "♞",
  wb: "♝",
  wr: "♜",
  wq: "♛",
  wk: "♚",
  bp: "♟",
  bn: "♞",
  bb: "♝",
  br: "♜",
  bq: "♛",
  bk: "♚",
};

const ANNOTATION_COLORS: Record<BoardAnnotationColor, string> = {
  G: "rgba(21, 128, 61, 0.82)",
  R: "rgba(220, 38, 38, 0.82)",
  Y: "rgba(202, 138, 4, 0.82)",
  B: "rgba(37, 99, 235, 0.82)",
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

function resolveModifierColor(
  e: MouseEvent,
  defaultColor: BoardAnnotationColor,
): BoardAnnotationColor {
  if (e.shiftKey) return "R";
  if (e.altKey) return "B";
  if (e.ctrlKey || e.metaKey) return "Y";
  return defaultColor;
}

export function ChessBoard({
  fen = INITIAL_FEN,
  orientation = "white",
  lastMove = null,
  arrows = [],
  highlights = [],
  interactive = false,
  onMove,
  annotationColor = "G",
  onToggleHighlight,
  onToggleArrow,
  showCoordinates = true,
  theme = "default",
  className,
}: ChessBoardProps) {
  const [selectionState, setSelectionState] = useState<{ fen: string; square: string | null }>({
    fen,
    square: null,
  });
  const [pendingPromotion, setPendingPromotion] = useState<{
    fen: string;
    from: string;
    to: string;
    color: "w" | "b";
  } | null>(null);

  const leftDragOriginRef = useRef<string | null>(null);
  const rightDragRef = useRef<{ square: string; color: BoardAnnotationColor } | null>(null);

  const selectedSquare = selectionState.fen === fen ? selectionState.square : null;
  const activePromotion = pendingPromotion?.fen === fen ? pendingPromotion : null;

  let position: ChessPosition;
  try {
    position = new ChessPosition(fen);
  } catch {
    position = new ChessPosition(INITIAL_FEN);
  }

  const pieces: BoardPiece[] = position.getPieces();
  const legalMoves: AppliedMove[] = interactive ? position.getLegalMoves() : [];

  const pieceBySquare = new Map<string, BoardPiece>();
  for (const piece of pieces) {
    pieceBySquare.set(piece.square, piece);
  }

  const legalTargetsForSelected = new Set<string>();
  if (selectedSquare && interactive) {
    for (const m of legalMoves) {
      if (m.from === selectedSquare) {
        legalTargetsForSelected.add(m.to);
      }
    }
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
  const canAnnotate = Boolean(onToggleHighlight || onToggleArrow);

  const commitMove = (from: string, to: string) => {
    if (!interactive || !onMove) return;
    const matchingMoves = legalMoves.filter((m) => m.from === from && m.to === to);
    const hasPromotion = matchingMoves.some((m) => Boolean(m.promotion));
    if (hasPromotion) {
      const piece = pieceBySquare.get(from);
      setPendingPromotion({
        fen,
        from,
        to,
        color: piece?.color ?? position.turn,
      });
      setSelectionState({ fen, square: null });
      return;
    }
    onMove({ from, to });
    setSelectionState({ fen, square: null });
  };

  const handleSquareClick = (square: string) => {
    if (!interactive || !onMove) return;
    if (activePromotion) {
      setPendingPromotion(null);
      return;
    }

    if (!selectedSquare) {
      const piece = pieceBySquare.get(square);
      if (piece && piece.color === position.turn) {
        setSelectionState({ fen, square });
      }
      return;
    }

    if (selectedSquare === square) {
      setSelectionState({ fen, square: null });
      return;
    }

    // Re-select own piece if clicking another friendly piece
    const clickedPiece = pieceBySquare.get(square);
    if (clickedPiece && clickedPiece.color === position.turn && !legalTargetsForSelected.has(square)) {
      setSelectionState({ fen, square });
      return;
    }

    commitMove(selectedSquare, square);
  };

  const handleMouseDown = (e: MouseEvent, square: string) => {
    if (e.button === 2 && canAnnotate) {
      e.preventDefault();
      rightDragRef.current = {
        square,
        color: resolveModifierColor(e, annotationColor),
      };
      return;
    }

    if (e.button === 0 && interactive && onMove) {
      const piece = pieceBySquare.get(square);
      if (piece && piece.color === position.turn) {
        leftDragOriginRef.current = square;
      } else {
        leftDragOriginRef.current = null;
      }
    }
  };

  const handleMouseUp = (e: MouseEvent, square: string) => {
    if (e.button === 2 && rightDragRef.current) {
      e.preventDefault();
      const start = rightDragRef.current;
      rightDragRef.current = null;
      if (start.square === square) {
        onToggleHighlight?.(square, start.color);
      } else {
        onToggleArrow?.(start.square, square, start.color);
      }
      return;
    }

    if (e.button === 0 && leftDragOriginRef.current) {
      const origin = leftDragOriginRef.current;
      leftDragOriginRef.current = null;
      if (origin !== square && interactive && onMove) {
        const isLegal = legalMoves.some((m) => m.from === origin && m.to === square);
        if (isLegal) {
          commitMove(origin, square);
        }
      }
    }
  };

  const containerStyle: CSSProperties = {
    position: "relative",
    width: "100%",
    maxWidth: "520px",
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
      onContextMenu={canAnnotate ? (e) => e.preventDefault() : undefined}
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
            const isLegalTarget = legalTargetsForSelected.has(square);

            let backgroundColor = isLight ? lightSquareColor : darkSquareColor;
            if (isLastMove) {
              backgroundColor = theme === "projector-high-contrast" ? "#fde047" : "#cdd26a";
            }
            if (isSelected) {
              backgroundColor = "#38bdf8";
            }

            const coordColor = isLight
              ? theme === "projector-high-contrast"
                ? "#1e293b"
                : "#8c6239"
              : theme === "projector-high-contrast"
                ? "#e2e8f0"
                : "#f5e6cc";

            return (
              <button
                key={square}
                type="button"
                aria-label={`Square ${square}`}
                onClick={() => handleSquareClick(square)}
                onMouseDown={(e) => handleMouseDown(e, square)}
                onMouseUp={(e) => handleMouseUp(e, square)}
                style={{
                  position: "relative",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                  border: "none",
                  backgroundColor,
                  cursor: interactive ? "pointer" : canAnnotate ? "crosshair" : "default",
                  fontSize: "clamp(1.35rem, 4.2vw, 2.55rem)",
                  lineHeight: 1,
                }}
              >
                {showCoordinates && fIdx === 0 ? (
                  <span
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      top: "2px",
                      left: "3px",
                      fontSize: "10px",
                      fontWeight: 700,
                      color: coordColor,
                      lineHeight: 1,
                      pointerEvents: "none",
                    }}
                  >
                    {rank}
                  </span>
                ) : null}

                {showCoordinates && rIdx === 7 ? (
                  <span
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      bottom: "2px",
                      right: "3px",
                      fontSize: "10px",
                      fontWeight: 700,
                      color: coordColor,
                      lineHeight: 1,
                      pointerEvents: "none",
                    }}
                  >
                    {file}
                  </span>
                ) : null}

                {highlight ? (
                  <span
                    style={{
                      position: "absolute",
                      inset: "7%",
                      borderRadius: "9999px",
                      border: `4px solid ${ANNOTATION_COLORS[highlight.color]}`,
                      pointerEvents: "none",
                    }}
                  />
                ) : null}

                {isLegalTarget && !piece ? (
                  <span
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      width: "28%",
                      height: "28%",
                      borderRadius: "9999px",
                      backgroundColor: "rgba(15, 23, 42, 0.28)",
                      pointerEvents: "none",
                    }}
                  />
                ) : null}

                {isLegalTarget && piece ? (
                  <span
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      inset: "4%",
                      borderRadius: "9999px",
                      border: "4px solid rgba(15, 23, 42, 0.34)",
                      pointerEvents: "none",
                    }}
                  />
                ) : null}

                {piece ? (
                  <span
                    style={{
                      position: "relative",
                      zIndex: 1,
                      color: piece.color === "w" ? "#ffffff" : "#111827",
                      textShadow:
                        piece.color === "w"
                          ? "0 0 2px #0f172a, 0 1px 2px rgba(15,23,42,0.85)"
                          : "0 0 1px rgba(255,255,255,0.55), 0 1px 1px rgba(0,0,0,0.35)",
                      pointerEvents: "none",
                    }}
                  >
                    {PIECE_FILLED_UNICODE[`${piece.color}${piece.type}`]}
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
            zIndex: 2,
          }}
        >
          {arrows.map((arrow, idx) => {
            const from = squareToCoords(arrow.from, orientation);
            const to = squareToCoords(arrow.to, orientation);
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const length = Math.hypot(dx, dy);
            if (length < 1) return null;

            const ux = dx / length;
            const uy = dy / length;
            const headLen = 36;
            const headWidth = 22;
            const lineEndX = to.x - ux * (headLen * 0.85);
            const lineEndY = to.y - uy * (headLen * 0.85);
            const baseCenterX = to.x - ux * headLen;
            const baseCenterY = to.y - uy * headLen;
            const perpX = -uy;
            const perpY = ux;

            const tip = `${to.x},${to.y}`;
            const leftCorner = `${baseCenterX + perpX * headWidth},${baseCenterY + perpY * headWidth}`;
            const rightCorner = `${baseCenterX - perpX * headWidth},${baseCenterY - perpY * headWidth}`;
            const fill = ANNOTATION_COLORS[arrow.color];

            return (
              <g key={`${arrow.color}-${arrow.from}-${arrow.to}-${idx}`}>
                <line
                  x1={from.x}
                  y1={from.y}
                  x2={lineEndX}
                  y2={lineEndY}
                  stroke={fill}
                  strokeWidth={16}
                  strokeLinecap="round"
                />
                <polygon points={`${tip} ${leftCorner} ${rightCorner}`} fill={fill} />
              </g>
            );
          })}
        </svg>
      ) : null}

      {activePromotion ? (
        <div
          role="dialog"
          aria-label="Choose promotion piece"
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor: "rgba(15, 23, 42, 0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10,
          }}
          onClick={() => setPendingPromotion(null)}
        >
          <div
            style={{
              backgroundColor: "#ffffff",
              borderRadius: "10px",
              padding: "12px",
              display: "flex",
              gap: "8px",
              boxShadow: "0 12px 24px rgba(0,0,0,0.25)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {(["q", "r", "b", "n"] as const).map((promo) => (
              <button
                key={promo}
                type="button"
                aria-label={`Promote to ${promo}`}
                onClick={() => {
                  onMove?.({
                    from: activePromotion.from,
                    to: activePromotion.to,
                    promotion: promo,
                  });
                  setPendingPromotion(null);
                }}
                style={{
                  width: "52px",
                  height: "52px",
                  borderRadius: "8px",
                  border: "1px solid #cbd5e1",
                  backgroundColor: "#f8fafc",
                  fontSize: "2rem",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {PIECE_UNICODE[`${activePromotion.color}${promo}`]}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
