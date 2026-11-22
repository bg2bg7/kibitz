import { Chess } from "chess.js";

export type Color = "w" | "b";
export type PieceSymbol = "p" | "n" | "b" | "r" | "q" | "k";

export interface MoveInput {
  from: string;
  to: string;
  promotion?: Exclude<PieceSymbol, "p" | "k">;
}

export interface AppliedMove {
  from: string;
  to: string;
  san: string;
  fen: string;
  color: Color;
  piece: PieceSymbol;
  promotion?: Exclude<PieceSymbol, "p" | "k">;
}

export interface BoardPiece {
  square: string;
  color: Color;
  type: PieceSymbol;
}

export const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/**
 * Pure, zero-DOM standard chess state wrapper used identically across browsers and Node.
 */
export class ChessPosition {
  private readonly engine: Chess;

  constructor(fen: string = INITIAL_FEN) {
    this.engine = new Chess(fen);
  }

  get fen(): string {
    return this.engine.fen();
  }

  get turn(): Color {
    return this.engine.turn();
  }

  get isGameOver(): boolean {
    return this.engine.isGameOver();
  }

  get isCheckmate(): boolean {
    return this.engine.isCheckmate();
  }

  get isDraw(): boolean {
    return this.engine.isDraw();
  }

  getLegalMoves(): AppliedMove[] {
    return this.engine.moves({ verbose: true }).map((move) => ({
      from: move.from,
      to: move.to,
      san: move.san,
      fen: move.after,
      color: move.color,
      piece: move.piece,
      ...(move.promotion ? { promotion: move.promotion as Exclude<PieceSymbol, "p" | "k"> } : {}),
    }));
  }

  /**
   * Attempts to apply a SAN string or coordinate move. Returns null if illegal.
   */
  tryMove(move: string | MoveInput): AppliedMove | null {
    try {
      const applied = this.engine.move(move);
      if (!applied) return null;
      return {
        from: applied.from,
        to: applied.to,
        san: applied.san,
        fen: this.engine.fen(),
        color: applied.color,
        piece: applied.piece,
        ...(applied.promotion
          ? { promotion: applied.promotion as Exclude<PieceSymbol, "p" | "k"> }
          : {}),
      };
    } catch {
      return null;
    }
  }

  /**
   * Parses the current FEN board placement into a flat list of pieces for UI/SVG renderers.
   */
  getPieces(): BoardPiece[] {
    const pieces: BoardPiece[] = [];
    for (const row of this.engine.board()) {
      for (const cell of row) {
        if (cell) {
          pieces.push({
            square: cell.square,
            color: cell.color,
            type: cell.type,
          });
        }
      }
    }
    return pieces;
  }
}

export function isLegalMove(fen: string, move: string | MoveInput): boolean {
  const position = new ChessPosition(fen);
  return position.tryMove(move) !== null;
}

export function validateFen(fen: string): boolean {
  try {
    new Chess(fen);
    return true;
  } catch {
    return false;
  }
}
