import { useState } from "react";
import { ChessBoard, type BoardAnnotationColor, type PromotionPiece } from "@suite/board-ui";
import { INITIAL_FEN, validateFen, type PgnGameDocument } from "@suite/chess-core";
import type { ArrowAnnotation, BoardOrientation, NodeId, SquareHighlight } from "@suite/pgna";
import { AccessibleDialog } from "@suite/ui";

export interface BoardStageProps {
  games: readonly PgnGameDocument[];
  activeGameIndex: number;
  fen: string;
  lastMove: { from: string; to: string } | null;
  orientation: BoardOrientation;
  arrows: readonly ArrowAnnotation[];
  highlights: readonly SquareHighlight[];
  annotationColor: BoardAnnotationColor;
  onChangeAnnotationColor: (color: BoardAnnotationColor) => void;
  onMove: (move: { from: string; to: string; promotion?: PromotionPiece }) => void;
  onToggleArrow: (from: string, to: string, color: BoardAnnotationColor) => void;
  onToggleHighlight: (square: string, color: BoardAnnotationColor) => void;
  onClearAnnotations: () => void;
  onFlipBoard: () => void;
  onStepFirst: () => void;
  onStepPrev: () => void;
  onStepNext: () => void;
  onStepLast: () => void;
  onSelectGame: (gameIndex: number) => void;
  onAddGame: (
    title: string,
    initialFen?: string,
    players?: { white?: string; black?: string },
  ) => void;
  onUpdateGameHeaders: (gameIndex: number, headers: Record<string, string>) => void;
  onDeleteGame: (gameIndex: number) => void;
  activeNodeId: NodeId;
}

const COLOR_BUTTONS: Array<{ code: BoardAnnotationColor; label: string; bg: string }> = [
  { code: "G", label: "Green (default)", bg: "bg-green-600" },
  { code: "R", label: "Red (Shift)", bg: "bg-red-600" },
  { code: "Y", label: "Yellow (Ctrl)", bg: "bg-yellow-500" },
  { code: "B", label: "Blue (Alt)", bg: "bg-blue-600" },
];

