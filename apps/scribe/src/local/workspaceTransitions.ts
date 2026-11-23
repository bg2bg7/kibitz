import { parsePgnGames, serializePgnGames, type PgnGameDocument } from "@suite/chess-core";
import {
  PgnaPackError,
  compilePgna,
  isValidSubtitleLang,
  packPgnaArchive,
  validatePgnaZip,
  type ClipDefinition,
  type NodeId,
  type UnpackedPgnaArchive,
} from "@suite/pgna";
import {
  generateClipId,
  startMicRecording,
  type ActiveRecordingSession,
  type StartMicRecordingOptions,
} from "./audioStudio";
import type { DraftPersistenceMode, SaveLocalDraftResult } from "./draftStore";
import { createDraftId, normalizeScribeDraft, type ScribeDraft } from "./draftWorkspace";
import { appendNodeToTimeline, indexStudyGames, updateNodeTags } from "./studyTree";

const DEFAULT_MAX_ZIP_ENTRIES = 1000;
const DEFAULT_MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MERGED_SUBTITLE_PATH_RE = /^subtitles\/[^/]+\/timeline\.vtt$/;

// ============================================================================
// SCR-01 · Persistence Status & Unified Workspace Transitions
// ============================================================================

export type SaveStatusState =
  | "idle-demo"
  | "pending"
  | "saving"
  | "saved-indexeddb"
  | "saved-memory"
  | "failed";

export function formatSaveStatus(state: SaveStatusState): string {
  switch (state) {
    case "idle-demo":
      return "Demo loaded · Edit to save";
    case "pending":
      return "Unsaved changes…";
    case "saving":
      return "Saving locally…";
    case "saved-indexeddb":
      return "Saved locally (IndexedDB)";
    case "saved-memory":
      return "Session only (memory — export .pgna to keep)";
    case "failed":
      return "Save failed — export .pgna to keep";
  }
}

export function formatSaveStatusForMode(mode: DraftPersistenceMode): string {
  return formatSaveStatus(mode === "indexeddb" ? "saved-indexeddb" : "saved-memory");
}

export interface WorkspaceTransitionPayload<TMeta = unknown> {
  draft: ScribeDraft;
  dirty?: boolean;
  saveStatusState?: SaveStatusState;
  meta?: TMeta;
}

export type WorkspaceTransitionResult<TMeta = unknown> =
  | { status: "committed"; draft: ScribeDraft; generation: number; meta?: TMeta }
  | { status: "aborted-save-failed"; generation: number }
  | { status: "stale"; generation: number }
  | { status: "empty"; generation: number };

export interface WorkspaceControllerDeps {
  getDraft: () => ScribeDraft;
  setDraft: (nextDraft: ScribeDraft) => void;
  saveDraft: (draft: ScribeDraft) => Promise<SaveLocalDraftResult>;
  getStorageMode: () => DraftPersistenceMode;
  debounceMs?: number;
  onSaveStatus: (statusText: string) => void;
  onAfterSave?: (res: SaveLocalDraftResult) => void | Promise<void>;
  onSaveError?: (error: unknown) => void;
  onCommitWorkspace?: (payload: {
    draft: ScribeDraft;
    dirty: boolean;
    generation: number;
    meta?: unknown;
  }) => void;
}

export interface WorkspaceController {
  isDirty(): boolean;
  getEditRevision(): number;
  getGeneration(): number;
  markDirty(): void;
  clearPendingTimer(): void;
  flushPendingSave(): Promise<boolean>;
  transitionWorkspace<TMeta = unknown>(
    loader: (generation: number) => Promise<WorkspaceTransitionPayload<TMeta> | null> | WorkspaceTransitionPayload<TMeta> | null,
  ): Promise<WorkspaceTransitionResult<TMeta>>;
  commitIfGenerationMatches<TMeta = unknown>(
    expectedGeneration: number,
    payload: WorkspaceTransitionPayload<TMeta>,
  ): boolean;
  dispose(): void;
}

/**
 * Coordinates debounced auto-save, flush-before-switch, monotonic workspace generations,
 * and honest persistence status updates for Scribe.
 */
