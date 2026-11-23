import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import type { PgnaManifest } from "@suite/pgna";
import {
  loginWithKibitzId,
  resolveApiUrl,
  resolveServiceUrl,
  type KibitzSessionUser,
} from "@suite/ui";
import {
  MAX_PUBLISH_TAGS,
  SUGGESTED_STUDY_TAGS,
  canRolePublishStudies,
  fetchAccountExistingTags,
  normalizePublishTag,
  publishArchiveToKibitz,
  validateKibitzApiBaseUrl,
  type PublishToKibitzResult,
  type StudyVisibility,
} from "./kibitzPublisher";

const VITE_ENV = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

export interface PublishModalProps {
  open: boolean;
  manifest: PgnaManifest;
  sessionUser: KibitzSessionUser | null;
  onSessionChange: (user: KibitzSessionUser | null) => void;
  onClose: () => void;
  onBuildArchive: () => Promise<Uint8Array>;
  onExportLocalPgna: () => void;
}

/**
 * Isolated optional publishing modal inside apps/scribe/src/publish/**.
 * Uses the active Kibitz ID session cookie (with inline sign-in if logged out) and prompts the
 * author for tags before publishing to Lecture. Local `.pgna` export remains completely account-free.
 */
export function PublishModal(props: PublishModalProps) {
  if (!props.open) return null;
  return <PublishModalContent {...props} />;
}

