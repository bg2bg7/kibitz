import { useState } from "react";
import { ChessBoard, type BoardTheme } from "@suite/board-ui";
import { INITIAL_FEN } from "@suite/chess-core";
import { AppShell } from "@suite/ui";

export function App() {
  const [theme, setTheme] = useState<BoardTheme>("projector-high-contrast");

  return (
    <AppShell
      appName="Seconds"
      subdomain="seconds.kibitz.local"
      badge="100% Offline PWA · Zero-PII"
      subtitle="Parent & classroom utility kit: scoresheet-to-PGN helper, rating calculator, printable puzzle worksheets, and high-contrast classroom projector mode."
    >
      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-xs">
          <h2 className="text-base font-semibold text-slate-900">Classroom Projector Mode</h2>
          <p className="mt-2 text-sm text-slate-600">
            Zero accounts, zero network calls, zero student data leaves this browser.
          </p>
          <button
            type="button"
            onClick={() =>
              setTheme((prev) => (prev === "default" ? "projector-high-contrast" : "default"))
            }
            className="mt-4 rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Toggle Board Theme ({theme})
          </button>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-xs">
          <h2 className="mb-3 text-base font-semibold text-slate-900">Demo Board</h2>
          <ChessBoard fen={INITIAL_FEN} theme={theme} />
        </section>
      </div>
    </AppShell>
  );
}