export function createWorkspaceController(deps: WorkspaceControllerDeps): WorkspaceController {
  const debounceMs = deps.debounceMs ?? 500;
  let dirty = false;
  let editRevision = 0;
  let workspaceGen = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlightSave: Promise<boolean> | null = null;
  let disposed = false;

  const clearPendingTimer = () => {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  };

  const runSave = async (): Promise<boolean> => {
    clearPendingTimer();
    const targetRevision = editRevision;
    const snapshot = deps.getDraft();
    deps.onSaveStatus(formatSaveStatus("saving"));

    const savePromise: Promise<boolean> = (async () => {
      try {
        const res = await deps.saveDraft(snapshot);
        if (!disposed) {
          const sameDraft = deps.getDraft().id === snapshot.id;
          if (sameDraft && editRevision === targetRevision) {
            dirty = false;
            deps.onSaveStatus(formatSaveStatusForMode(res.mode));
          } else if (sameDraft && dirty) {
            deps.onSaveStatus(formatSaveStatus("pending"));
          }
          await deps.onAfterSave?.(res);
        }
        return true;
      } catch (err) {
        if (!disposed && deps.getDraft().id === snapshot.id) {
          dirty = true;
          deps.onSaveStatus(formatSaveStatus("failed"));
          deps.onSaveError?.(err);
        }
        return false;
      }
    })();

    inFlightSave = savePromise;
    void savePromise.finally(() => {
      if (inFlightSave === savePromise) {
        inFlightSave = null;
      }
    });
    return savePromise;
  };

  const flushPendingSave = async (): Promise<boolean> => {
    clearPendingTimer();
    if (inFlightSave) {
      await inFlightSave;
    }
    while (dirty) {
      const ok = await runSave();
      if (!ok) {
        return false;
      }
    }
    return true;
  };

  const scheduleDebouncedSave = () => {
    clearPendingTimer();
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      if (!disposed && dirty) {
        void flushPendingSave();
      }
    }, debounceMs);
  };

  const markDirty = () => {
    editRevision += 1;
    dirty = true;
    deps.onSaveStatus(formatSaveStatus("pending"));
    scheduleDebouncedSave();
  };

  const applyCommittedWorkspace = <TMeta = unknown>(
    payload: WorkspaceTransitionPayload<TMeta>,
    generation: number,
  ) => {
    clearPendingTimer();
    deps.setDraft(payload.draft);
    if (payload.dirty) {
      editRevision += 1;
      dirty = true;
      deps.onSaveStatus(formatSaveStatus(payload.saveStatusState ?? "pending"));
      scheduleDebouncedSave();
    } else {
      dirty = false;
      const statusText = payload.saveStatusState
        ? formatSaveStatus(payload.saveStatusState)
        : formatSaveStatusForMode(deps.getStorageMode());
      deps.onSaveStatus(statusText);
    }
    deps.onCommitWorkspace?.({
      draft: payload.draft,
      dirty: Boolean(payload.dirty),
      generation,
      meta: payload.meta,
    });
  };

  const transitionWorkspace = async <TMeta = unknown>(
    loader: (
      generation: number,
    ) => Promise<WorkspaceTransitionPayload<TMeta> | null> | WorkspaceTransitionPayload<TMeta> | null,
  ): Promise<WorkspaceTransitionResult<TMeta>> => {
    const myGen = ++workspaceGen;
    const flushed = await flushPendingSave();
    if (!flushed) {
      return { status: "aborted-save-failed", generation: myGen };
    }
    if (disposed || workspaceGen !== myGen) {
      return { status: "stale", generation: myGen };
    }

    const payload = await loader(myGen);

    if (disposed || workspaceGen !== myGen) {
      return { status: "stale", generation: myGen };
    }
    if (!payload) {
      return { status: "empty", generation: myGen };
    }

    applyCommittedWorkspace(payload, myGen);
    return {
      status: "committed",
      draft: payload.draft,
      generation: myGen,
      meta: payload.meta,
    };
  };

  const commitIfGenerationMatches = <TMeta = unknown>(
    expectedGeneration: number,
    payload: WorkspaceTransitionPayload<TMeta>,
  ): boolean => {
    if (disposed || workspaceGen !== expectedGeneration || dirty) {
      return false;
    }
    const myGen = ++workspaceGen;
    applyCommittedWorkspace(payload, myGen);
    return true;
  };

  return {
    isDirty: () => dirty,
    getEditRevision: () => editRevision,
    getGeneration: () => workspaceGen,
    markDirty,
    clearPendingTimer,
    flushPendingSave,
    transitionWorkspace,
    commitIfGenerationMatches,
    dispose: () => {
      disposed = true;
      clearPendingTimer();
    },
  };
}

