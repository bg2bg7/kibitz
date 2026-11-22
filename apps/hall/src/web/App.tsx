import { useState } from "react";
import { ChessBoard } from "@suite/board-ui";
import { ChessPosition, INITIAL_FEN } from "@suite/chess-core";
import { AppShell, EmojiReactionBar, type CuratedStudentEmojiId } from "@suite/ui";

export function App() {
  const [fen, setFen] = useState(INITIAL_FEN);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [reaction, setReaction] = useState<CuratedStudentEmojiId | null>(null);

  const handleLocalPreviewMove = (move: { from: string; to: string }) => {
    const pos = new ChessPosition(fen);
    const applied = pos.tryMove(move);
    if (applied) {
      setFen(applied.fen);
      setLastMove({ from: applied.from, to: applied.to });
    }
  };

  return (
    <AppShell
      appName="Hall"
      subdomain="hall.kibitz.local"
      badge="Scheduled Club Tournaments Only · No Chat"
      subtitle="Private live chess client strictly for arbiter-paired club tournaments. Finished PGNs export cleanly to Scribe."
    >
      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-xs">
          <h2 className="text-base font-semibold text-slate-900">Tournament Table Shell</h2>
          <p className="mt-2 text-sm text-slate-600">
            Open lobby and random matchmaking are disabled. Join via account or arbiter-issued seat
            token.
          </p>
          <div className="mt-4">
            <EmojiReactionBar
              selected={reaction}
              onSelect={setReaction}
              label="Good sportsmanship reaction"
            />
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-xs">
          <h2 className="mb-3 text-base font-semibold text-slate-900">Interactive Game Board</h2>
          <ChessBoard fen={fen} lastMove={lastMove} interactive onMove={handleLocalPreviewMove} />
        </section>
      </div>
    </AppShell>
  );
}
