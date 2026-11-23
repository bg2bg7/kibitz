import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import type { PgnaManifest } from "@suite/pgna";
import {
  AccessibleDialog,
  loginWithKibitzId,
  resolveApiUrl,
  resolveServiceUrl,
  type KibitzSessionUser,
} from "@suite/ui";
import {
  MAX_PUBLISH_DESCRIPTION_LENGTH,
  MAX_PUBLISH_TAG_LENGTH,
  MAX_PUBLISH_TAGS,
  MAX_PUBLISH_TITLE_LENGTH,
  SUGGESTED_STUDY_TAGS,
  canRolePublishStudies,
  canRolePublishToProgram,
  fetchAccountExistingTags,
  fetchPublishablePrograms,
  mergePendingTagInput,
  validateKibitzApiBaseUrl,
  validatePublishMetadata,
  type PublishJobState,
  type PublishToKibitzResult,
  type PublishableProgram,
  type StudyVisibility,
} from "./kibitzPublisher";

const VITE_ENV = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

export interface PublishSubmitInput {
  kibitzApiBaseUrl: string;
  visibility: StudyVisibility;
  programId: string | null;
  tags: string[];
  title: string;
  description: string;
}

export interface PublishModalProps {
  open: boolean;
  manifest: PgnaManifest;
  sessionUser: KibitzSessionUser | null;
  publishState: PublishJobState;
  onSessionChange: (user: KibitzSessionUser | null) => void;
  onStartPublish: (input: PublishSubmitInput) => Promise<PublishToKibitzResult>;
  onResetPublishResult: () => void;
  onClose: () => void;
  onExportLocalPgna: () => void;
}

/**
 * Isolated optional publishing modal inside apps/scribe/src/publish/**.
 * Uses the active Kibitz ID session cookie (with inline sign-in if logged out) and prompts the
 * author for tags before publishing to Lecture. Pending/result publish state lives outside the
 * dialog in App.tsx so dismissing and reopening preserves in-flight status and completed results.
 * Local `.pgna` export remains completely account-free.
 */
export function PublishModal(props: PublishModalProps) {
  if (!props.open) return null;
  return <PublishModalContent {...props} />;
}