/**
 * Converts an unpacked `.pgna` archive into a normalized `ScribeDraft`, stripping
 * compiler-generated `timeline.vtt` tracks so re-export never duplicates them and
 * guaranteeing `manifest.clips` is always an initialized record.
 */
export function buildImportedPgnaDraft(
  unpacked: UnpackedPgnaArchive,
  id: string = createDraftId(),
  now: string = new Date().toISOString(),
): ScribeDraft {
  const referencedSubPaths = new Set<string>();
  for (const clip of Object.values(unpacked.manifest.clips ?? {})) {
    for (const sp of Object.values(clip.subtitles ?? {})) {
      referencedSubPaths.add(sp);
    }
  }
  const mergedSubPaths = new Set<string>(Object.values(unpacked.timeline.mergedSubtitles ?? {}));
  const perClipSubtitles: Record<string, string> = {};
  for (const [subPath, vtt] of Object.entries(unpacked.subtitlesByPath)) {
    if (
      referencedSubPaths.has(subPath) ||
      (!mergedSubPaths.has(subPath) && !MERGED_SUBTITLE_PATH_RE.test(subPath))
    ) {
      perClipSubtitles[subPath] = vtt;
    }
  }

  const normalized = normalizeScribeDraft({
    id,
    manifest: unpacked.manifest,
    pgnText: unpacked.pgnText,
    audioByPath: unpacked.audioByPath,
    subtitlesByPath: perClipSubtitles,
    updatedAt: now,
  });

  if (!normalized) {
    throw new Error("Imported PGNA archive could not be normalized into a valid draft.");
  }

  return normalized;
}

// ============================================================================
// SCR-02 · Live-State Audio Attachment & Copy-on-Write / Ref-Counted Subtitles
// ============================================================================

export interface AudioClipAttachmentTemplate {
  mimeType: string;
  extension: string;
  durationMs: number;
  trimStartMs?: number;
  trimEndMs?: number;
  label?: string;
  subtitles?: Record<string, string>;
}

export interface ApplyAudioClipAttachmentParams {
  targetDraftId: string;
  nodeId: NodeId;
  /** Existing clip ID to reuse if the target node still references it in live state. */
  requestedClipId?: string | null;
  clipTemplate: AudioClipAttachmentTemplate;
  bytes: Uint8Array;
  now?: string;
}

export interface ApplyAudioClipAttachmentResult {
  draft: ScribeDraft;
  clipId: string;
  clip: ClipDefinition;
}

function parseLiveGames(draft: ScribeDraft): PgnGameDocument[] {
  const parsed = parsePgnGames(draft.pgnText);
  if (parsed.length > 0) return parsed;
  return [
    {
      headers: { Event: draft.manifest.title || "Chapter 1", Result: "*" },
      rootComments: [],
      rootMoves: [],
      result: "*",
    },
  ];
}

/**
 * Pure, draft-identity-guarded audio clip attachment applied against live `prevDraft`.
 * - Returns `null` if `prevDraft.id !== params.targetDraftId` or `params.nodeId` does not exist.
 * - Parses `prevDraft.pgnText` fresh so intervening PGN/comment edits are never overwritten.
 * - Allocates clip ID against live `prevDraft.manifest.clips` unless reusing a still-attached clip.
 * - Reference-counts old audio paths before deleting replaced binary entries.
 */
