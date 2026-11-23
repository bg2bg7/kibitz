import { AppShell, resolveServiceUrl } from "@suite/ui";

const VITE_ENV = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

export function App() {
  const homeUrl = resolveServiceUrl("kibitz", { env: VITE_ENV });

  return (
    <AppShell
      appName="Seconds"
      subdomain="seconds.kibitz.local"
      badge="100% Offline PWA · Zero-PII"
      homeHref={homeUrl}
    >
      <section className="rounded-xl border border-slate-200 bg-white p-8 shadow-2xs">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Hello, World!</h1>
        <p className="mt-2 text-sm text-slate-600">
          Kibitz Seconds (100% offline Zero-PII parent &amp; classroom utility kit) is currently
          under construction.
        </p>
        <div className="mt-6">
          <a
            href={homeUrl}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
          >
            <span aria-hidden="true">←</span> Back to Kibitz
          </a>
        </div>
      </section>
    </AppShell>
  );
}