function PublishModalContent({
  manifest,
  sessionUser,
  publishState,
  onSessionChange,
  onStartPublish,
  onResetPublishResult,
  onClose,
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
  const [programsQuery, setProgramsQuery] = useState<{
    key: string;
    programs: PublishableProgram[];
  } | null>(null);
  const [selectedProgramId, setSelectedProgramId] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [tagError, setTagError] = useState<string | null>(null);
  const [fetchedExistingTags, setFetchedExistingTags] = useState<string[]>([]);

  // Inline sign-in state when not yet logged in
  const [loginHandle, setLoginHandle] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const isBusy = publishState.status === "publishing";
  const result = publishState.result;

  const urlValidation = useMemo(() => validateKibitzApiBaseUrl(apiUrl), [apiUrl]);
  const hasPublishRole = sessionUser ? canRolePublishStudies(sessionUser.role) : false;
  const canPublishToProgram = sessionUser ? canRolePublishToProgram(sessionUser.role) : false;
  const programsRequestKey =
    sessionUser && hasPublishRole && urlValidation.ok
      ? `${sessionUser.sub}:${urlValidation.normalizedUrl}`
      : null;

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

  useEffect(() => {
    if (!programsRequestKey) {
      return;
    }
    let cancelled = false;
    void fetchPublishablePrograms(apiUrl).then((programs) => {
      if (cancelled) {
        return;
      }
      setProgramsQuery({ key: programsRequestKey, programs });
      setSelectedProgramId((prev) => {
        if (prev && programs.some((program) => program.id === prev)) {
          return prev;
        }
        return programs[0]?.id ?? "";
      });
    });
    return () => {
      cancelled = true;
    };
  }, [apiUrl, programsRequestKey]);

  const existingTags = sessionUser ? fetchedExistingTags : [];
  const publishablePrograms =
    programsRequestKey && programsQuery?.key === programsRequestKey ? programsQuery.programs : [];
  const programsLoading = Boolean(programsRequestKey && programsQuery?.key !== programsRequestKey);
  const effectiveSelectedProgramId =
    canPublishToProgram && publishablePrograms.some((program) => program.id === selectedProgramId)
      ? selectedProgramId
      : canPublishToProgram
        ? (publishablePrograms[0]?.id ?? "")
        : "";

  const effectiveTitle = title.trim() || manifest.title || "";
  const trimmedTitleLength = title.trim().length;
  const titleError =
    effectiveTitle.trim().length > MAX_PUBLISH_TITLE_LENGTH
      ? `Study title must be at most ${MAX_PUBLISH_TITLE_LENGTH} characters.`
      : null;

  const descriptionLength = description.length;
  const descriptionError =
    descriptionLength > MAX_PUBLISH_DESCRIPTION_LENGTH
      ? `Study description must be at most ${MAX_PUBLISH_DESCRIPTION_LENGTH} characters.`
      : null;

  const pendingTagMerge = useMemo(
    () => mergePendingTagInput(tags, tagInput),
    [tags, tagInput],
  );

  const pendingTagError = useMemo(() => {
    if (pendingTagMerge.invalid.length > 0) {
      return `Invalid tag(s): ${pendingTagMerge.invalid.join(", ")}. Use 1–${MAX_PUBLISH_TAG_LENGTH} letters, numbers, spaces, hyphens, or underscores.`;
    }
    if (pendingTagMerge.overflow.length > 0) {
      return `You can attach at most ${MAX_PUBLISH_TAGS} tags per PGNA study (overflow: ${pendingTagMerge.overflow.join(", ")}).`;
    }
    return null;
  }, [pendingTagMerge]);

  const displayedTagError = pendingTagError ?? tagError;
  const totalUniqueTagCount = pendingTagMerge.tags.length + pendingTagMerge.overflow.length;

  const metadataCheck = useMemo(
    () =>
      validatePublishMetadata({
        title: effectiveTitle,
        description,
        tags: pendingTagMerge.tags,
      }),
    [effectiveTitle, description, pendingTagMerge.tags],
  );

  const hasMetadataValidationError = Boolean(
    titleError || descriptionError || pendingTagError || !metadataCheck.ok,
  );

  const hasValidProgramSelection =
    visibility !== "program" ||
    (canPublishToProgram && Boolean(effectiveSelectedProgramId.trim()));

  const canPublish =
    !isBusy &&
    Boolean(sessionUser) &&
    hasPublishRole &&
    urlValidation.ok &&
    hasValidProgramSelection &&
    !hasMetadataValidationError;

  const addTag = (raw: string): boolean => {
    const trimmed = raw.trim();
    if (!trimmed) return false;
    const merged = mergePendingTagInput(tags, trimmed);
    if (merged.invalid.length > 0) {
      setTagError(
        `"${trimmed}" is not a valid tag. Use 1–${MAX_PUBLISH_TAG_LENGTH} letters, numbers, spaces, hyphens, or underscores.`,
      );
      return false;
    }
    if (merged.overflow.length > 0) {
      setTagError(`You can attach at most ${MAX_PUBLISH_TAGS} tags per PGNA study.`);
      return false;
    }
    setTagError(null);
    setTags(merged.tags);
    return true;
  };

  const commitTagInput = () => {
    if (!tagInput.trim()) return;
    const merged = mergePendingTagInput(tags, tagInput);
    if (merged.invalid.length > 0) {
      setTagError(
        `Invalid tag(s): ${merged.invalid.join(", ")}. Use 1–${MAX_PUBLISH_TAG_LENGTH} letters, numbers, spaces, hyphens, or underscores.`,
      );
      return;
    }
    if (merged.overflow.length > 0) {
      setTagError(
        `You can attach at most ${MAX_PUBLISH_TAGS} tags per PGNA study (overflow: ${merged.overflow.join(", ")}).`,
      );
      return;
    }
    setTags(merged.tags);
    setTagInput("");
    setTagError(null);
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

  const sessionExpiredError =
    result && !result.published && result.statusCode === 401
      ? "Your Kibitz ID session expired or is no longer valid. Please sign in again to publish."
      : null;
  const displayedLoginError = loginError ?? sessionExpiredError;

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
    if (sessionExpiredError) {
      onResetPublishResult();
    }
    onSessionChange(loginRes.user);
  };

  const handlePublish = async () => {
    if (!sessionUser || isBusy) {
      return;
    }

    const merged = mergePendingTagInput(tags, tagInput);
    if (merged.invalid.length > 0) {
      setTagError(
        `Invalid tag(s): ${merged.invalid.join(", ")}. Use 1–${MAX_PUBLISH_TAG_LENGTH} letters, numbers, spaces, hyphens, or underscores.`,
      );
      return;
    }
    if (merged.overflow.length > 0) {
      setTagError(
        `You can attach at most ${MAX_PUBLISH_TAGS} tags per PGNA study (overflow: ${merged.overflow.join(", ")}).`,
      );
      return;
    }

    const resolvedTitle = title.trim() || manifest.title || "Untitled PGNA Study";
    const validated = validatePublishMetadata({
      title: resolvedTitle,
      description,
      tags: merged.tags,
    });
    if (!validated.ok) {
      return;
    }

    if (tagInput.trim()) {
      setTags(merged.tags);
      setTagInput("");
      setTagError(null);
    }

    await onStartPublish({
      kibitzApiBaseUrl: apiUrl,
      visibility,
      programId: visibility === "program" ? effectiveSelectedProgramId : null,
      tags: validated.tags,
      title: validated.title,
      description: validated.description,
    });
  };

  const availableSuggestions = SUGGESTED_STUDY_TAGS.filter((t) => !tags.includes(t));
  const availableExisting = existingTags.filter(
    (t) => !tags.includes(t) && !(SUGGESTED_STUDY_TAGS as readonly string[]).includes(t),
  );
  const currentHref =
    typeof window !== "undefined" ? window.location.href : resolveServiceUrl("scribe", { env: VITE_ENV });
  const registerUrl = `${idWebUrl}/?mode=register&returnTo=${encodeURIComponent(currentHref)}`;

  return (
    <AccessibleDialog
      open={true}
      onClose={onClose}
      ariaLabelledBy="scribe-publish-dialog-title"
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/45 p-4 backdrop-blur-xs"
      panelClassName="my-auto w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-xl"
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

            {displayedLoginError ? (
              <div
                role="alert"
                className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800"
              >
                {displayedLoginError}
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
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-700">Study Title</span>
                    <span
                      className={`text-[11px] ${
                        titleError ? "font-semibold text-rose-700" : "text-slate-500"
                      }`}
                    >
                      {trimmedTitleLength}/{MAX_PUBLISH_TITLE_LENGTH}
                    </span>
                  </div>
                  <input
                    type="text"
                    value={title}
                    disabled={isBusy}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Untitled PGNA Study"
                    aria-invalid={Boolean(titleError)}
                    className={`mt-1 w-full rounded-md border px-2.5 py-1.5 text-xs text-slate-900 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500 ${
                      titleError
                        ? "border-rose-400 focus:border-rose-600"
                        : "border-slate-300 focus:border-sky-600"
                    }`}
                  />
                  {titleError ? (
                    <p role="alert" className="mt-1 text-[11px] font-medium text-rose-700">
                      {titleError}
                    </p>
                  ) : null}
                </label>

                <label className="block">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-700">Description</span>
                    <span
                      className={`text-[11px] ${
                        descriptionError ? "font-semibold text-rose-700" : "text-slate-500"
                      }`}
                    >
                      {descriptionLength}/{MAX_PUBLISH_DESCRIPTION_LENGTH}
                    </span>
                  </div>
                  <textarea
                    rows={2}
                    value={description}
                    disabled={isBusy}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Optional short summary shown on Lecture cards…"
                    aria-invalid={Boolean(descriptionError)}
                    className={`mt-1 w-full rounded-md border px-2.5 py-1.5 text-xs text-slate-900 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500 ${
                      descriptionError
                        ? "border-rose-400 focus:border-rose-600"
                        : "border-slate-300 focus:border-sky-600"
                    }`}
                  />
                  {descriptionError ? (
                    <p role="alert" className="mt-1 text-[11px] font-medium text-rose-700">
                      {descriptionError}
                    </p>
                  ) : null}
                </label>

                {/* Tag picker & chip input */}
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <label htmlFor="publish-tag-input" className="font-semibold text-slate-800">
                      What would you like to tag this PGNA with?
                    </label>
                    <span
                      className={`text-[11px] ${
                        pendingTagMerge.overflow.length > 0
                          ? "font-semibold text-rose-700"
                          : "text-slate-500"
                      }`}
                    >
                      {totalUniqueTagCount}/{MAX_PUBLISH_TAGS}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    Your Lecture page (<code>/@{sessionUser.handle}</code>) groups published studies
                    by these tags.
                  </p>

                  <div
                    className={`mt-2 flex flex-wrap items-center gap-1.5 rounded-lg border bg-white px-2 py-1.5 ${
                      displayedTagError
                        ? "border-rose-400 focus-within:border-rose-600"
                        : "border-slate-300 focus-within:border-sky-600"
                    }`}
                  >
                    {tags.map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center gap-1 rounded-full bg-slate-900 px-2.5 py-0.5 text-[11px] font-medium text-white"
                      >
                        <span>#{tag}</span>
                        <button
                          type="button"
                          disabled={isBusy}
                          aria-label={`Remove tag ${tag}`}
                          onClick={() => removeTag(tag)}
                          className="ml-0.5 rounded-full text-slate-300 hover:text-white disabled:opacity-50"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    <input
                      id="publish-tag-input"
                      type="text"
                      value={tagInput}
                      disabled={isBusy}
                      onChange={(e) => {
                        setTagInput(e.target.value);
                        if (tagError) setTagError(null);
                      }}
                      onKeyDown={handleTagKeyDown}
                      onBlur={commitTagInput}
                      placeholder={
                        tags.length === 0 ? "Type a tag & press Enter (e.g. openings)…" : "Add tag…"
                      }
                      className="min-w-[140px] flex-1 bg-transparent py-0.5 text-xs text-slate-900 outline-none disabled:text-slate-500"
                    />
                  </div>

                  {displayedTagError ? (
                    <p role="alert" className="mt-1.5 text-[11px] font-medium text-rose-700">
                      {displayedTagError}
                    </p>
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
                            disabled={isBusy}
                            onClick={() => addTag(tag)}
                            className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-800 hover:bg-sky-100 disabled:opacity-50"
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
                            disabled={isBusy}
                            onClick={() => addTag(tag)}
                            className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-100 disabled:opacity-50"
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
                    disabled={isBusy}
                    onChange={(e) => setVisibility(e.target.value as StudyVisibility)}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 disabled:bg-slate-50 disabled:text-slate-500"
                  >
                    <option value="public_moderated">Public (visible in Lecture)</option>
                    <option value="coach_students">Linked Students only</option>
                    <option value="program">School / Program</option>
                    <option value="private">Private (only me)</option>
                  </select>
                </label>

                {visibility === "program" ? (
                  !canPublishToProgram ? (
                    <div
                      role="alert"
                      className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-[11px] text-amber-900"
                    >
                      Only <strong>coach</strong> or <strong>admin</strong> accounts may publish to
                      a program. No eligible programs are available for this account.
                    </div>
                  ) : programsLoading ? (
                    <p className="text-[11px] text-slate-500">Loading eligible programs…</p>
                  ) : publishablePrograms.length === 0 ? (
                    <div
                      role="alert"
                      className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-[11px] text-amber-900"
                    >
                      No eligible programs are available for this account. Ask an administrator to
                      assign your account to a program, or choose another visibility option.
                    </div>
                  ) : (
                    <label className="block">
                      <span className="font-semibold text-slate-700">Target Program</span>
                      <select
                        id="publish-program-select"
                        value={effectiveSelectedProgramId}
                        disabled={isBusy}
                        onChange={(e) => setSelectedProgramId(e.target.value)}
                        className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-sky-600 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500"
                      >
                        {publishablePrograms.map((program) => (
                          <option key={program.id} value={program.id}>
                            {program.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )
                ) : null}

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
                        disabled={isBusy}
                        onChange={(e) => setApiUrl(e.target.value)}
                        className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-xs disabled:bg-slate-50 disabled:text-slate-500"
                      />
                      {!urlValidation.ok ? (
                        <p className="mt-1 text-[11px] text-rose-700">{urlValidation.error}</p>
                      ) : null}
                    </label>
                  ) : null}
                </div>
              </>
            )}

            {isBusy ? (
              <div
                role="status"
                aria-live="polite"
                className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-medium text-sky-900"
              >
                Publishing study to Kibitz Lecture… You can close this dialog and reopen it anytime
                to check the result.
              </div>
            ) : null}

            {result && !isBusy ? (
              <div
                className={`rounded-lg border p-3 text-xs ${
                  result.published
                    ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                    : "border-amber-200 bg-amber-50 text-amber-900"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium">{result.message}</p>
                  <button
                    type="button"
                    onClick={onResetPublishResult}
                    className="shrink-0 text-[11px] font-semibold opacity-70 hover:opacity-100"
                  >
                    Dismiss
                  </button>
                </div>
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
              {isBusy ? "Publishing…" : "Validate & Publish"}
            </button>
          ) : null}
        </div>
    </AccessibleDialog>
  );
}