export function applyAudioClipAttachment(
  prevDraft: ScribeDraft,
  params: ApplyAudioClipAttachmentParams,
): ApplyAudioClipAttachmentResult | null {
  if (prevDraft.id !== params.targetDraftId) {
    return null;
  }

  const games = parseLiveGames(prevDraft);
  const studyIndex = indexStudyGames(games);
  const targetNode = studyIndex.nodesById[params.nodeId];
  if (!targetNode) {
    return null;
  }

  const liveClips = prevDraft.manifest.clips ?? {};
  const liveNodeClipId = targetNode.tags.audioClipId;
  const clipId =
    liveNodeClipId && params.requestedClipId && liveNodeClipId === params.requestedClipId
      ? liveNodeClipId
      : generateClipId(Object.keys(liveClips));

  const clipPath = `audio/${clipId}.${params.clipTemplate.extension}`;
  const liveSubtitles = liveClips[clipId]?.subtitles;
  const preservedSubtitles = liveSubtitles
    ? { ...liveSubtitles }
    : params.clipTemplate.subtitles
      ? { ...params.clipTemplate.subtitles }
      : undefined;

  const clip: ClipDefinition = {
    id: clipId,
    path: clipPath,
    mimeType: params.clipTemplate.mimeType,
    durationMs: params.clipTemplate.durationMs,
    trimStartMs: params.clipTemplate.trimStartMs ?? 0,
    trimEndMs: params.clipTemplate.trimEndMs ?? params.clipTemplate.durationMs,
    ...(params.clipTemplate.label !== undefined ? { label: params.clipTemplate.label } : {}),
    ...(preservedSubtitles && Object.keys(preservedSubtitles).length > 0
      ? { subtitles: preservedSubtitles }
      : {}),
  };

  const shouldAutoSchedule = targetNode.tags.atTags.length === 0;
  let nextGames = updateNodeTags(games, params.nodeId, (prev) => ({
    ...prev,
    audioClipId: clipId,
    // Clear any stale silent [%dur] so attaching audio never leaves an IGNORED_DUR_TAG warning
    durMs: null,
  }));

  if (shouldAutoSchedule) {
    const liveCompiled = compilePgna({
      manifest: prevDraft.manifest,
      pgnText: prevDraft.pgnText,
      subtitlesByPath: prevDraft.subtitlesByPath,
    });
    const nextTimestampMs =
      liveCompiled.timeline.entries.length > 0
        ? liveCompiled.timeline.totalDurationMs +
          (prevDraft.manifest.compilation?.defaultGapMs ?? 0)
        : 0;
    nextGames = appendNodeToTimeline(nextGames, params.nodeId, undefined, { nextTimestampMs });
  }

  const nextPgn = serializePgnGames(nextGames);
  const now = params.now ?? new Date().toISOString();

  const nextClips: Record<string, ClipDefinition> = {
    ...liveClips,
    [clipId]: clip,
  };
  const nextAudioByPath: Record<string, Uint8Array> = {
    ...prevDraft.audioByPath,
    [clip.path]: params.bytes,
  };

  const oldClip = liveClips[clipId];
  if (oldClip && oldClip.path !== clip.path) {
    const pathStillUsedByOtherClip = Object.entries(nextClips).some(
      ([otherId, otherClip]) => otherId !== clipId && otherClip.path === oldClip.path,
    );
    if (!pathStillUsedByOtherClip) {
      delete nextAudioByPath[oldClip.path];
    }
  }

  const nextDraft: ScribeDraft = {
    ...prevDraft,
    pgnText: nextPgn,
    manifest: {
      ...prevDraft.manifest,
      updatedAt: now,
      clips: nextClips,
    },
    audioByPath: nextAudioByPath,
    updatedAt: now,
  };

  return { draft: nextDraft, clipId, clip };
}

export interface ApplySubtitleUpdateParams {
  targetDraftId?: string;
  clipId: string;
  lang: string;
  vttText: string;
  now?: string;
}

/**
 * Pure, draft-identity-guarded subtitle update with copy-on-write and reference-counted
 * deletion so editing or clearing one clip's caption never mutates or deletes another clip's
 * shared subtitle file.
 */
