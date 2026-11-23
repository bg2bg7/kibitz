import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { AccessibleDialog, resolveServiceUrl, type KibitzSessionUser } from "@suite/ui";
import {
  deleteStudyById,
  fetchAccountLecturePage,
  fetchPublishablePrograms,
  updateStudyMetadata,
  type AccountLectureResponse,
  type LectureStudy,
  type PublishableProgram,
  type StudyVisibility,
} from "../api";
import { StudyCard } from "./StudyCard";

const VITE_ENV = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

export interface AccountLecturePageProps {
  handle: string;
  sessionUser: KibitzSessionUser | null;
  onBackToBrowser: () => void;
  onOpenStudy: (studyId: string) => void;
}

export function AccountLecturePage({
  handle,
  sessionUser,
  onBackToBrowser,
  onOpenStudy,
}: AccountLecturePageProps) {
  const scribeUrl = resolveServiceUrl("scribe", { env: VITE_ENV });

  const [data, setData] = useState<AccountLectureResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | "__all__" | "__untagged__">("__all__");

  // Inline tag & visibility editor for study owners / admins
  const [editingStudy, setEditingStudy] = useState<LectureStudy | null>(null);
  const [editTags, setEditTags] = useState<string[]>([]);
  const [editTagInput, setEditTagInput] = useState("");
  const [editVisibility, setEditVisibility] = useState<StudyVisibility>("public_moderated");
  const [editProgramId, setEditProgramId] = useState<string>("");
  const [publishablePrograms, setPublishablePrograms] = useState<PublishableProgram[]>([]);
  const [programsLoading, setProgramsLoading] = useState(false);
  const [programsError, setProgramsError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const loadAccount = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchAccountLecturePage(handle);
      setData(res);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : "Failed to load account Lecture page.");
    } finally {
      setLoading(false);
    }
  }, [handle]);

  useEffect(() => {
    let cancelled = false;
    void fetchAccountLecturePage(handle)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setData(null);
        setError(err instanceof Error ? err.message : "Failed to load account Lecture page.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [handle]);

  const canManage = Boolean(data?.isOwner || sessionUser?.role === "admin");

  useEffect(() => {
    if (!editingStudy) return;
    let cancelled = false;
    void fetchPublishablePrograms()
      .then((programs) => {
        if (cancelled) return;
        setPublishablePrograms(programs);
        setProgramsError(null);
        setEditProgramId((current) => {
          if (current && programs.some((p) => p.id === current)) {
            return current;
          }
          return programs[0]?.id ?? "";
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setPublishablePrograms([]);
        setEditProgramId("");
        setProgramsError(err instanceof Error ? err.message : "Failed to load eligible programs.");
      })
      .finally(() => {
        if (!cancelled) setProgramsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editingStudy]);

  const openTagEditor = (study: LectureStudy) => {
    setEditingStudy(study);
    setEditTags([...study.tags]);
    setEditTagInput("");
    setEditVisibility(study.visibility);
    setEditProgramId(study.programId ?? "");
    setEditError(null);
    setProgramsLoading(true);
    setProgramsError(null);
  };

  const commitEditTagInput = () => {
    const raw = editTagInput.trim();
    if (!raw) return;
    const parts = raw
      .split(",")
      .map((p) => p.trim().replace(/\s+/g, " ").toLowerCase())
      .filter(Boolean);
    setEditTags((prev) => {
      const next = [...prev];
      for (const p of parts) {
        if (!next.includes(p) && next.length < 12) {
          next.push(p);
        }
      }
      return next;
    });
    setEditTagInput("");
  };

  const handleEditTagKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitEditTagInput();
    } else if (e.key === "Backspace" && editTagInput === "" && editTags.length > 0) {
      setEditTags((prev) => prev.slice(0, -1));
    }
  };

  const handleSaveEdit = async () => {
    if (!editingStudy) return;
    if (editVisibility === "program" && !editProgramId) {
      setEditError("Select an eligible program before saving with School / Program visibility.");
      return;
    }

    let finalTags = [...editTags];
    if (editTagInput.trim()) {
      const extra = editTagInput
        .split(",")
        .map((p) => p.trim().replace(/\s+/g, " ").toLowerCase())
        .filter(Boolean);
      for (const t of extra) {
        if (!finalTags.includes(t) && finalTags.length < 12) {
          finalTags = [...finalTags, t];
        }
      }
    }

    setEditBusy(true);
    setEditError(null);
    try {
      await updateStudyMetadata(editingStudy.id, {
        tags: finalTags,
        visibility: editVisibility,
        programId: editVisibility === "program" ? editProgramId : null,
      });
      setEditingStudy(null);
      await loadAccount();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to save tags.");
    } finally {
      setEditBusy(false);
    }
  };

  const handleDelete = async (study: LectureStudy) => {
    const confirmed =
      typeof window === "undefined"
        ? true
        : window.confirm(`Delete "${study.title}" from Lecture? This cannot be undone.`);
    if (!confirmed) return;
    try {
      await deleteStudyById(study.id);
      await loadAccount();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete study.");
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-32 animate-pulse rounded-2xl border border-stone-200 bg-white p-6" />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-40 animate-pulse rounded-2xl border border-stone-200 bg-white" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-2xl border border-stone-200 bg-white p-8 text-center">
        <h1 className="text-xl font-bold text-slate-900">Account Not Found</h1>
        <p className="mt-2 text-sm text-slate-600">
          {error ?? `We couldn't find a public Lecture page for @${handle}.`}
        </p>
        <button
          type="button"
          onClick={onBackToBrowser}
          className="mt-5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
        >
          ← Back to All Lectures
        </button>
      </div>
    );
  }

  const visibleGroups =
    activeTag === "__all__"
      ? data.tagGroups
      : activeTag === "__untagged__"
        ? []
        : data.tagGroups.filter((g) => g.tag === activeTag);

  const showUntagged =
    (activeTag === "__all__" || activeTag === "__untagged__") && data.untagged.length > 0;

  return (
    <div className="space-y-6">
      {/* Account Header */}
      <section className="rounded-2xl border border-stone-200/90 bg-white p-6 shadow-2xs">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <button
              type="button"
              onClick={onBackToBrowser}
              className="text-xs font-medium text-slate-500 hover:text-slate-900 hover:underline"
            >
              ← All Lectures
            </button>
            <div className="mt-2 flex flex-wrap items-center gap-2.5">
              <h1 className="font-mono text-2xl font-bold tracking-tight text-slate-950">
                @{data.account.handle}
              </h1>
              <span className="rounded-md bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-amber-300 uppercase">
                {data.account.role}
              </span>
              {data.isOwner ? (
                <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-800">
                  Your Lecture Page
                </span>
              ) : null}
            </div>
            <p className="mt-1.5 text-sm text-slate-600">
              {data.studies.length} published lecture{data.studies.length === 1 ? "" : "s"} organized
              across {data.tagGroups.length} tag{data.tagGroups.length === 1 ? "" : "s"}.
            </p>
          </div>

          {data.isOwner ? (
            <a
              href={scribeUrl}
              className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-slate-800"
            >
              Author &amp; Publish in Scribe <span aria-hidden="true" className="text-amber-300">→</span>
            </a>
          ) : null}
        </div>

        {/* Tag Navigation Bar */}
        {data.studies.length > 0 ? (
          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-stone-100 pt-4">
            <span className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
              Organized by Tag:
            </span>
            <button
              type="button"
              onClick={() => setActiveTag("__all__")}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                activeTag === "__all__"
                  ? "bg-slate-900 text-white"
                  : "border border-stone-200 bg-stone-50 text-slate-700 hover:bg-stone-100"
              }`}
            >
              All Tags ({data.studies.length})
            </button>
            {data.tagGroups.map((group) => {
              const isSelected = activeTag === group.tag;
              return (
                <button
                  key={group.tag}
                  type="button"
                  onClick={() => setActiveTag(isSelected ? "__all__" : group.tag)}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition ${
                    isSelected
                      ? "bg-slate-900 text-white"
                      : "border border-stone-200 bg-stone-50 text-slate-700 hover:border-stone-300 hover:bg-stone-100"
                  }`}
                >
                  <span>#{group.tag}</span>
                  <span
                    className={`rounded-full px-1.5 text-[10px] ${
                      isSelected ? "bg-white/20 text-white" : "bg-stone-200/80 text-slate-600"
                    }`}
                  >
                    {group.count}
                  </span>
                </button>
              );
            })}
            {data.untagged.length > 0 ? (
              <button
                type="button"
                onClick={() =>
                  setActiveTag(activeTag === "__untagged__" ? "__all__" : "__untagged__")
                }
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition ${
                  activeTag === "__untagged__"
                    ? "bg-slate-900 text-white"
                    : "border border-stone-200 bg-stone-50 text-slate-600 hover:bg-stone-100"
                }`}
              >
                <span>Untagged</span>
                <span className="rounded-full bg-stone-200/80 px-1.5 text-[10px] text-slate-600">
                  {data.untagged.length}
                </span>
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* Empty State */}
      {data.studies.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
          <h2 className="text-base font-semibold text-slate-900">No published lectures yet</h2>
          <p className="mt-1.5 text-sm text-slate-500">
            {data.isOwner
              ? "Open Scribe, author a PGNA lesson, and choose tags when publishing — your Lecture page will automatically organize them here."
              : `@${data.account.handle} hasn't published any public PGNA lectures yet.`}
          </p>
          {data.isOwner ? (
            <a
              href={scribeUrl}
              className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
            >
              Launch Scribe →
            </a>
          ) : null}
        </div>
      ) : (
        <div className="space-y-8">
          {/* One section per tag */}
          {visibleGroups.map((group) => (
            <section key={group.tag} aria-labelledby={`tag-heading-${group.tag}`}>
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <h2
                    id={`tag-heading-${group.tag}`}
                    className="text-lg font-bold tracking-tight text-slate-950"
                  >
                    #{group.tag}
                  </h2>
                  <span className="rounded-full bg-stone-200/80 px-2.5 py-0.5 text-xs font-semibold text-slate-700">
                    {group.count} lecture{group.count === 1 ? "" : "s"}
                  </span>
                </div>
                {activeTag !== "__all__" ? (
                  <button
                    type="button"
                    onClick={() => setActiveTag("__all__")}
                    className="text-xs font-medium text-sky-700 hover:underline"
                  >
                    Show all tag sections
                  </button>
                ) : null}
              </div>

              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {group.studies.map((study) => (
                  <StudyCard
                    key={`${group.tag}-${study.id}`}
                    study={study}
                    showAuthor={false}
                    onOpenStudy={onOpenStudy}
                    onSelectAuthor={() => undefined}
                    onSelectTag={(tag) => setActiveTag(tag)}
                    {...(canManage
                      ? {
                          onEditStudy: openTagEditor,
                          onDeleteStudy: (s) => void handleDelete(s),
                        }
                      : {})}
                  />
                ))}
              </div>
            </section>
          ))}

          {/* Untagged Section */}
          {showUntagged ? (
            <section aria-labelledby="tag-heading-untagged">
              <div className="mb-3 flex items-center gap-2.5">
                <h2
                  id="tag-heading-untagged"
                  className="text-lg font-bold tracking-tight text-slate-700"
                >
                  Untagged
                </h2>
                <span className="rounded-full bg-stone-200/80 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
                  {data.untagged.length} lecture{data.untagged.length === 1 ? "" : "s"}
                </span>
              </div>

              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {data.untagged.map((study) => (
                  <StudyCard
                    key={`untagged-${study.id}`}
                    study={study}
                    showAuthor={false}
                    onOpenStudy={onOpenStudy}
                    onSelectAuthor={() => undefined}
                    onSelectTag={(tag) => setActiveTag(tag)}
                    {...(canManage
                      ? {
                          onEditStudy: openTagEditor,
                          onDeleteStudy: (s) => void handleDelete(s),
                        }
                      : {})}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}

      {/* Owner Tag & Visibility Editor Modal */}
      {editingStudy ? (
        <AccessibleDialog
          open={true}
          onClose={() => setEditingStudy(null)}
          ariaLabelledBy="lecture-edit-study-dialog-title"
          overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-xs"
          panelClassName="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-5 shadow-xl"
        >
            <div className="flex items-start justify-between border-b border-stone-100 pb-3">
              <div>
                <h3
                  id="lecture-edit-study-dialog-title"
                  className="text-base font-semibold text-slate-900"
                >
                  Edit Tags &amp; Visibility
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">{editingStudy.title}</p>
              </div>
              <button
                type="button"
                onClick={() => setEditingStudy(null)}
                className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-stone-100"
              >
                Close
              </button>
            </div>

            <div className="mt-4 space-y-3 text-xs">
              <div>
                <span className="font-semibold text-slate-700">Tags</span>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-2 py-1.5">
                  {editTags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 rounded-full bg-slate-900 px-2.5 py-0.5 text-[11px] font-medium text-white"
                    >
                      #{tag}
                      <button
                        type="button"
                        onClick={() => setEditTags((prev) => prev.filter((t) => t !== tag))}
                        className="text-slate-300 hover:text-white"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    type="text"
                    value={editTagInput}
                    onChange={(e) => setEditTagInput(e.target.value)}
                    onKeyDown={handleEditTagKeyDown}
                    onBlur={commitEditTagInput}
                    placeholder="Add tag & press Enter…"
                    className="min-w-[120px] flex-1 bg-transparent py-0.5 text-xs outline-none"
                  />
                </div>
              </div>

              <label className="block">
                <span className="font-semibold text-slate-700">Visibility</span>
                <select
                  value={editVisibility}
                  onChange={(e) => setEditVisibility(e.target.value as StudyVisibility)}
                  className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-2.5 py-1.5"
                >
                  <option value="public_moderated">Public (visible in Lecture)</option>
                  <option value="coach_students">Linked Students only</option>
                  <option value="program">School / Program</option>
                  <option value="private">Private (only me)</option>
                </select>
              </label>

              {editVisibility === "program" ? (
                <div>
                  {programsLoading ? (
                    <p className="text-slate-500">Loading eligible programs…</p>
                  ) : programsError ? (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                      {programsError}
                    </div>
                  ) : publishablePrograms.length === 0 ? (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                      No eligible programs found. Only admins and coaches assigned to a program may
                      publish School / Program studies.
                    </div>
                  ) : (
                    <label className="block">
                      <span className="font-semibold text-slate-700">Program</span>
                      <select
                        value={editProgramId}
                        onChange={(e) => setEditProgramId(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-2.5 py-1.5"
                      >
                        {publishablePrograms.map((program) => (
                          <option key={program.id} value={program.id}>
                            {program.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              ) : null}

              {editError ? (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">
                  {editError}
                </div>
              ) : null}
            </div>

            <div className="mt-5 flex justify-end gap-2 border-t border-stone-100 pt-3">
              <button
                type="button"
                onClick={() => setEditingStudy(null)}
                className="rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-stone-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  editBusy ||
                  (editVisibility === "program" &&
                    (programsLoading || publishablePrograms.length === 0 || !editProgramId))
                }
                onClick={() => void handleSaveEdit()}
                className="rounded-lg bg-slate-900 px-4 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {editBusy ? "Saving…" : "Save Changes"}
              </button>
            </div>
        </AccessibleDialog>
      ) : null}
    </div>
  );
}