function PublishModalContent({
  manifest,
  sessionUser,
  onSessionChange,
  onClose,
  onBuildArchive,
  onExportLocalPgna,
}: PublishModalProps) {
  const defaultLectureApiUrl = useMemo(() => resolveApiUrl("lecture", { env: VITE_ENV }), []);
  const lectureWebUrl = useMemo(() => resolveServiceUrl("lecture", { env: VITE_ENV }), []);
  const idWebUrl = useMemo(() => resolveServiceUrl("id", { env: VITE_ENV }), []);

  const [apiUrl, setApiUrl] = useState(defaultLectureApiUrl);
  const [showAdvancedApi, setShowAdvancedApi] = useState(false);
  const [title, setTitle] = useState(manifest.title ?? "");
  const [description, setDescription] = useState(manifest.description ?? "");
  const [visibility, setVisibility] = useState<StudyVisibility>("public_moderated");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [tagError, setTagError] = useState<string | null>(null);
  const [fetchedExistingTags, setFetchedExistingTags] = useState<string[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [result, setResult] = useState<PublishToKibitzResult | null>(null);

  // Inline sign-in state when not yet logged in
  const [loginHandle, setLoginHandle] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionUser) {
      return;
    }
    let cancelled = false;
    void fetchAccountExistingTags(apiUrl, sessionUser.handle).then((fetched) => {
      if (!cancelled) {
        setFetchedExistingTags(fetched);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sessionUser, apiUrl]);

  const existingTags = sessionUser ? fetchedExistingTags : [];
  const urlValidation = useMemo(() => validateKibitzApiBaseUrl(apiUrl), [apiUrl]);

  const hasPublishRole = sessionUser ? canRolePublishStudies(sessionUser.role) : false;
  const canPublish = !isBusy && Boolean(sessionUser) && hasPublishRole && urlValidation.ok;

  const addTag = (raw: string): boolean => {
    const trimmed = raw.trim();
    if (!trimmed) return false;
    const normalized = normalizePublishTag(trimmed);
    if (!normalized) {
      setTagError(
        `"${trimmed}" is not a valid tag. Use 1–32 letters, numbers, spaces, hyphens, or underscores.`,
      );
      return false;
    }
    if (tags.includes(normalized)) {
      setTagError(null);
      return true;
    }
    if (tags.length >= MAX_PUBLISH_TAGS) {
      setTagError(`You can attach up to ${MAX_PUBLISH_TAGS} tags per PGNA study.`);
      return false;
    }
    setTagError(null);
    setTags((prev) => [...prev, normalized]);
    return true;
  };

  const commitTagInput = () => {
    if (!tagInput.trim()) return;
    const parts = tagInput.split(",");
    let allOk = true;
    for (const part of parts) {
      if (part.trim()) {
        if (!addTag(part)) {
          allOk = false;
        }
      }
    }
    if (allOk) {
      setTagInput("");
    }
  };

  const handleTagKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitTagInput();
    } else if (e.key === "Backspace" && tagInput === "" && tags.length > 0) {
      setTags((prev) => prev.slice(0, -1));
      setTagError(null);
    }
  };

  const removeTag = (target: string) => {
    setTags((prev) => prev.filter((t) => t !== target));
    setTagError(null);
  };

  const handleInlineLogin = async (e: FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    setLoginBusy(true);
    const loginRes = await loginWithKibitzId(
      { handle: loginHandle.trim(), password: loginPassword },
      { env: VITE_ENV },
    );
    setLoginBusy(false);

    if (!loginRes.ok) {
      setLoginError(loginRes.error);
      return;
    }

    setLoginPassword("");
    onSessionChange(loginRes.user);
  };

  const handlePublish = async () => {
    if (!sessionUser) {
      setResult({
        published: false,
        message: "Sign in with Kibitz ID before publishing to Lecture.",
      });
      return;
    }

    // Commit any unconfirmed text sitting in the tag input box
    let finalTags = [...tags];
    if (tagInput.trim()) {
      const parts = tagInput.split(",").map((p) => p.trim()).filter(Boolean);
      for (const part of parts) {
        const normalized = normalizePublishTag(part);
        if (!normalized) {
          setTagError(
            `"${part}" is not a valid tag. Use 1–32 letters, numbers, spaces, hyphens, or underscores.`,
          );
          return;
        }
        if (!finalTags.includes(normalized) && finalTags.length < MAX_PUBLISH_TAGS) {
          finalTags = [...finalTags, normalized];
        }
      }
      setTags(finalTags);
      setTagInput("");
      setTagError(null);
    }

    setIsBusy(true);
    setResult(null);
    try {
      const archiveBytes = await onBuildArchive();
      const res = await publishArchiveToKibitz({
        kibitzApiBaseUrl: apiUrl,
        session: sessionUser,
        visibility,
        tags: finalTags,
        title: title.trim() || manifest.title || "Untitled PGNA Study",
        description,
        manifest,
        archiveBytes,
      });
      setResult(res);
    } catch (err) {
      setResult({
        published: false,
        message: err instanceof Error ? err.message : "Failed to compile archive.",
      });
    } finally {
      setIsBusy(false);
    }
  };

  const availableSuggestions = SUGGESTED_STUDY_TAGS.filter((t) => !tags.includes(t));
  const availableExisting = existingTags.filter(
    (t) => !tags.includes(t) && !(SUGGESTED_STUDY_TAGS as readonly string[]).includes(t),
  );
  const currentHref =
    typeof window !== "undefined" ? window.location.href : resolveServiceUrl("scribe", { env: VITE_ENV });
  const registerUrl = `${idWebUrl}/?mode=register&returnTo=${encodeURIComponent(currentHref)}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/45 p-4 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="scribe-publish-dialog-title"
        className="my-auto w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-slate-100 pb-3">
          <div>
            <h2
              id="scribe-publish-dialog-title"
              className="text-base font-semibold text-slate-900"
            >
              Publish to Kibitz Lecture
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Tag your study to organize your Lecture page. Local <code>.pgna</code> export never
              requires an account.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
          >
            Close
          </button>
        </div>

        {!sessionUser ? (
          <div className="mt-4 space-y-4 text-xs">
            <div className="rounded-lg border border-sky-200 bg-sky-50/70 p-3 text-slate-700">
              Sign in with your <strong>Kibitz ID</strong> to publish this PGNA directly to your
              Lecture page. Your session is shared across Scribe, Lecture, and Kibitz.
            </div>

            {loginError ? (
              <div
                role="alert"
                className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800"
              >
                {loginError}
              </div>
            ) : null}

            <form onSubmit={(e) => void handleInlineLogin(e)} className="space-y-3">
              <label className="block">
                <span className="font-semibold text-slate-700">Handle</span>
                <input
                  type="text"
                  autoComplete="username"
                  required
                  value={loginHandle}
                  onChange={(e) => setLoginHandle(e.target.value)}
                  placeholder="e.g. admin or coach_alice"
                  className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs text-slate-900 focus:border-slate-900 focus:outline-none"
                />
              </label>

              <label className="block">
                <span className="font-semibold text-slate-700">Password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs text-slate-900 focus:border-slate-900 focus:outline-none"
                />
              </label>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <a href={registerUrl} className="font-medium text-slate-600 hover:text-slate-900 hover:underline">
                  Have an invite code? Register →
                </a>
                <button
                  type="submit"
                  disabled={loginBusy}
                  className="rounded-md bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  {loginBusy ? "Signing in…" : "Sign In to Publish"}
                </button>
              </div>
            </form>
          </div>
        ) : (
          <div className="mt-4 space-y-3.5 text-xs">
            {/* Active Kibitz ID account summary */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-slate-500">Publishing as</span>
                <span className="font-mono font-semibold text-slate-900">@{sessionUser.handle}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                    hasPublishRole
                      ? "bg-emerald-100 text-emerald-800"
                      : "bg-amber-100 text-amber-800"
                  }`}
                >
                  {sessionUser.role}
                </span>
              </div>
              {hasPublishRole ? (
                <a
                  href={`${lectureWebUrl}/@${encodeURIComponent(sessionUser.handle)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-sky-700 hover:underline"
                >
                  My Lecture Page →
                </a>
              ) : null}
            </div>

            {!hasPublishRole ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
                Only <strong>coach</strong>, <strong>moderator</strong>, or <strong>admin</strong>{" "}
                accounts may publish PGNAs to Kibitz Lecture. You can still download your{" "}
                <code>.pgna</code> file locally below.
              </div>
            ) : (
              <>
                <label className="block">
                  <span className="font-semibold text-slate-700">Study Title</span>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Untitled PGNA Study"
                    className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-900 focus:border-sky-600 focus:outline-none"
                  />
                </label>

                <label className="block">
                  <span className="font-semibold text-slate-700">Description</span>
                  <textarea
                    rows={2}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Optional short summary shown on Lecture cards…"
                    className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-900 focus:border-sky-600 focus:outline-none"
                  />
                </label>

                {/* Tag picker & chip input */}
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <label htmlFor="publish-tag-input" className="font-semibold text-slate-800">
                      What would you like to tag this PGNA with?
                    </label>
                    <span className="text-[11px] text-slate-500">
                      {tags.length}/{MAX_PUBLISH_TAGS}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    Your Lecture page (<code>/@{sessionUser.handle}</code>) groups published studies
                    by these tags.
                  </p>

                  <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2 py-1.5 focus-within:border-sky-600">
                    {tags.map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center gap-1 rounded-full bg-slate-900 px-2.5 py-0.5 text-[11px] font-medium text-white"
                      >
                        <span>#{tag}</span>
                        <button
                          type="button"
                          aria-label={`Remove tag ${tag}`}
                          onClick={() => removeTag(tag)}
                          className="ml-0.5 rounded-full text-slate-300 hover:text-white"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    <input
                      id="publish-tag-input"
                      type="text"
                      value={tagInput}
                      onChange={(e) => {
                        setTagInput(e.target.value);
                        if (tagError) setTagError(null);
                      }}
                      onKeyDown={handleTagKeyDown}
                      onBlur={commitTagInput}
                      placeholder={
                        tags.length === 0 ? "Type a tag & press Enter (e.g. openings)…" : "Add tag…"
                      }
                      className="min-w-[140px] flex-1 bg-transparent py-0.5 text-xs text-slate-900 outline-none"
                    />
                  </div>

                  {tagError ? (
                    <p className="mt-1.5 text-[11px] font-medium text-rose-700">{tagError}</p>
                  ) : null}

                  {availableExisting.length > 0 ? (
                    <div className="mt-2.5">
                      <span className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase">
                        Your existing tags
                      </span>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {availableExisting.map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => addTag(tag)}
                            className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-800 hover:bg-sky-100"
                          >
                            + #{tag}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {availableSuggestions.length > 0 ? (
                    <div className="mt-2.5">
                      <span className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase">
                        Suggested tags
                      </span>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {availableSuggestions.map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => addTag(tag)}
                            className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-100"
                          >
                            + #{tag}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>

                <label className="block">
                  <span className="font-semibold text-slate-700">Visibility</span>
                  <select
                    value={visibility}
                    onChange={(e) => setVisibility(e.target.value as StudyVisibility)}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5"
                  >
                    <option value="public_moderated">Public (visible in Lecture)</option>
                    <option value="coach_students">Linked Students only</option>
                    <option value="program">School / Program</option>
                    <option value="private">Private (only me)</option>
                  </select>
                </label>

                <div>
                  <button
                    type="button"
                    onClick={() => setShowAdvancedApi((v) => !v)}
                    className="text-[11px] font-medium text-slate-500 hover:text-slate-800"
                  >
                    {showAdvancedApi ? "▾ Hide Lecture API server" : "▸ Advanced: Lecture API server"}
                  </button>
                  {showAdvancedApi ? (
                    <label className="mt-1.5 block">
                      <input
                        type="url"
                        value={apiUrl}
                        onChange={(e) => setApiUrl(e.target.value)}
                        className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-xs"
                      />
                      {!urlValidation.ok ? (
                        <p className="mt-1 text-[11px] text-rose-700">{urlValidation.error}</p>
                      ) : null}
                    </label>
                  ) : null}
                </div>
              </>
            )}

            {result ? (
              <div
                className={`rounded-lg border p-3 text-xs ${
                  result.published
                    ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                    : "border-amber-200 bg-amber-50 text-amber-900"
                }`}
              >
                <p className="font-medium">{result.message}</p>
                {result.published && result.studyId ? (
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <a
                      href={`${lectureWebUrl}/studies/${encodeURIComponent(result.studyId)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-800"
                    >
                      Open in Lecture Viewer →
                    </a>
                    {result.ownerHandle ? (
                      <a
                        href={`${lectureWebUrl}/@${encodeURIComponent(result.ownerHandle)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] font-semibold text-emerald-800 hover:underline"
                      >
                        View @{result.ownerHandle}&apos;s Lecture Page →
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-4">
          <button
            type="button"
            onClick={onExportLocalPgna}
            className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Download .pgna Locally
          </button>

          {sessionUser ? (
            <button
              type="button"
              disabled={!canPublish}
              onClick={() => void handlePublish()}
              className="rounded-md bg-sky-700 px-4 py-1.5 text-xs font-semibold text-white hover:bg-sky-800 disabled:opacity-50"
            >
              {isBusy ? "Validating & Publishing…" : "Validate & Publish"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