export function applySubtitleUpdate(
  prevDraft: ScribeDraft,
  params: ApplySubtitleUpdateParams,
): ScribeDraft | null {
  if (params.targetDraftId && prevDraft.id !== params.targetDraftId) {
    return null;
  }

  const trimmedLang = params.lang.trim();
  if (!isValidSubtitleLang(trimmedLang)) {
    return null;
  }

  const liveClips = prevDraft.manifest.clips ?? {};
  const clip = liveClips[params.clipId];
  if (!clip) {
    return null;
  }

  const oldPath = clip.subtitles?.[trimmedLang];

  const isPathReferencedByOther = (candidatePath: string): boolean => {
    for (const [otherClipId, otherClip] of Object.entries(liveClips)) {
      for (const [otherLang, otherSubPath] of Object.entries(otherClip.subtitles ?? {})) {
        if (otherClipId === params.clipId && otherLang === trimmedLang) {
          continue;
        }
        if (otherSubPath === candidatePath) {
          return true;
        }
      }
    }
    return false;
  };

  const allocateDedicatedSubtitlePath = (): string => {
    const base = `subtitles/${trimmedLang}/${params.clipId}.vtt`;
    if (!isPathReferencedByOther(base) && !MERGED_SUBTITLE_PATH_RE.test(base)) {
      return base;
    }
    for (let suffix = 2; suffix < 10000; suffix++) {
      const candidate = `subtitles/${trimmedLang}/${params.clipId}-${suffix}.vtt`;
      if (!isPathReferencedByOther(candidate)) {
        return candidate;
      }
    }
    return `subtitles/${trimmedLang}/${params.clipId}-${Date.now().toString(36)}.vtt`;
  };

  const nextSubtitles = { ...(clip.subtitles ?? {}) };
  const nextSubByPath = { ...prevDraft.subtitlesByPath };

  if (params.vttText.trim() === "") {
    delete nextSubtitles[trimmedLang];
    if (oldPath && !isPathReferencedByOther(oldPath)) {
      delete nextSubByPath[oldPath];
    }
  } else {
    const canReuseOldPath =
      typeof oldPath === "string" &&
      oldPath.length > 0 &&
      !MERGED_SUBTITLE_PATH_RE.test(oldPath) &&
      !isPathReferencedByOther(oldPath);
    const targetPath = canReuseOldPath ? oldPath : allocateDedicatedSubtitlePath();
    nextSubtitles[trimmedLang] = targetPath;
    nextSubByPath[targetPath] = params.vttText;
    if (oldPath && oldPath !== targetPath && !isPathReferencedByOther(oldPath)) {
      delete nextSubByPath[oldPath];
    }
  }

  const nextClip: ClipDefinition = { ...clip };
  if (Object.keys(nextSubtitles).length > 0) {
    nextClip.subtitles = nextSubtitles;
  } else {
    delete nextClip.subtitles;
  }

  const now = params.now ?? new Date().toISOString();
  return {
    ...prevDraft,
    manifest: {
      ...prevDraft.manifest,
      updatedAt: now,
      clips: {
        ...liveClips,
        [params.clipId]: nextClip,
      },
    },
    subtitlesByPath: nextSubByPath,
    updatedAt: now,
  };
}

// ============================================================================
// SCR-03 · Microphone Recording Guard & Interruption Lifecycle Coordinator
// ============================================================================

export interface MicRecordingTarget {
  draftId: string;
  nodeId: NodeId;
  san: string | null;
  attachedClipId: string | null;
  attachedSubtitles?: Record<string, string>;
}

export interface MicRecordingStateAdapter {
  isMounted(): boolean;
  getDraftId(): string;
  getIsAcquiring(): boolean;
  setIsAcquiring(value: boolean): void;
  getAbortController(): AbortController | null;
  setAbortController(controller: AbortController | null): void;
  getRecorder(): ActiveRecordingSession | null;
  setRecorder(session: ActiveRecordingSession | null): void;
  getTarget(): MicRecordingTarget | null;
  setTarget(target: MicRecordingTarget | null): void;
  getTimer(): ReturnType<typeof setInterval> | null;
  setTimer(timer: ReturnType<typeof setInterval> | null): void;
  setIsRecording(value: boolean): void;
  setRecordingNodeId(nodeId: NodeId | null): void;
  setRecordMs(ms: number): void;
  setMicLevel(level: number): void;
  setAudioError(message: string | null): void;
  stopAudition(): void;
  onAttachAudioClip(params: {
    targetDraftId: string;
    nodeId: NodeId;
    requestedClipId: string | null;
    clipTemplate: AudioClipAttachmentTemplate;
    bytes: Uint8Array;
    peaks: number[];
  }): void;
  startMic?: (options?: StartMicRecordingOptions) => Promise<ActiveRecordingSession>;
}

