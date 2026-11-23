import { KibitzLogo, SUITE_SERVICES, resolveServiceUrl, type SuiteServiceInfo } from "@suite/ui";
import { AuthMenu } from "./components/AuthMenu";

const VITE_ENV = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

const SUITE_PILLARS = [
  {
    code: "01",
    title: "Zero-Upload Offline Tools",
    body: "Arbiter and Seconds run offline as PWAs and may pull tournament data via Kibitz ID, while never uploading rosters or scoresheets.",
  },
  {
    code: "02",
    title: "Narrated PGNA v1.0",
    body: "Portable chess workbooks combining PGN move trees, board arrows, and synced voice commentary in one open format.",
  },
  {
    code: "03",
    title: "Safe by Architecture",
    body: "Invite-only pseudonymous accounts, double-blind coach linking, no open lobbies, and no student chat.",
  },
] as const;

function ServiceCard({ service, href }: { service: SuiteServiceInfo; href: string }) {
  const isAvailable = service.status === "available";
  const ctaLabel = isAvailable
    ? service.id === "scribe"
      ? "Launch Studio"
      : "Open Service"
    : "Open Page";

  return (
    <a
      id={`service-link-${service.id}`}
      href={href}
      className={`group flex flex-col justify-between rounded-2xl border p-6 transition duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 ${
        isAvailable
          ? "border-slate-900/15 bg-slate-900 text-white shadow-sm hover:-translate-y-0.5 hover:shadow-md"
          : "border-stone-200/90 bg-white text-slate-900 shadow-2xs hover:-translate-y-0.5 hover:border-stone-300 hover:shadow-sm"
      }`}
    >
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <h3
              className={`text-lg font-semibold tracking-tight ${
                isAvailable ? "text-white" : "text-slate-900"
              }`}
            >
              {service.name}
            </h3>
            <code
              className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                isAvailable ? "bg-white/10 text-slate-300" : "bg-stone-100 text-slate-500"
              }`}
            >
              {service.subdomain}.*
            </code>
          </div>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold tracking-wide ${
              isAvailable
                ? "bg-amber-300 text-slate-950"
                : "border border-stone-200 bg-stone-50 text-stone-600"
            }`}
          >
            {isAvailable ? "Available" : "Coming Soon"}
          </span>
        </div>

        <p
          className={`mt-1.5 text-sm font-medium ${
            isAvailable ? "text-amber-200/90" : "text-slate-600"
          }`}
        >
          {service.tagline}
        </p>

        <p
          className={`mt-3 text-sm leading-relaxed ${
            isAvailable ? "text-slate-300" : "text-slate-500"
          }`}
        >
          {service.description}
        </p>
      </div>

      <div
        className={`mt-6 flex items-center justify-between border-t pt-4 text-xs ${
          isAvailable ? "border-white/10" : "border-stone-100"
        }`}
      >
        <span className={isAvailable ? "text-slate-300" : "text-slate-500"}>
          {service.privacyBadge}
        </span>
        <span
          className={`inline-flex items-center gap-1 font-semibold transition-transform group-hover:translate-x-0.5 ${
            isAvailable ? "text-amber-300" : "text-slate-900"
          }`}
        >
          {ctaLabel}
          <span aria-hidden="true">→</span>
        </span>
      </div>
    </a>
  );
}

