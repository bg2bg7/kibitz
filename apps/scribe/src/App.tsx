import { ChessBoard } from "@suite/board-ui";
import { INITIAL_FEN } from "@suite/chess-core";
import { compilePgna } from "@suite/pgna/compiler";
import { AppShell } from "@suite/ui";
import { createLocalDraftManifest } from "./local/draftWorkspace";

export function App() {
  const manifest = createLocalDraftManifest("Untitled PGNA Study");
  const compiled = compilePgna({ manifest, pgnText: "1. e4 e5 *" });

  return (
    <AppShell
      appName="Scribe"
      subdomain="scribe.kibitz.local"
      badge="Client-First SPA · PGNA v1.0"
      subtitle="Browser-based PGNA authoring studio & async PGN review. Local authoring requires zero account; Kibitz publishing is isolated in src/publish/."
    >
      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-xs">
          <h2 className="text-base font-semibold text-slate-900">Local Draft Workspace</h2>
          <dl className="mt-3 space-y-1 text-sm text-slate-600">
            <div>
              <dt className="inline font-medium text-slate-800">Format: </dt>
              <dd className="inline">PGNA v{manifest.version}</dd>
            </div>
            <div>
              <dt className="inline font-medium text-slate-800">Timeline duration: </dt>
              <dd className="inline">{compiled.timeline.totalDurationMs} ms</dd>
            </div>
          </dl>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-xs">
          <h2 className="mb-3 text-base font-semibold text-slate-900">Authoring Board</h2>
          <ChessBoard
            fen={INITIAL_FEN}
            arrows={[{ color: "G", from: "e2", to: "e4" }]}
            highlights={[{ color: "Y", square: "e4" }]}
          />
        </section>
      </div>
    </AppShell>
  );
}