export function clearMicRecordingTimer(adapter: Pick<MicRecordingStateAdapter, "getTimer" | "setTimer">): void {
  const timer = adapter.getTimer();
  if (timer !== null) {
    clearInterval(timer);
    adapter.setTimer(null);
  }
}

export async function runStartMicRecording(
  adapter: MicRecordingStateAdapter,
  target: MicRecordingTarget,
): Promise<void> {
  if (adapter.getIsAcquiring() || adapter.getRecorder() !== null) {
    return;
  }

  const originDraftId = target.draftId;
  adapter.setAudioError(null);
  adapter.stopAudition();
  adapter.setIsAcquiring(true);

  const abortController = new AbortController();
  adapter.setAbortController(abortController);

  const startFn = adapter.startMic ?? startMicRecording;

  try {
    const session = await startFn({
      signal: abortController.signal,
      onInterrupted: (reason) => {
        clearMicRecordingTimer(adapter);
        adapter.setRecorder(null);
        adapter.setTarget(null);
        if (adapter.getAbortController() === abortController) {
          adapter.setAbortController(null);
        }
        adapter.setIsAcquiring(false);
        if (adapter.isMounted()) {
          adapter.setIsRecording(false);
          adapter.setRecordingNodeId(null);
          adapter.setMicLevel(0);
          adapter.setRecordMs(0);
          if (adapter.getDraftId() === originDraftId) {
            adapter.setAudioError(reason);
          }
        }
      },
    });

    adapter.setIsAcquiring(false);

    if (
      !adapter.isMounted() ||
      abortController.signal.aborted ||
      adapter.getDraftId() !== originDraftId
    ) {
      session.cancel();
      if (adapter.getAbortController() === abortController) {
        adapter.setAbortController(null);
      }
      return;
    }

    adapter.setRecorder(session);
    adapter.setTarget(target);
    const started = Date.now();
    adapter.setIsRecording(true);
    adapter.setRecordingNodeId(target.nodeId);
    adapter.setRecordMs(0);
    adapter.setTimer(
      setInterval(() => {
        if (!adapter.isMounted() || adapter.getRecorder() !== session) {
          clearMicRecordingTimer(adapter);
          return;
        }
        adapter.setRecordMs(Date.now() - started);
        adapter.setMicLevel(session.getLevel());
      }, 60),
    );
  } catch (err) {
    adapter.setIsAcquiring(false);
    if (adapter.getAbortController() === abortController) {
      adapter.setAbortController(null);
    }
    if (
      adapter.isMounted() &&
      !abortController.signal.aborted &&
      adapter.getDraftId() === originDraftId
    ) {
      adapter.setAudioError(err instanceof Error ? err.message : "Could not access microphone.");
    }
  }
}

export async function runStopMicRecording(
  adapter: MicRecordingStateAdapter,
  fallbackTarget: MicRecordingTarget,
): Promise<void> {
  const session = adapter.getRecorder();
  if (!session) return;

  clearMicRecordingTimer(adapter);
  const target = adapter.getTarget() ?? fallbackTarget;
  const originDraftId = target.draftId;

  adapter.setRecorder(null);
  adapter.setTarget(null);
  adapter.setAbortController(null);
  adapter.setIsRecording(false);
  adapter.setRecordingNodeId(null);
  adapter.setMicLevel(0);

  try {
    const result = await session.stop();
    if (!adapter.isMounted() || adapter.getDraftId() !== originDraftId) {
      return;
    }
    adapter.onAttachAudioClip({
      targetDraftId: originDraftId,
      nodeId: target.nodeId,
      requestedClipId: target.attachedClipId,
      clipTemplate: {
        mimeType: result.mimeType,
        extension: result.extension,
        durationMs: result.durationMs,
        trimStartMs: 0,
        trimEndMs: result.durationMs,
        label: target.san ? `Narration for ${target.san}` : `Intro (${target.nodeId})`,
        ...(target.attachedSubtitles ? { subtitles: target.attachedSubtitles } : {}),
      },
      bytes: result.bytes,
      peaks: result.peaks,
    });
  } catch (err) {
    if (adapter.isMounted() && adapter.getDraftId() === originDraftId) {
      adapter.setAudioError(err instanceof Error ? err.message : "Failed to save recording.");
    }
  }
}

