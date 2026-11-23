import { useEffect, useState } from "react";
import { resolveServiceUrl } from "@suite/ui";
import {
  fetchLectureStudies,
  type AuthorSummary,
  type LectureStudy,
  type TagCount,
} from "../api";
import { StudyCard } from "./StudyCard";

const VITE_ENV = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

export interface LectureBrowserProps {
  selectedTag: string | null;
  appliedQuery: string;
  onOpenStudy: (studyId: string) => void;
  onOpenAccount: (handle: string) => void;
  onChangeFilterUrl: (tag: string | null, query: string) => void;
}

export function LectureBrowser({
  selectedTag,
  appliedQuery,
  onOpenStudy,
  onOpenAccount,
  onChangeFilterUrl,
}: LectureBrowserProps) {
  const scribeUrl = resolveServiceUrl("scribe", { env: VITE_ENV });

  const [searchInput, setSearchInput] = useState(appliedQuery);
  const [studies, setStudies] = useState<LectureStudy[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [authors, setAuthors] = useState<AuthorSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchLectureStudies({ tag: selectedTag, q: appliedQuery })
      .then((data) => {
        if (cancelled) return;
        setStudies(data.studies);
        setTags(data.tags);
        setAuthors(data.authors);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load lectures.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedTag, appliedQuery]);

  const handleSelectTag = (nextTag: string | null) => {
    const resolved = nextTag === selectedTag ? null : nextTag;
    onChangeFilterUrl(resolved, appliedQuery);
  };

  const handleSubmitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    onChangeFilterUrl(selectedTag, searchInput.trim());
  };

  const handleClearFilters = () => {
    setSearchInput("");
    onChangeFilterUrl(null, "");
  };

  return (
    <div className="space-y-6">
      {/* Intro & Search Banner */}
      <section className="rounded-2xl border border-stone-200/90 bg-white p-6 shadow-2xs">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold tracking-wider text-amber-700 uppercase">
              PGNA v1.0 Lecture Library · Open Preview
            </p>
            <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
              Browse Chess Lectures
            </h1>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
              Watch narrated chess lessons, explore branching lines, and test your candidate moves —
              no sign-in required. Click any coach&apos;s handle to view their tag-organized Lecture
              page.
            </p>
          </div>

          <form onSubmit={handleSubmitSearch} className="flex w-full max-w-sm items-center gap-2">
            <input
              type="search"
              aria-label="Search lectures"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search titles, tags, or @handle…"
              className="w-full rounded-xl border border-stone-300 bg-stone-50/70 px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:bg-white focus:outline-none"
            />
            <button
              type="submit"
              className="shrink-0 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              Search
            </button>
          </form>
        </div>

        {/* Tag Filter Strip */}
        {tags.length > 0 ? (
          <div className="mt-5 border-t border-stone-100 pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
                Tags:
              </span>
              <button
                type="button"
                onClick={() => handleSelectTag(null)}
                className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                  selectedTag === null
                    ? "bg-slate-900 text-white"
                    : "border border-stone-200 bg-stone-50 text-slate-700 hover:bg-stone-100"
                }`}
              >
                All
              </button>
              {tags.map((item) => {
                const active = selectedTag === item.tag;
                return (
                  <button
                    key={item.tag}
                    type="button"
                    onClick={() => handleSelectTag(item.tag)}
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition ${
                      active
                        ? "bg-slate-900 text-white"
                        : "border border-stone-200 bg-stone-50 text-slate-700 hover:border-stone-300 hover:bg-stone-100"
                    }`}
                  >
                    <span>#{item.tag}</span>
                    <span
                      className={`rounded-full px-1.5 py-0.2 text-[10px] ${
                        active ? "bg-white/20 text-white" : "bg-stone-200/80 text-slate-600"
                      }`}
                    >
                      {item.count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* Account Pages Strip */}
        {authors.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
              Accounts:
            </span>
            {authors.map((author) => (
              <button
                key={author.handle}
                type="button"
                onClick={() => onOpenAccount(author.handle)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 transition hover:border-slate-900 hover:bg-stone-50"
              >
                <span className="font-mono">@{author.handle}</span>
                <span className="text-[10px] text-slate-400">({author.count})</span>
              </button>
            ))}
          </div>
        ) : null}
      </section>

      {/* Active filter indicator */}
      {selectedTag || appliedQuery ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-200 bg-sky-50/70 px-4 py-2.5 text-xs text-sky-950">
          <div className="flex flex-wrap items-center gap-2">
            <span>Showing lectures</span>
            {selectedTag ? (
              <span className="rounded-full bg-slate-900 px-2.5 py-0.5 font-semibold text-white">
                #{selectedTag}
              </span>
            ) : null}
            {appliedQuery ? (
              <span>
                matching <strong>&ldquo;{appliedQuery}&rdquo;</strong>
              </span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={handleClearFilters}
            className="font-semibold text-sky-800 hover:underline"
          >
            Clear filters
          </button>
        </div>
      ) : null}

      {/* Error State */}
      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"
        >
          {error}
        </div>
      ) : null}

      {/* Loading / Grid / Empty */}
      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((n) => (
            <div
              key={n}
              className="h-44 animate-pulse rounded-2xl border border-stone-200 bg-white p-5"
            >
              <div className="h-5 w-2/3 rounded bg-stone-200" />
              <div className="mt-3 h-3 w-1/3 rounded bg-stone-100" />
              <div className="mt-4 h-3 w-full rounded bg-stone-100" />
              <div className="mt-2 h-3 w-5/6 rounded bg-stone-100" />
            </div>
          ))}
        </div>
      ) : studies.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
          <h2 className="text-base font-semibold text-slate-900">No lectures found</h2>
          <p className="mt-1.5 text-sm text-slate-500">
            {selectedTag || appliedQuery
              ? "Try clearing your search or tag filter."
              : "Publish your first tagged PGNA study from Scribe to see it here."}
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            {selectedTag || appliedQuery ? (
              <button
                type="button"
                onClick={handleClearFilters}
                className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-stone-50"
              >
                Reset Filters
              </button>
            ) : null}
            <a
              href={scribeUrl}
              className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
            >
              Author in Scribe →
            </a>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {studies.map((study) => (
            <StudyCard
              key={study.id}
              study={study}
              onOpenStudy={onOpenStudy}
              onSelectAuthor={onOpenAccount}
              onSelectTag={(tag) => handleSelectTag(tag)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
