import { useRef, type ChangeEvent } from "react";
import { KibitzAuthMenu, resolveServiceUrl, type KibitzSessionUser } from "@suite/ui";

const VITE_ENV = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

export type StudioMode = "author" | "preview";

export interface StudioHeaderProps {
  title: string;
  onChangeTitle: (nextTitle: string) => void;
  studioMode: StudioMode;
  onChangeStudioMode: (mode: StudioMode) => void;
  saveStatus: string;
  errorCount: number;
  warningCount: number;
  sessionUser: KibitzSessionUser | null;
  onSessionChange: (user: KibitzSessionUser | null) => void;
  onToggleDiagnostics: () => void;
  onOpenDrafts: () => void;
  onImportFile: (file: File) => void;
  onExportPgna: () => void;
  onExportPgn: () => void;
  onOpenPublish: () => void;
}

export function StudioHeader({
  title,
  onChangeTitle,
  studioMode,
  onChangeStudioMode,
  saveStatus,
  errorCount,
  warningCount,
  sessionUser,
  onSessionChange,
  onToggleDiagnostics,
  onOpenDrafts,
  onImportFile,
  onExportPgna,
  onExportPgn,
  onOpenPublish,
}: StudioHeaderProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const kibitzHomeUrl = resolveServiceUrl("kibitz", { env: VITE_ENV });
  const lectureUrl = resolveServiceUrl("lecture", { env: VITE_ENV });
  const idUrl = resolveServiceUrl("id", { env: VITE_ENV });
  const canHaveLecturePage =
    sessionUser !== null &&
    (sessionUser.role === "coach" ||
      sessionUser.role === "moderator" ||
      sessionUser.role === "admin");
  const accountHref = canHaveLecturePage
    ? `${lectureUrl}/@${encodeURIComponent(sessionUser.handle)}`
    : idUrl;

  const handleFileSelected = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onImportFile(file);
    }
    e.target.value = "";
  };

  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 px-4 py-2.5 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex items-center gap-2">
            <a
              href={kibitzHomeUrl}
              title="Back to Kibitz homepage"
              aria-label="Back to Kibitz homepage"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900 text-sm font-bold text-amber-300 transition hover:bg-slate-800"
            >
              ♞
            </a>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold tracking-tight text-slate-900">Scribe</span>
                <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-800">
                  PGNA v1.0
                </span>
              </div>
              <span className="text-[11px] text-slate-500">{saveStatus}</span>
            </div>
          </div>

          <input
            type="text"
            aria-label="Study title"
            value={title}
            onChange={(e) => onChangeTitle(e.target.value)}
            placeholder="Untitled PGNA Study"
            className="w-48 rounded-md border border-transparent bg-slate-100/80 px-2.5 py-1 text-sm font-medium text-slate-900 transition hover:border-slate-300 focus:border-sky-500 focus:bg-white focus:outline-none sm:w-64"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="tablist"
            aria-label="Workspace mode"
            className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5 text-xs font-medium"
          >
            <button
              type="button"
              role="tab"
              aria-selected={studioMode === "author"}
              onClick={() => onChangeStudioMode("author")}
              className={`rounded-md px-3 py-1 transition ${
                studioMode === "author"
                  ? "bg-white text-slate-900 shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              Author
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={studioMode === "preview"}
              onClick={() => onChangeStudioMode("preview")}
              className={`rounded-md px-3 py-1 transition ${
                studioMode === "preview"
                  ? "bg-white text-slate-900 shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              Preview Player
            </button>
          </div>

          <button
            type="button"
            onClick={onToggleDiagnostics}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition ${
              errorCount > 0
                ? "border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
                : warningCount > 0
                  ? "border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100"
                  : "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
            }`}
          >
            {errorCount > 0
              ? `${errorCount} error${errorCount === 1 ? "" : "s"}`
              : warningCount > 0
                ? `${warningCount} warning${warningCount === 1 ? "" : "s"}`
                : "Valid PGNA"}
          </button>

          <button
            type="button"
            onClick={onOpenDrafts}
            className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Drafts
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".pgna,.pgn"
            onChange={handleFileSelected}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Import .pgna/.pgn
          </button>

          <button
            type="button"
            onClick={onExportPgn}
            className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Export .pgn
          </button>

          <button
            type="button"
            onClick={onExportPgna}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
          >
            Export .pgna
          </button>

          <button
            type="button"
            onClick={onOpenPublish}
            className="rounded-md border border-sky-300 bg-sky-50 px-2.5 py-1.5 text-xs font-semibold text-sky-800 hover:bg-sky-100"
          >
            Publish…
          </button>

          <a
            href={lectureUrl}
            className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Lecture
          </a>

          <div className="h-5 w-px bg-slate-200" aria-hidden="true" />

          <KibitzAuthMenu
            env={VITE_ENV}
            user={sessionUser}
            onSessionChange={onSessionChange}
            accountHref={accountHref}
            compact
          />
        </div>
      </div>
    </header>
  );
}
