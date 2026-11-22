import { useState } from "react";
import { ChessBoard } from "@suite/board-ui";
import { INITIAL_FEN } from "@suite/chess-core";
import { AppShell, EmojiReactionBar, type CuratedStudentEmojiId } from "@suite/ui";

export function App() {
  const [reaction, setReaction] = useState<CuratedStudentEmojiId | null>(null);

  return (
    <AppShell
      appName="Kibitz"
      subdomain="kibitz.kibitz.local"
      badge="PGNA Lecture Library · Emoji-Only Student Feedback"
      subtitle="Free 800-1200 opening primers are open to all. Coach assignments and multi-coach playlists unlock upon login via id."
    >
      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-xs">
          <h2 className="text-base font-semibold text-slate-900">Public Primer Preview</h2>
          <p className="mt-2 text-sm text-slate-600">
            Italian Game Essentials (PGNA v1.0). Student feedback is strictly limited to curated
            emoji reactions (no chat or DMs).
          </p>
          <div className="mt-4">
            <EmojiReactionBar selected={reaction} onSelect={setReaction} />
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-xs">
          <h2 className="mb-3 text-base font-semibold text-slate-900">Lecture Board</h2>
          <ChessBoard fen={INITIAL_FEN} arrows={[{ color: "G", from: "e2", to: "e4" }]} />
        </section>
      </div>
    </AppShell>
  );
}
