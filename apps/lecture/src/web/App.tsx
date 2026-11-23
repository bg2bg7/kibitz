import { useCallback, useEffect, useState } from "react";
import {
  KibitzAuthMenu,
  KibitzLogo,
  fetchKibitzSession,
  resolveServiceUrl,
  type KibitzSessionUser,
} from "@suite/ui";
import { AccountLecturePage } from "./components/AccountLecturePage";
import { LectureBrowser } from "./components/LectureBrowser";
import { LectureViewer } from "./components/LectureViewer";
import { parseLectureLocation, type LectureRoute } from "./routes";

const VITE_ENV = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

export interface LectureAppProps {
  /** Optional initial path for SSR tests (e.g., `/`, `/@demo_coach`, `/studies/123`). */
  initialPath?: string;
}

function resolveInitialRoute(initialPath?: string): LectureRoute {
  if (initialPath) {
    const [pathPart = "/", queryPart = ""] = initialPath.split("?");
    return parseLectureLocation(pathPart, queryPart ? `?${queryPart}` : "");
  }
  if (typeof window !== "undefined") {
    return parseLectureLocation(window.location.pathname, window.location.search);
  }
  return { kind: "browser", tag: null, query: "" };
}

export function App({ initialPath }: LectureAppProps) {
  const homeUrl = resolveServiceUrl("kibitz", { env: VITE_ENV });
  const scribeUrl = resolveServiceUrl("scribe", { env: VITE_ENV });
  const idUrl = resolveServiceUrl("id", { env: VITE_ENV });

  const [route, setRoute] = useState<LectureRoute>(() => resolveInitialRoute(initialPath));
  const [sessionUser, setSessionUser] = useState<KibitzSessionUser | null>(null);

  useEffect(() => {
    let mounted = true;
    void fetchKibitzSession({ env: VITE_ENV }).then((session) => {
      if (mounted && session.authenticated && session.user) {
        setSessionUser(session.user);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPopState = () => {
      setRoute(parseLectureLocation(window.location.pathname, window.location.search));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((urlPath: string, replace = false) => {
    if (typeof window !== "undefined") {
      if (replace) {
        window.history.replaceState({}, "", urlPath);
      } else {
        window.history.pushState({}, "", urlPath);
      }
    }
    const [pathPart = "/", queryPart = ""] = urlPath.split("?");
    setRoute(parseLectureLocation(pathPart, queryPart ? `?${queryPart}` : ""));
    if (typeof window !== "undefined" && !replace) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, []);

  const openBrowser = useCallback(
    (tag: string | null = null, query = "", replace = false) => {
      const params = new URLSearchParams();
      if (tag) params.set("tag", tag);
      if (query.trim()) params.set("q", query.trim());
      const qs = params.toString();
      navigate(qs ? `/?${qs}` : "/", replace);
    },
    [navigate],
  );

  const openAccount = useCallback(
    (handle: string) => {
      const clean = handle.trim().replace(/^@+/, "");
      if (!clean) return;
      navigate(`/@${encodeURIComponent(clean)}`);
    },
    [navigate],
  );

  const openStudy = useCallback(
    (studyId: string) => {
      navigate(`/studies/${encodeURIComponent(studyId)}`);
    },
    [navigate],
  );

  const canHaveLecturePage =
    sessionUser !== null &&
    (sessionUser.role === "coach" ||
      sessionUser.role === "moderator" ||
      sessionUser.role === "admin");

  const sessionKey = sessionUser ? `${sessionUser.sub}:${sessionUser.role}` : "anon";

  return (
    <div className="min-h-screen bg-[#fafaf8] text-slate-900">
      <header className="sticky top-0 z-20 border-b border-stone-200/80 bg-[#fafaf8]/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <a
              href={homeUrl}
              aria-label="Back to Kibitz homepage"
              className="inline-flex items-center text-slate-900"
            >
              <KibitzLogo size="sm" />
            </a>
            <span aria-hidden="true" className="text-stone-300 select-none">
              /
            </span>
            <button
              type="button"
              onClick={() => openBrowser()}
              className="flex items-baseline gap-2 text-left"
            >
              <strong className="text-base font-bold tracking-tight text-slate-950">Lecture</strong>
              <code className="rounded bg-stone-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500">
                lecture.kibitz.local
              </code>
            </button>
          </div>

          <nav aria-label="Lecture navigation" className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => openBrowser()}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                route.kind === "browser"
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-stone-200/70 hover:text-slate-900"
              }`}
            >
              Browse
            </button>

            {canHaveLecturePage ? (
              <button
                type="button"
                onClick={() => openAccount(sessionUser.handle)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  route.kind === "account" &&
                  route.handle.toLowerCase() === sessionUser.handle.toLowerCase()
                    ? "bg-slate-900 text-white"
                    : "border border-stone-200 bg-white text-slate-700 hover:bg-stone-50"
                }`}
              >
                My Lecture Page
              </button>
            ) : null}

            <a
              href={scribeUrl}
              className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 transition hover:border-stone-300 hover:bg-stone-50"
            >
              Open Scribe
            </a>

            <KibitzAuthMenu
              env={VITE_ENV}
              user={sessionUser}
              onSessionChange={setSessionUser}
              accountHref={
                canHaveLecturePage
                  ? `/@${encodeURIComponent(sessionUser.handle)}`
                  : idUrl
              }
              compact
            />
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-7">
        {route.kind === "browser" ? (
          <LectureBrowser
            key={`${route.tag ?? ""}|${route.query}|${sessionKey}`}
            selectedTag={route.tag}
            appliedQuery={route.query}
            onOpenStudy={openStudy}
            onOpenAccount={openAccount}
            onChangeFilterUrl={(tag, query) => openBrowser(tag, query, true)}
          />
        ) : route.kind === "account" ? (
          <AccountLecturePage
            key={`${route.handle.toLowerCase()}|${sessionKey}`}
            handle={route.handle}
            sessionUser={sessionUser}
            onBackToBrowser={() => openBrowser()}
            onOpenStudy={openStudy}
          />
        ) : (
          <LectureViewer
            key={`${route.studyId}|${sessionKey}`}
            studyId={route.studyId}
            onBackToBrowser={() => openBrowser()}
            onOpenAccount={openAccount}
            onSelectTag={(tag) => openBrowser(tag)}
          />
        )}
      </main>
    </div>
  );
}