export function App() {
  const availableServices = SUITE_SERVICES.filter((s) => s.status === "available");
  const upcomingServices = SUITE_SERVICES.filter((s) => s.status !== "available");
  const orderedServices = [...availableServices, ...upcomingServices];
  const scribeUrl = resolveServiceUrl("scribe", { env: VITE_ENV });

  return (
    <div className="min-h-screen bg-[#fafaf8] text-slate-900">
      <header className="sticky top-0 z-20 border-b border-stone-200/80 bg-[#fafaf8]/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3.5">
          <a
            id="kibitz-brand-home"
            href="#top"
            className="inline-flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2"
          >
            <KibitzLogo size="md" subtitle="Chess Suite" />
          </a>

          <nav
            aria-label="Primary navigation"
            className="flex flex-wrap items-center gap-3 sm:gap-4"
          >
            <a
              id="nav-services"
              href="#services"
              className="text-sm font-medium text-slate-600 transition hover:text-slate-900"
            >
              Services
            </a>
            <AuthMenu />
            <a
              id="nav-launch-scribe"
              href={scribeUrl}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              Open Scribe
              <span aria-hidden="true" className="text-amber-300">
                →
              </span>
            </a>
          </nav>
        </div>
      </header>

      <main id="top">
        <section className="border-b border-stone-200/80">
          <div className="mx-auto grid max-w-6xl gap-12 px-6 py-16 lg:grid-cols-12 lg:items-center lg:py-24">
            <div className="lg:col-span-7">
              <p className="text-xs font-semibold tracking-[0.14em] text-stone-500 uppercase">
                Open-Source Chess Education &amp; Club Suite
              </p>
              <h1 className="mt-4 text-4xl font-bold tracking-[-0.03em] text-slate-950 sm:text-5xl sm:leading-[1.08]">
                Privacy-first chess tools for coaches, clubs, and students.
              </h1>
              <p className="mt-5 max-w-xl text-base leading-relaxed text-slate-600 sm:text-lg">
                Kibitz brings together narrated PGNA v1.0 chess workbooks, distraction-free club
                tournaments, and offline classroom utilities — designed from the ground up to keep
                student data private.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-3.5">
                <a
                  id="hero-launch-scribe"
                  href={scribeUrl}
                  className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-xs transition hover:bg-slate-800"
                >
                  Open Scribe Studio
                  <span aria-hidden="true" className="text-amber-300">
                    →
                  </span>
                </a>
                <a
                  id="hero-explore-services"
                  href="#services"
                  className="inline-flex items-center rounded-xl border border-stone-300 bg-white px-5 py-3 text-sm font-semibold text-slate-800 transition hover:border-stone-400 hover:bg-stone-50"
                >
                  Explore All Services
                </a>
              </div>
            </div>

            <aside
              aria-label="Suite principles"
              className="rounded-2xl border border-stone-200/90 bg-white p-6 shadow-xs lg:col-span-5"
            >
              <div className="flex items-center justify-between border-b border-stone-100 pb-4">
                <span className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
                  Architectural Commitments
                </span>
                <span className="rounded-md bg-stone-100 px-2 py-0.5 font-mono text-[11px] font-medium text-stone-600">
                  AGPL-3.0
                </span>
              </div>

              <ol className="mt-5 space-y-5">
                {SUITE_PILLARS.map((pillar) => (
                  <li key={pillar.code} className="flex gap-3.5">
                    <span className="mt-0.5 font-mono text-xs font-semibold text-amber-600">
                      {pillar.code}
                    </span>
                    <div>
                      <h2 className="text-sm font-semibold text-slate-900">{pillar.title}</h2>
                      <p className="mt-1 text-sm leading-relaxed text-slate-500">{pillar.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </aside>
          </div>
        </section>

        <section id="services" className="mx-auto max-w-6xl px-6 py-16 lg:py-20">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold tracking-[-0.02em] text-slate-950 sm:text-3xl">
                Suite Services
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600">
                Each service runs on its own subdomain with strict privacy boundaries. Scribe and
                Kibitz ID are ready today; the remaining services are in active development.
              </p>
            </div>
            <span className="text-xs font-medium text-stone-500">
              {availableServices.length} live · {upcomingServices.length} in development
            </span>
          </div>

          <div className="mt-8 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {orderedServices.map((service) => (
              <ServiceCard
                key={service.id}
                service={service}
                href={resolveServiceUrl(service.id, { env: VITE_ENV })}
              />
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-stone-200/80 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-6 text-xs text-slate-500">
          <KibitzLogo size="sm" />
          <p>
            Built around PGNA v1.0 · Zero-upload offline tools · Licensed under{" "}
            <span className="font-medium text-slate-700">AGPL-3.0-only</span>
          </p>
        </div>
      </footer>
    </div>
  );
}
