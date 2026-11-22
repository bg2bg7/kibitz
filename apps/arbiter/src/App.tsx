import { useEffect, useState } from "react";
import { ChessBoard } from "@suite/board-ui";
import { INITIAL_FEN } from "@suite/chess-core";
import { AppShell } from "@suite/ui";

export function App() {
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return (
    <AppShell
      appName="Arbiter"
      subdomain="arbiter.kibitz.local"
      badge="100% Offline PWA · Zero-PII"
      subtitle="Client-side chess club & tournament manager. All rosters, pairings, and scores stay on this device (IndexedDB/OPFS + JSON backup)."
    >
      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-xs">
          <h2 className="text-base font-semibold text-slate-900">Offline Firewall Status</h2>
          <p className="mt-2 text-sm text-slate-600">
            Network state:{" "}
            <strong>{isOnline ? "Online (unused)" : "Offline (fully operational)"}</strong>
          </p>
          <p className="mt-2 text-sm text-slate-600">
            Auth, telemetry, and server uploads are strictly forbidden by ESLint boundary rules.
          </p>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-xs">
          <h2 className="mb-3 text-base font-semibold text-slate-900">Board Preview</h2>
          <ChessBoard fen={INITIAL_FEN} />
        </section>
      </div>
    </AppShell>
  );
}