export function BoardStage({
  games,
  activeGameIndex,
  fen,
  lastMove,
  orientation,
  arrows,
  highlights,
  annotationColor,
  onChangeAnnotationColor,
  onMove,
  onToggleArrow,
  onToggleHighlight,
  onClearAnnotations,
  onFlipBoard,
  onStepFirst,
  onStepPrev,
  onStepNext,
  onStepLast,
  onSelectGame,
  onAddGame,
  onUpdateGameHeaders,
  onDeleteGame,
  activeNodeId,
}: BoardStageProps) {
  const [editingGameModal, setEditingGameModal] = useState<"new" | "edit" | null>(null);
  const [eventInput, setEventInput] = useState("");
  const [whiteInput, setWhiteInput] = useState("");
  const [blackInput, setBlackInput] = useState("");
  const [fenInput, setFenInput] = useState("");
  const [fenError, setFenError] = useState<string | null>(null);

  const activeGame = games[activeGameIndex];

  const openNewGameModal = () => {
    setEventInput(`Chapter ${games.length + 1}`);
    setWhiteInput("White");
    setBlackInput("Black");
    setFenInput("");
    setFenError(null);
    setEditingGameModal("new");
  };

  const openEditGameModal = () => {
    if (!activeGame) return;
    setEventInput(activeGame.headers["Event"] ?? `Chapter ${activeGameIndex + 1}`);
    setWhiteInput(activeGame.headers["White"] ?? "White");
    setBlackInput(activeGame.headers["Black"] ?? "Black");
    setFenInput(activeGame.headers["FEN"] ?? "");
    setFenError(null);
    setEditingGameModal("edit");
  };

  const handleSaveGameModal = () => {
    const trimmedFen = fenInput.trim();
    if (trimmedFen && !validateFen(trimmedFen)) {
      setFenError("Invalid FEN string.");
      return;
    }

    if (editingGameModal === "new") {
      onAddGame(
        eventInput.trim() || `Chapter ${games.length + 1}`,
        trimmedFen || undefined,
        {
          white: whiteInput.trim() || "White",
          black: blackInput.trim() || "Black",
        },
      );
    } else if (editingGameModal === "edit" && activeGame) {
      const nextHeaders: Record<string, string> = {
        ...activeGame.headers,
        Event: eventInput.trim() || `Chapter ${activeGameIndex + 1}`,
        White: whiteInput.trim() || "White",
        Black: blackInput.trim() || "Black",
      };
      if (trimmedFen && trimmedFen !== INITIAL_FEN) {
        nextHeaders["FEN"] = trimmedFen;
        nextHeaders["SetUp"] = "1";
      } else {
        delete nextHeaders["FEN"];
        delete nextHeaders["SetUp"];
      }
      onUpdateGameHeaders(activeGameIndex, nextHeaders);
    }
    setEditingGameModal(null);
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
      {/* Chapter / Game Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {games.map((g, idx) => (
            <button
              key={`game-tab-${idx}`}
              type="button"
              onClick={() => onSelectGame(idx)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                idx === activeGameIndex
                  ? "bg-slate-900 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {idx + 1}. {g.headers["Event"] || `Chapter ${idx + 1}`}
            </button>
          ))}
          <button
            type="button"
            onClick={openNewGameModal}
            className="rounded-md border border-dashed border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:border-slate-400 hover:text-slate-900"
          >
            + Chapter
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={openEditGameModal}
            className="rounded px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100"
          >
            Headers / FEN
          </button>
          {games.length > 1 ? (
            <button
              type="button"
              onClick={() => onDeleteGame(activeGameIndex)}
              className="rounded px-2 py-1 text-[11px] font-medium text-red-600 hover:bg-red-50"
            >
              Delete
            </button>
          ) : null}
        </div>
      </div>

      {/* Board */}
      <div className="mx-auto w-full max-w-[500px]">
        <ChessBoard
          fen={fen}
          orientation={orientation}
          lastMove={lastMove}
          arrows={arrows}
          highlights={highlights}
          interactive={true}
          onMove={onMove}
          annotationColor={annotationColor}
          onToggleArrow={onToggleArrow}
          onToggleHighlight={onToggleHighlight}
        />
      </div>

      {/* Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <div className="flex items-center gap-1">
          <button
            type="button"
            title="Start of game (Home)"
            onClick={onStepFirst}
            className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
          >
            |&lt;
          </button>
          <button
            type="button"
            title="Previous move (Left Arrow)"
            onClick={onStepPrev}
            className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
          >
            &lt;
          </button>
          <button
            type="button"
            title="Next move (Right Arrow)"
            onClick={onStepNext}
            className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
          >
            &gt;
          </button>
          <button
            type="button"
            title="End of line (End)"
            onClick={onStepLast}
            className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
          >
            &gt;|
          </button>
          <button
            type="button"
            onClick={onFlipBoard}
            className="ml-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Flip ({orientation})
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-medium text-slate-500">Draw:</span>
          {COLOR_BUTTONS.map((c) => (
            <button
              key={c.code}
              type="button"
              title={c.label}
              aria-label={`Annotation color ${c.label}`}
              onClick={() => onChangeAnnotationColor(c.code)}
              className={`h-5 w-5 rounded-full ${c.bg} transition ${
                annotationColor === c.code
                  ? "ring-2 ring-slate-900 ring-offset-1"
                  : "opacity-65 hover:opacity-100"
              }`}
            />
          ))}
          {arrows.length > 0 || highlights.length > 0 ? (
            <button
              type="button"
              onClick={onClearAnnotations}
              className="ml-1 rounded px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-100"
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-500">
        <span>
          Node <code className="font-semibold text-slate-800">{activeNodeId}</code> · Right-click
          square to highlight, right-drag for arrow
        </span>
        <span className="truncate font-mono text-[10px] text-slate-400" title={fen}>
          {fen.split(" ").slice(0, 2).join(" ")}
        </span>
      </div>

      {/* Add / Edit Chapter Modal */}
      <AccessibleDialog
        open={editingGameModal !== null}
        onClose={() => setEditingGameModal(null)}
        ariaLabelledBy="scribe-chapter-dialog-title"
        overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
        panelClassName="w-full max-w-md rounded-xl bg-white p-5 shadow-xl"
      >
        <h3 id="scribe-chapter-dialog-title" className="text-sm font-semibold text-slate-900">
          {editingGameModal === "new" ? "Add New Chapter / Game" : "Edit Chapter Headers & FEN"}
        </h3>
        <div className="mt-3 space-y-3 text-xs">
          <label className="block">
            <span className="font-medium text-slate-700">Event / Chapter Title</span>
            <input
              type="text"
              value={eventInput}
              onChange={(e) => setEventInput(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="font-medium text-slate-700">White</span>
              <input
                type="text"
                value={whiteInput}
                onChange={(e) => setWhiteInput(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5"
              />
            </label>
            <label className="block">
              <span className="font-medium text-slate-700">Black</span>
              <input
                type="text"
                value={blackInput}
                onChange={(e) => setBlackInput(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5"
              />
            </label>
          </div>
          <label className="block">
            <span className="font-medium text-slate-700">
              Starting FEN (leave blank for standard start)
            </span>
            <input
              type="text"
              value={fenInput}
              onChange={(e) => {
                setFenInput(e.target.value);
                setFenError(null);
              }}
              placeholder={INITIAL_FEN}
              className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-[11px]"
            />
          </label>
          {fenError ? <p className="text-red-600">{fenError}</p> : null}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setEditingGameModal(null)}
            className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSaveGameModal}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
          >
            Save
          </button>
        </div>
      </AccessibleDialog>
    </div>
  );
}