export function runCancelMicRecording(
  adapter: MicRecordingStateAdapter,
  options?: { resetUi?: boolean },
): void {
  const controller = adapter.getAbortController();
  if (controller) {
    controller.abort();
    adapter.setAbortController(null);
  }
  adapter.setIsAcquiring(false);
  clearMicRecordingTimer(adapter);
  adapter.getRecorder()?.cancel();
  adapter.setRecorder(null);
  adapter.setTarget(null);
  if (options?.resetUi !== false && adapter.isMounted()) {
    adapter.setIsRecording(false);
    adapter.setRecordingNodeId(null);
    adapter.setMicLevel(0);
    adapter.setRecordMs(0);
  }
}

// ============================================================================
// SCR-04 · Dirty Raw PGN Buffer & Conflict Detection
// ============================================================================

export interface RawPgnBufferState {
  draftId: string;
  base: string;
  value: string;
}

export interface RawPgnDerivedView {
  displayedPgn: string;
  isDirty: boolean;
  hasConflict: boolean;
}

export function createRawPgnBuffer(draftId: string, pgnText: string): RawPgnBufferState {
  return { draftId, base: pgnText, value: pgnText };
}

export function deriveRawPgnView(
  buffer: RawPgnBufferState,
  liveDraftId: string,
  livePgnText: string,
): RawPgnDerivedView {
  if (buffer.draftId !== liveDraftId) {
    return {
      displayedPgn: livePgnText,
      isDirty: false,
      hasConflict: false,
    };
  }
  const isDirty = buffer.value !== buffer.base;
  if (isDirty) {
    return {
      displayedPgn: buffer.value,
      isDirty: true,
      hasConflict: buffer.base !== livePgnText,
    };
  }
  return {
    displayedPgn: livePgnText,
    isDirty: false,
    hasConflict: false,
  };
}

export function editRawPgnBuffer(
  prev: RawPgnBufferState,
  liveDraftId: string,
  livePgnText: string,
  nextValue: string,
): RawPgnBufferState {
  if (prev.draftId !== liveDraftId || prev.value === prev.base) {
    return {
      draftId: liveDraftId,
      base: livePgnText,
      value: nextValue,
    };
  }
  return {
    ...prev,
    value: nextValue,
  };
}

// ============================================================================
// FMT-02 · Export Gate Contingent on Final Archive Validity
// ============================================================================

/**
 * Packs a draft into a `.pgna` ZIP archive and verifies final archive validity.
 * Throws `PgnaPackError` on missing referenced media, subtitle path collisions, or
 * archive validation failure so callers never trigger a download for an invalid archive.
 */
export async function buildValidatedPgnaArchive(draft: ScribeDraft): Promise<Uint8Array> {
  const packed = await packPgnaArchive({
    manifest: draft.manifest,
    pgnText: draft.pgnText,
    audioByPath: draft.audioByPath,
    subtitlesByPath: draft.subtitlesByPath,
  });

  const maxEntryBytes = packed.entries.reduce(
    (max, entry) => Math.max(max, entry.data.byteLength),
    DEFAULT_MAX_ZIP_ENTRY_BYTES,
  );
  const totalUncompressedBytes = packed.entries.reduce(
    (sum, entry) => sum + entry.data.byteLength,
    0,
  );
  const validation = await validatePgnaZip(packed.zipBytes, {
    maxEntries: Math.max(DEFAULT_MAX_ZIP_ENTRIES, packed.entries.length),
    maxEntryBytes,
    maxTotalUncompressedBytes: Math.max(
      DEFAULT_MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
      totalUncompressedBytes,
    ),
  });
  if (!validation.valid) {
    const errors = validation.diagnostics.filter((d) => d.severity === "error");
    const summary =
      errors.length > 0
        ? errors.map((d) => `[${d.code}] ${d.message}`).join("; ")
        : "Packed PGNA archive failed final validation.";
    throw new PgnaPackError("ARCHIVE_VALIDATION_FAILED", summary, errors[0]?.path);
  }

  return packed.zipBytes;
}

export function formatPgnaExportError(err: unknown): string {
  if (err instanceof PgnaPackError) {
    return `Export failed [${err.code}]: ${err.message}`;
  }
  return `Export failed: ${err instanceof Error ? err.message : String(err)}`;
}
