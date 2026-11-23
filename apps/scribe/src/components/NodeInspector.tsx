import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  DEFAULT_GAP_MS,
  DEFAULT_RETURN_PAUSE_MS,
  DEFAULT_SILENT_DURATION_MS,
  formatPgnaSeconds,
  isValidSubtitleLang,
  type BoardOrientation,
  type ClipDefinition,
  type CompilationOptions,
  type GuessOutcome,
  type GuessReturnPolicy,
  type NodeId,
  type ParsedCueTag,
  type ParsedNodeTags,
  type PgnaManifest,
  type PgnaTimeline,
} from "@suite/pgna";
import {
  decodeAudioMetadata,
  guessAudioExtension,
  type ActiveRecordingSession,
} from "../local/audioStudio";
import type { IndexedStudyNode, StudyIndex } from "../local/studyTree";
import {
  createRawPgnBuffer,
  deriveRawPgnView,
  editRawPgnBuffer,
  runCancelMicRecording,
  runStartMicRecording,
  runStopMicRecording,
  type AudioClipAttachmentTemplate,
  type MicRecordingStateAdapter,
  type MicRecordingTarget,
  type RawPgnBufferState,
} from "../local/workspaceTransitions";

export type InspectorTab = "move" | "audio" | "guess" | "study";

export interface NodeInspectorProps {
  draftId: string;
  node: IndexedStudyNode;
  gameOrientation: BoardOrientation;
  studyIndex: StudyIndex;
  manifest: PgnaManifest;
  timeline: PgnaTimeline;
  pgnText: string;
  audioByPath: Record<string, Uint8Array>;
  subtitlesByPath: Record<string, string>;
  onUpdateNodeTags: (nodeId: NodeId, updater: (prev: ParsedNodeTags) => ParsedNodeTags) => void;
  onToggleNag: (nodeId: NodeId, nag: string) => void;
  onScheduleNode: (nodeId: NodeId, durMs?: number) => void;
  onRemoveAtTag: (nodeId: NodeId, atIndex: number) => void;
  onUpdateAtTagDuration: (nodeId: NodeId, atIndex: number, durMs: number | undefined) => void;
  onAttachAudioClip: (params: {
    targetDraftId: string;
    nodeId: NodeId;
    requestedClipId: string | null;
    clipTemplate: AudioClipAttachmentTemplate;
    bytes: Uint8Array;
    peaks: number[];
  }) => void;
  onUpdateClip: (clipId: string, updater: (prev: ClipDefinition) => ClipDefinition) => void;
  onDetachAudioClip: (nodeId: NodeId) => void;
  onUpdateSubtitle: (
    clipId: string,
    lang: string,
    vttText: string,
    targetDraftId?: string,
  ) => void;
  onUpdateManifest: (updater: (prev: PgnaManifest) => PgnaManifest) => void;
  onApplyRawPgn: (nextPgnText: string) => void;
  waveformPeaksByClipId: Record<string, number[]>;
}

const NAG_BUTTONS = [
  { nag: "$1", label: "!", title: "Good move (guess: success)" },
  { nag: "$3", label: "!!", title: "Brilliant move (guess: success)" },
  { nag: "$5", label: "!?", title: "Interesting move (guess: interesting)" },
  { nag: "$6", label: "?!", title: "Dubious move (guess: dubious)" },
  { nag: "$2", label: "?", title: "Mistake (guess: fail)" },
  { nag: "$4", label: "??", title: "Blunder (guess: fail)" },
] as const;

export function NodeInspector({
  draftId,
  node,
  gameOrientation,
  studyIndex,
  manifest,
  timeline,
  pgnText,
  audioByPath,
  subtitlesByPath,
  onUpdateNodeTags,
  onToggleNag,
  onScheduleNode,
  onRemoveAtTag,
  onUpdateAtTagDuration,
  onAttachAudioClip,
  onUpdateClip,
  onDetachAudioClip,
  onUpdateSubtitle,
  onUpdateManifest,
  onApplyRawPgn,
  waveformPeaksByClipId,
}: NodeInspectorProps) {
  const [activeTab, setActiveTab] = useState<InspectorTab>("move");

  // Audio recording state (bound to the draft and node where recording started)
  const [isAcquiringMic, setIsAcquiringMic] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingNodeId, setRecordingNodeId] = useState<NodeId | null>(null);
  const [recordMs, setRecordMs] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [audioError, setAudioError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const draftIdRef = useRef(draftId);
  const isAcquiringMicRef = useRef(false);
  const micAbortControllerRef = useRef<AbortController | null>(null);
  const recorderRef = useRef<ActiveRecordingSession | null>(null);
  const recordingTargetRef = useRef<MicRecordingTarget | null>(null);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Audio audition state
  const [isAuditioning, setIsAuditioning] = useState(false);
  const [auditionTimeMs, setAuditionTimeMs] = useState(0);
  const auditionAudioRef = useRef<HTMLAudioElement | null>(null);
  const auditionUrlRef = useRef<string | null>(null);
  const auditionRafRef = useRef<number | null>(null);

  // Cue & subtitle inputs (synced when manifest.defaultSubtitleLang changes across drafts)
  const [newCueOffsetSec, setNewCueOffsetSec] = useState("1.0");
  const defaultSubLang = manifest.defaultSubtitleLang || "en";
  const [subLangDraft, setSubLangDraft] = useState<{ base: string; value: string }>({
    base: defaultSubLang,
    value: defaultSubLang,
  });
  const subLangInput = subLangDraft.base === defaultSubLang ? subLangDraft.value : defaultSubLang;
  const trimmedSubLang = subLangInput.trim();
  const isSubLangValid = isValidSubtitleLang(trimmedSubLang);

  const [defaultLangDraft, setDefaultLangDraft] = useState<{ base: string; value: string }>({
    base: manifest.defaultSubtitleLang ?? "",
    value: manifest.defaultSubtitleLang ?? "",
  });
  const displayedDefaultLang =
    defaultLangDraft.base === (manifest.defaultSubtitleLang ?? "")
      ? defaultLangDraft.value
      : (manifest.defaultSubtitleLang ?? "");
  const isDefaultLangValid =
    displayedDefaultLang.trim() === "" || isValidSubtitleLang(displayedDefaultLang.trim());

  // Raw PGN draft state: preserves user edits across external PGN changes and flags conflicts
  const [rawPgnDraft, setRawPgnDraft] = useState<RawPgnBufferState>(() =>
    createRawPgnBuffer(draftId, pgnText),
  );
  const {
    displayedPgn,
    isDirty: isRawPgnDirty,
    hasConflict: hasRawPgnConflict,
  } = deriveRawPgnView(rawPgnDraft, draftId, pgnText);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const vttInputRef = useRef<HTMLInputElement | null>(null);

  const attachedClipId = node.tags.audioClipId;
  const attachedClip = attachedClipId ? manifest.clips[attachedClipId] : undefined;
  const compilation: CompilationOptions = {
    timingMode: manifest.compilation?.timingMode ?? "flow",
    defaultSilentDurationMs:
      manifest.compilation?.defaultSilentDurationMs ?? DEFAULT_SILENT_DURATION_MS,
    defaultReturnPauseMs: manifest.compilation?.defaultReturnPauseMs ?? DEFAULT_RETURN_PAUSE_MS,
    defaultGapMs: manifest.compilation?.defaultGapMs ?? DEFAULT_GAP_MS,
    includeUnscheduledAudio: manifest.compilation?.includeUnscheduledAudio ?? false,
  };

  // Stop auditioning helper
  const stopAudition = useCallback(() => {
    if (auditionRafRef.current !== null) {
      cancelAnimationFrame(auditionRafRef.current);
      auditionRafRef.current = null;
    }
    if (auditionAudioRef.current) {
      auditionAudioRef.current.pause();
      auditionAudioRef.current.src = "";
      auditionAudioRef.current = null;
    }
    if (auditionUrlRef.current) {
      URL.revokeObjectURL(auditionUrlRef.current);
      auditionUrlRef.current = null;
    }
    setIsAuditioning(false);
  }, []);

  const callbacksRef = useRef({ stopAudition, onAttachAudioClip });
  useEffect(() => {
    callbacksRef.current = { stopAudition, onAttachAudioClip };
  }, [stopAudition, onAttachAudioClip]);

  const buildMicAdapter = useCallback(
    (): MicRecordingStateAdapter => ({
      isMounted: () => mountedRef.current,
      getDraftId: () => draftIdRef.current,
      getIsAcquiring: () => isAcquiringMicRef.current,
      setIsAcquiring: (value) => {
        isAcquiringMicRef.current = value;
        if (mountedRef.current) {
          setIsAcquiringMic(value);
        }
      },
      getAbortController: () => micAbortControllerRef.current,
      setAbortController: (controller) => {
        micAbortControllerRef.current = controller;
      },
      getRecorder: () => recorderRef.current,
      setRecorder: (session) => {
        recorderRef.current = session;
      },
      getTarget: () => recordingTargetRef.current,
      setTarget: (target) => {
        recordingTargetRef.current = target;
      },
      getTimer: () => recordTimerRef.current,
      setTimer: (timer) => {
        recordTimerRef.current = timer;
      },
      setIsRecording,
      setRecordingNodeId,
      setRecordMs,
      setMicLevel,
      setAudioError,
      stopAudition: () => callbacksRef.current.stopAudition(),
      onAttachAudioClip: (params) => callbacksRef.current.onAttachAudioClip(params),
    }),
    [],
  );

  // Track mounted lifecycle before draftId cleanup so unmount skips UI state updates
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Stop auditioning whenever the selected node or draft changes
  useEffect(() => {
    return () => {
      stopAudition();
    };
  }, [draftId, node.nodeId, stopAudition]);

  // Keep draftIdRef synced and abort/cleanup active or pending recording on unmount or draft switch
  useEffect(() => {
    draftIdRef.current = draftId;
    return () => {
      runCancelMicRecording(buildMicAdapter(), { resetUi: true });
      if (mountedRef.current) {
        setAudioError(null);
      }
    };
  }, [draftId, buildMicAdapter]);

  const handleStartRecording = async () => {
    const originDraftId = draftId;
    const target: MicRecordingTarget = {
      draftId: originDraftId,
      nodeId: node.nodeId,
      san: node.san,
      attachedClipId,
      attachedSubtitles: attachedClip?.subtitles ? { ...attachedClip.subtitles } : undefined,
    };
    await runStartMicRecording(buildMicAdapter(), target);
  };

  const handleStopRecording = async () => {
    const originDraftId = recordingTargetRef.current?.draftId ?? draftId;
    const fallbackTarget: MicRecordingTarget = {
      draftId: originDraftId,
      nodeId: node.nodeId,
      san: node.san,
      attachedClipId,
      attachedSubtitles: attachedClip?.subtitles ? { ...attachedClip.subtitles } : undefined,
    };
    await runStopMicRecording(buildMicAdapter(), fallbackTarget);
  };

  const handleCancelRecording = () => {
    runCancelMicRecording(buildMicAdapter(), { resetUi: true });
  };

  const handleAudioFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setAudioError(null);
    stopAudition();
    const originDraftId = draftId;
    const targetNodeId = node.nodeId;
    const targetClipId = attachedClipId;
    const targetSubtitles = attachedClip?.subtitles ? { ...attachedClip.subtitles } : undefined;
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const mimeType = file.type || "audio/ogg";
      const ext = guessAudioExtension(mimeType, file.name);
      const meta = await decodeAudioMetadata(bytes, undefined, 64, {
        strictDuration: true,
        mimeType,
      });
      if (!mountedRef.current || draftIdRef.current !== originDraftId) {
        return;
      }
      onAttachAudioClip({
        targetDraftId: originDraftId,
        nodeId: targetNodeId,
        requestedClipId: targetClipId,
        clipTemplate: {
          mimeType,
          extension: ext,
          durationMs: meta.durationMs,
          trimStartMs: 0,
          trimEndMs: meta.durationMs,
          label: file.name,
          ...(targetSubtitles ? { subtitles: targetSubtitles } : {}),
        },
        bytes,
        peaks: meta.peaks,
      });
    } catch (err) {
      if (mountedRef.current && draftIdRef.current === originDraftId) {
        setAudioError(err instanceof Error ? err.message : "Failed to import audio file.");
      }
    }
  };

  const handleAuditionToggle = () => {
    if (isAuditioning) {
      stopAudition();
      return;
    }
    if (!attachedClip) return;
    const bytes = audioByPath[attachedClip.path];
    if (!bytes) {
      setAudioError("Audio binary data is not present for this clip.");
      return;
    }
    setAudioError(null);

    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const blob = new Blob([copy], { type: attachedClip.mimeType });
    const url = URL.createObjectURL(blob);
    auditionUrlRef.current = url;

    const audio = new Audio(url);
    auditionAudioRef.current = audio;

    const trimStart = attachedClip.trimStartMs ?? 0;
    const trimEnd = attachedClip.trimEndMs ?? attachedClip.durationMs;

    const tick = () => {
      if (auditionAudioRef.current !== audio) return;
      const nowMs = Math.round(audio.currentTime * 1000);
      setAuditionTimeMs(nowMs);
      if (nowMs >= trimEnd || audio.ended) {
        stopAudition();
        return;
      }
      auditionRafRef.current = requestAnimationFrame(tick);
    };

    const startPlayback = () => {
      if (auditionAudioRef.current !== audio) return;
      if (trimStart > 0) {
        try {
          audio.currentTime = trimStart / 1000;
        } catch {
          // ignore unseekable stream
        }
      }
      audio
        .play()
        .then(() => {
          if (auditionAudioRef.current !== audio) return;
          setIsAuditioning(true);
          auditionRafRef.current = requestAnimationFrame(tick);
        })
        .catch(() => {
          if (auditionAudioRef.current === audio) {
            stopAudition();
            setAudioError("Browser blocked audio playback or format is unsupported.");
          }
        });
    };

    if (trimStart > 0 && audio.readyState < 1) {
      audio.addEventListener("loadedmetadata", startPlayback, { once: true });
      audio.load();
    } else {
      startPlayback();
    }
  };

  const handleCaptureCue = (clearOnly = false) => {
    const parsedSec = Number(newCueOffsetSec);
    const offsetMs = Number.isFinite(parsedSec) && parsedSec >= 0 ? Math.round(parsedSec * 1000) : 1000;
    const newCue: ParsedCueTag = clearOnly
      ? { offsetMs, directives: [{ kind: "clear" }] }
      : {
          offsetMs,
          directives: [
            { kind: "cal", arrows: [...node.tags.arrows] },
            { kind: "csl", highlights: [...node.tags.highlights] },
          ],
        };

    onUpdateNodeTags(node.nodeId, (prev) => ({
      ...prev,
      cues: [...prev.cues, newCue].sort((a, b) => a.offsetMs - b.offsetMs),
    }));
  };

  const handleDeleteCue = (cueIdx: number) => {
    onUpdateNodeTags(node.nodeId, (prev) => ({
      ...prev,
      cues: prev.cues.filter((_, i) => i !== cueIdx),
    }));
  };

  const handleImportVtt = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !attachedClip || !isSubLangValid) return;
    const originDraftId = draftId;
    const targetClipId = attachedClip.id;
    const targetLang = trimmedSubLang;
    const text = await file.text();
    if (!mountedRef.current || draftIdRef.current !== originDraftId) {
      return;
    }
    onUpdateSubtitle(targetClipId, targetLang, text, originDraftId);
  };

  // Determine which [%at] tags are primary vs silent revisit using sorted value order
  const sortedAtWithIndex = node.tags.atTags
    .map((at, originalIndex) => ({ at, originalIndex }))
    .sort((a, b) => a.at.value - b.at.value || a.originalIndex - b.originalIndex);

  const subPath = isSubLangValid ? attachedClip?.subtitles?.[trimmedSubLang] : undefined;
  const currentVtt = subPath ? (subtitlesByPath[subPath] ?? "") : "";
  const guessSpec = timeline.guesses?.[node.nodeId];

  return (
    <div className="flex flex-col rounded-xl border border-slate-200 bg-white shadow-xs">
      {/* Tab Header */}
      <div className="flex border-b border-slate-200 px-2 pt-2 text-xs font-medium">
        {(
          [
            { id: "move", label: "Move & Notes" },
            { id: "audio", label: attachedClip ? "Audio ● & Cues" : "Audio & Cues" },
            { id: "guess", label: node.tags.guess ? "Guess ?" : "Guess" },
            { id: "study", label: "Study & PGN" },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`border-b-2 px-3 py-2 transition ${
              activeTab === tab.id
                ? "border-slate-900 text-slate-900"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="space-y-4 p-4 text-xs">
        {/* TAB 1: MOVE & NOTES */}
        {activeTab === "move" ? (
          <>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  {node.san
                    ? `${node.moveNumber}${node.turnMoved === "b" ? "..." : "."} ${node.san}`
                    : `Game ${node.gameIndex + 1} Start Position`}
                </h3>
                <p className="text-[11px] text-slate-500">
                  Canonical ID: <code>{node.nodeId}</code> · Ply {node.ply}
                </p>
              </div>
              {node.ply > 0 ? (
                <div className="flex items-center gap-1">
                  {NAG_BUTTONS.map((btn) => {
                    const active = node.nags.includes(btn.nag);
                    return (
                      <button
                        key={btn.nag}
                        type="button"
                        title={btn.title}
                        onClick={() => onToggleNag(node.nodeId, btn.nag)}
                        className={`rounded border px-1.5 py-0.5 text-xs font-bold transition ${
                          active
                            ? "border-amber-400 bg-amber-100 text-amber-900"
                            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        {btn.label}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>

            <label className="block">
              <span className="font-medium text-slate-700">Commentary Prose</span>
              <textarea
                rows={3}
                value={node.tags.prose}
                onChange={(e) =>
                  onUpdateNodeTags(node.nodeId, (prev) => ({ ...prev, prose: e.target.value }))
                }
                placeholder="Explain the idea behind this position or move..."
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-sky-500 focus:outline-none"
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="font-medium text-slate-700">Orientation Override ([%orient])</span>
                <select
                  value={node.tags.orientation ?? ""}
                  onChange={(e) => {
                    const val = e.target.value as "" | BoardOrientation;
                    onUpdateNodeTags(node.nodeId, (prev) => ({
                      ...prev,
                      orientation: val === "" ? null : val,
                    }));
                  }}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                >
                  <option value="">Inherit game ({gameOrientation})</option>
                  <option value="white">White</option>
                  <option value="black">Black</option>
                </select>
              </label>

              <label className="block">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-slate-700">
                    No-Audio Move Duration ([%dur] ms)
                  </span>
                  {attachedClip && node.tags.durMs !== null ? (
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateNodeTags(node.nodeId, (prev) => ({ ...prev, durMs: null }))
                      }
                      className="text-[11px] font-medium text-amber-700 hover:underline"
                    >
                      Clear ignored [%dur]
                    </button>
                  ) : null}
                </div>
                <input
                  type="number"
                  min={100}
                  step={100}
                  disabled={Boolean(attachedClip)}
                  value={node.tags.durMs ?? ""}
                  placeholder={`Default ${compilation.defaultSilentDurationMs} ms`}
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    const parsed = raw === "" ? null : Number(raw);
                    onUpdateNodeTags(node.nodeId, (prev) => ({
                      ...prev,
                      durMs: parsed !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : null,
                    }));
                  }}
                  className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs disabled:bg-slate-100 disabled:text-slate-400"
                />
              </label>
            </div>

            {/* Timeline Occurrences & Silent Return Pauses */}
            <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h4 className="font-semibold text-slate-800">Timeline Visits ([%at])</h4>
                  <p className="text-[11px] text-slate-500">
                    Revisits return silently to this position (never attaching a second audio).
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onScheduleNode(node.nodeId)}
                  className="rounded-md bg-slate-900 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-slate-800"
                >
                  {sortedAtWithIndex.length === 0 ? "+ Add to Timeline" : "+ Add Silent Return Pause"}
                </button>
              </div>

              {sortedAtWithIndex.length === 0 ? (
                <p className="mt-2 text-[11px] text-slate-400">
                  Not scheduled on auto-play timeline yet (still accessible in Manual Mode).
                </p>
              ) : (
                <div className="mt-2.5 space-y-2">
                  {sortedAtWithIndex.map(({ at, originalIndex }, orderIdx) => {
                    const isRevisit = orderIdx > 0;
                    return (
                      <div
                        key={`${node.nodeId}-at-${originalIndex}`}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-2"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                              isRevisit
                                ? "bg-amber-100 text-amber-800"
                                : "bg-sky-100 text-sky-800"
                            }`}
                          >
                            {isRevisit ? "↩ Return Pause" : "Primary"}
                          </span>
                          <code className="font-semibold text-slate-800">
                            {at.mode === "ordinal" ? `#${at.value}` : `${formatPgnaSeconds(at.value)}s`}
                          </code>
                          {isRevisit ? (
                            <span className="text-[10px] text-slate-500">(Always silent)</span>
                          ) : attachedClip ? (
                            <span className="text-[10px] text-emerald-700">
                              Plays {attachedClip.id}
                            </span>
                          ) : null}
                        </div>

                        <div className="flex items-center gap-2">
                          {isRevisit || !attachedClip ? (
                            <label className="flex items-center gap-1 text-[11px] text-slate-600">
                              <span>dur (ms):</span>
                              <input
                                type="number"
                                min={100}
                                step={100}
                                value={at.durMs ?? ""}
                                placeholder={String(
                                  isRevisit
                                    ? compilation.defaultReturnPauseMs
                                    : compilation.defaultSilentDurationMs,
                                )}
                                onChange={(e) => {
                                  const raw = e.target.value.trim();
                                  const val = raw === "" ? undefined : Number(raw);
                                  onUpdateAtTagDuration(
                                    node.nodeId,
                                    originalIndex,
                                    val !== undefined && Number.isFinite(val) && val > 0
                                      ? val
                                      : undefined,
                                  );
                                }}
                                className="w-20 rounded border border-slate-300 px-1.5 py-0.5 text-xs"
                              />
                            </label>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => onRemoveAtTag(node.nodeId, originalIndex)}
                            className="rounded px-1.5 py-0.5 text-[11px] font-medium text-red-600 hover:bg-red-50"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        ) : null}

        {/* TAB 2: AUDIO, CUES & SUBTITLES */}
        {activeTab === "audio" ? (
          <>
            <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="font-semibold text-slate-800">Per-Move Audio Clip (Max 1)</h4>
                  <p className="text-[11px] text-slate-500">
                    Stored uncompressed (`STORE`) in `.pgna` for instant seeking and easy redubbing.
                  </p>
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*,.ogg,.webm,.wav,.mp3,.m4a"
                  onChange={handleAudioFileUpload}
                  className="hidden"
                />

                <div className="flex items-center gap-1.5">
                  {!isRecording ? (
                    <>
                      <button
                        type="button"
                        disabled={isAcquiringMic}
                        onClick={handleStartRecording}
                        className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isAcquiringMic
                          ? "Requesting mic…"
                          : attachedClip
                            ? "Re-record"
                            : "Record Mic"}
                      </button>
                      {isAcquiringMic ? (
                        <button
                          type="button"
                          onClick={handleCancelRecording}
                          className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                        >
                          Cancel
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          {attachedClip ? "Replace File" : "Import Audio"}
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={handleStopRecording}
                        className="rounded-md bg-slate-900 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                      >
                        Stop ({(recordMs / 1000).toFixed(1)}s)
                      </button>
                      <button
                        type="button"
                        onClick={handleCancelRecording}
                        className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                      >
                        Cancel
                      </button>
                    </>
                  )}
                </div>
              </div>

              {isRecording ? (
                <div className="mt-3 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2">
                  <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-600" />
                  <span className="font-semibold text-red-800">
                    Recording{recordingNodeId ? ` (${recordingNodeId})` : ""}…
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-red-200">
                    <div
                      className="h-full bg-red-600 transition-all"
                      style={{ width: `${Math.max(8, Math.round(micLevel * 100))}%` }}
                    />
                  </div>
                </div>
              ) : null}

              {audioError ? <p className="mt-2 text-xs text-red-600">{audioError}</p> : null}

              {attachedClip ? (
                <div className="mt-3 space-y-3 rounded-lg border border-slate-200 bg-white p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-semibold text-slate-900">{attachedClip.id}</span>{" "}
                      <span className="text-[11px] text-slate-500">
                        ({attachedClip.path} · {attachedClip.mimeType})
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={handleAuditionToggle}
                        className="rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
                      >
                        {isAuditioning
                          ? `Stop (${(auditionTimeMs / 1000).toFixed(2)}s)`
                          : "Audition Trimmed"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          stopAudition();
                          onDetachAudioClip(node.nodeId);
                        }}
                        className="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                      >
                        Detach
                      </button>
                    </div>
                  </div>

                  {/* Waveform Preview with Trim Region */}
                  {(() => {
                    const safeDurationMs = Math.max(1, attachedClip.durationMs);
                    const safeTrimStart = Math.max(
                      0,
                      Math.min(attachedClip.trimStartMs ?? 0, safeDurationMs - 1),
                    );
                    const safeTrimEnd = Math.max(
                      safeTrimStart + 1,
                      Math.min(attachedClip.trimEndMs ?? safeDurationMs, safeDurationMs),
                    );
                    const minGap = Math.max(1, Math.min(100, Math.floor(safeDurationMs / 2)));
                    const trimStep = safeDurationMs < 200 ? 1 : 50;
                    const maxStart = Math.max(0, safeTrimEnd - minGap);
                    const minEnd = Math.min(safeDurationMs, safeTrimStart + minGap);

                    return (
                      <>
                        <div className="relative flex h-12 items-end gap-0.5 overflow-hidden rounded bg-slate-100 px-1 py-1">
                          {(
                            waveformPeaksByClipId[attachedClip.id] ??
                            Array.from({ length: 48 }, (_, i) => 0.25 + ((i * 7) % 10) * 0.06)
                          ).map((peak, idx, arr) => {
                            const ratio = idx / arr.length;
                            const startRatio = safeTrimStart / safeDurationMs;
                            const endRatio = safeTrimEnd / safeDurationMs;
                            const inTrim = ratio >= startRatio && ratio <= endRatio;
                            return (
                              <div
                                key={idx}
                                className={`flex-1 rounded-t-xs ${inTrim ? "bg-sky-600" : "bg-slate-300"}`}
                                style={{ height: `${Math.max(12, Math.round(peak * 100))}%` }}
                              />
                            );
                          })}
                        </div>

                        {/* Non-destructive trim sliders */}
                        <div className="grid grid-cols-2 gap-3 text-[11px]">
                          <label className="block">
                            <span className="font-medium text-slate-700">
                              Trim Start ({safeTrimStart} ms)
                            </span>
                            <input
                              type="range"
                              min={0}
                              max={maxStart}
                              step={trimStep}
                              value={safeTrimStart}
                              onChange={(e) => {
                                const raw = Number(e.target.value);
                                if (!Number.isFinite(raw)) return;
                                onUpdateClip(attachedClip.id, (prev) => {
                                  const dur = Math.max(1, prev.durationMs);
                                  const curEnd = Math.min(dur, prev.trimEndMs ?? dur);
                                  const gap = Math.max(1, Math.min(100, Math.floor(dur / 2)));
                                  const clamped = Math.max(
                                    0,
                                    Math.min(Math.round(raw), Math.max(0, curEnd - gap)),
                                  );
                                  return { ...prev, trimStartMs: clamped };
                                });
                              }}
                              className="mt-1 w-full accent-sky-600"
                            />
                          </label>
                          <label className="block">
                            <span className="font-medium text-slate-700">
                              Trim End ({safeTrimEnd} / {attachedClip.durationMs} ms)
                            </span>
                            <input
                              type="range"
                              min={minEnd}
                              max={safeDurationMs}
                              step={trimStep}
                              value={safeTrimEnd}
                              onChange={(e) => {
                                const raw = Number(e.target.value);
                                if (!Number.isFinite(raw)) return;
                                onUpdateClip(attachedClip.id, (prev) => {
                                  const dur = Math.max(1, prev.durationMs);
                                  const curStart = Math.max(0, prev.trimStartMs ?? 0);
                                  const gap = Math.max(1, Math.min(100, Math.floor(dur / 2)));
                                  const clamped = Math.min(
                                    dur,
                                    Math.max(Math.round(raw), Math.min(dur, curStart + gap)),
                                  );
                                  return { ...prev, trimEndMs: clamped };
                                });
                              }}
                              className="mt-1 w-full accent-sky-600"
                            />
                          </label>
                        </div>
                      </>
                    );
                  })()}
                </div>
              ) : (
                <p className="mt-2 text-[11px] text-slate-400">
                  No audio clip attached to this node. Record or import audio above.
                </p>
              )}
            </div>

            {/* Sub-move [%cue] editor */}
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="font-semibold text-slate-800">Timed Board Cues ([%cue])</h4>
                  <p className="text-[11px] text-slate-500">
                    Offsets are relative to un-trimmed `0.0s` so trimming never desyncs arrows.
                  </p>
                </div>
              </div>

              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1 text-[11px]">
                  <span>Offset (s):</span>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={newCueOffsetSec}
                    onChange={(e) => setNewCueOffsetSec(e.target.value)}
                    className="w-20 rounded border border-slate-300 px-2 py-1 text-xs"
                  />
                </label>
                {isAuditioning ? (
                  <button
                    type="button"
                    onClick={() => setNewCueOffsetSec((auditionTimeMs / 1000).toFixed(2))}
                    className="rounded border border-slate-200 px-2 py-1 text-[11px] hover:bg-slate-50"
                  >
                    Use Playhead
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => handleCaptureCue(false)}
                  className="rounded-md bg-slate-900 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-slate-800"
                >
                  + Capture Board Arrows/Highlights
                </button>
                <button
                  type="button"
                  onClick={() => handleCaptureCue(true)}
                  className="rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                >
                  + Clear Board Cue
                </button>
              </div>

              {node.tags.cues.length === 0 ? (
                <p className="mt-2 text-[11px] text-slate-400">No sub-move cues on this node.</p>
              ) : (
                <div className="mt-2.5 space-y-1.5">
                  {node.tags.cues.map((cue, idx) => (
                    <div
                      key={`cue-${idx}-${cue.offsetMs}`}
                      className="flex items-center justify-between rounded border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px]"
                    >
                      <div>
                        <span className="font-mono font-semibold text-slate-900">
                          @{formatPgnaSeconds(cue.offsetMs)}s
                        </span>{" "}
                        <span className="text-slate-600">
                          {cue.directives
                            .map((d) =>
                              d.kind === "clear"
                                ? "clear"
                                : d.kind.includes("cal")
                                  ? `${d.kind}=${(d.arrows ?? []).map((a) => `${a.color}${a.from}${a.to}`).join(",")}`
                                  : `${d.kind}=${(d.highlights ?? []).map((h) => `${h.color}${h.square}`).join(",")}`,
                            )
                            .join(" ")}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDeleteCue(idx)}
                        className="text-red-600 hover:underline"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Per-clip WebVTT Subtitles */}
            {attachedClip ? (
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="font-semibold text-slate-800">Clip WebVTT Subtitles</h4>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      aria-label="Subtitle language code"
                      value={subLangInput}
                      onChange={(e) =>
                        setSubLangDraft({ base: defaultSubLang, value: e.target.value })
                      }
                      className={`w-16 rounded border px-2 py-0.5 text-center text-xs ${
                        isSubLangValid
                          ? "border-slate-300"
                          : "border-red-400 bg-red-50 text-red-700"
                      }`}
                    />
                    <input
                      ref={vttInputRef}
                      type="file"
                      accept=".vtt,text/vtt"
                      onChange={handleImportVtt}
                      className="hidden"
                    />
                    <button
                      type="button"
                      disabled={!isSubLangValid}
                      onClick={() => vttInputRef.current?.click()}
                      className="rounded border border-slate-200 px-2 py-0.5 text-[11px] hover:bg-slate-50 disabled:opacity-40"
                    >
                      Import .vtt
                    </button>
                  </div>
                </div>
                {!isSubLangValid ? (
                  <p className="mt-1.5 text-[11px] text-red-600">
                    Enter a valid BCP 47 language code (e.g. &ldquo;en&rdquo;, &ldquo;es&rdquo;,
                    &ldquo;zh-Hans&rdquo;).
                  </p>
                ) : null}
                <textarea
                  rows={4}
                  disabled={!isSubLangValid}
                  value={currentVtt}
                  onChange={(e) => {
                    if (isSubLangValid) {
                      onUpdateSubtitle(attachedClip.id, trimmedSubLang, e.target.value, draftId);
                    }
                  }}
                  placeholder={"WEBVTT\n\n00:00.000 --> 00:02.500\nNotice how the bishop eyes f7."}
                  className="mt-2 w-full rounded-md border border-slate-300 p-2 font-mono text-[11px] focus:border-sky-500 focus:outline-none disabled:bg-slate-100"
                />
              </div>
            ) : null}
          </>
        ) : null}

        {/* TAB 3: GUESS PROMPT */}
        {activeTab === "guess" ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50/70 p-3">
              <div>
                <h4 className="font-semibold text-slate-800">Interactive Move Prompt ([%guess])</h4>
                <p className="text-[11px] text-slate-500">
                  Pauses autoplay after this node and asks the student to play a candidate move.
                </p>
              </div>
              <label className="inline-flex cursor-pointer items-center gap-2 font-semibold text-slate-800">
                <input
                  type="checkbox"
                  checked={node.tags.guess !== null}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    onUpdateNodeTags(node.nodeId, (prev) => ({
                      ...prev,
                      guess: checked ? { returnPolicy: "manual" } : null,
                    }));
                  }}
                  className="h-4 w-4 accent-slate-900"
                />
                Enable
              </label>
            </div>

            {node.tags.guess ? (
              <>
                <label className="block">
                  <span className="font-medium text-slate-700">Variation Return Policy</span>
                  <select
                    value={node.tags.guess.returnPolicy}
                    onChange={(e) => {
                      const policy = e.target.value as GuessReturnPolicy;
                      onUpdateNodeTags(node.nodeId, (prev) => ({
                        ...prev,
                        guess: { returnPolicy: policy },
                      }));
                    }}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                  >
                    <option value="manual">
                      return=manual — Pause after variation with &ldquo;Return to Guess&rdquo;
                      button
                    </option>
                    <option value="auto">
                      return=auto — Automatically return after non-success variation
                    </option>
                  </select>
                </label>

                <div className="space-y-2">
                  <h5 className="font-semibold text-slate-800">
                    Candidate Response Branches ({node.childIds.length})
                  </h5>
                  {node.childIds.length === 0 ? (
                    <p className="rounded-md border border-dashed border-slate-200 p-3 text-[11px] text-slate-400">
                      Play one or more response moves from this position on the board to define
                      guess branches.
                    </p>
                  ) : (
                    node.childIds.map((childId, idx) => {
                      const child = studyIndex.nodesById[childId];
                      if (!child) return null;
                      const compiledBranch = guessSpec?.branches.find((b) => b.nodeId === childId);
                      return (
                        <div
                          key={childId}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2"
                        >
                          <div>
                            <span className="font-semibold text-slate-900">{child.san}</span>{" "}
                            <span className="text-[10px] text-slate-500">
                              {idx === 0 ? "Mainline" : `Variation #${idx}`}
                            </span>
                            {compiledBranch ? (
                              <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-700">
                                Effective: {compiledBranch.outcome}
                              </span>
                            ) : null}
                          </div>

                          <select
                            aria-label={`Outcome override for ${child.san}`}
                            value={child.tags.outcome ?? ""}
                            onChange={(e) => {
                              const val = e.target.value as "" | GuessOutcome;
                              onUpdateNodeTags(childId, (prev) => ({
                                ...prev,
                                outcome: val === "" ? null : val,
                              }));
                            }}
                            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                          >
                            <option value="">Auto (NAG / default)</option>
                            <option value="success">success</option>
                            <option value="interesting">interesting</option>
                            <option value="dubious">dubious</option>
                            <option value="fail">fail</option>
                          </select>
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {/* TAB 4: STUDY METADATA, COMPILATION TIMING & RAW PGN */}
        {activeTab === "study" ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="font-medium text-slate-700">Author</span>
                <input
                  type="text"
                  value={manifest.author ?? ""}
                  onChange={(e) =>
                    onUpdateManifest((prev) => ({ ...prev, author: e.target.value }))
                  }
                  className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </label>
              <label className="block">
                <span className="font-medium text-slate-700">Default Subtitle Lang</span>
                <input
                  type="text"
                  value={displayedDefaultLang}
                  onChange={(e) => {
                    const nextVal = e.target.value;
                    setDefaultLangDraft({
                      base: manifest.defaultSubtitleLang ?? "",
                      value: nextVal,
                    });
                    const trimmed = nextVal.trim();
                    if (trimmed === "") {
                      onUpdateManifest((prev) => {
                        const next = { ...prev };
                        delete next.defaultSubtitleLang;
                        return next;
                      });
                    } else if (isValidSubtitleLang(trimmed)) {
                      onUpdateManifest((prev) => ({ ...prev, defaultSubtitleLang: trimmed }));
                    }
                  }}
                  placeholder="en"
                  className={`mt-1 w-full rounded-md border px-2.5 py-1.5 text-xs ${
                    isDefaultLangValid
                      ? "border-slate-300"
                      : "border-red-400 bg-red-50 text-red-700"
                  }`}
                />
                {!isDefaultLangValid ? (
                  <span className="mt-0.5 block text-[10px] text-red-600">
                    Must be a valid BCP 47 tag (e.g. en, es, zh-Hans).
                  </span>
                ) : null}
              </label>
            </div>

            <label className="block">
              <span className="font-medium text-slate-700">Description</span>
              <textarea
                rows={2}
                value={manifest.description ?? ""}
                onChange={(e) =>
                  onUpdateManifest((prev) => ({ ...prev, description: e.target.value }))
                }
                className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs"
              />
            </label>

            <div className="space-y-2.5 rounded-lg border border-slate-200 bg-slate-50/70 p-3">
              <h4 className="font-semibold text-slate-800">
                PGNA Compilation &amp; Default Timing Policy
              </h4>

              <div className="grid grid-cols-2 gap-2.5">
                <label className="block">
                  <span className="font-medium text-slate-700">Timing Mode</span>
                  <select
                    value={compilation.timingMode}
                    onChange={(e) =>
                      onUpdateManifest((prev) => ({
                        ...prev,
                        compilation: {
                          ...prev.compilation,
                          timingMode: e.target.value as "flow" | "strict",
                        },
                      }))
                    }
                    className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                  >
                    <option value="flow">flow (auto-reflow)</option>
                    <option value="strict">strict (error on overlap)</option>
                  </select>
                </label>

                <label className="block">
                  <span className="font-medium text-slate-700">Gap Between Moves (ms)</span>
                  <input
                    type="number"
                    min={0}
                    step={50}
                    value={compilation.defaultGapMs}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      if (Number.isFinite(val) && val >= 0) {
                        onUpdateManifest((prev) => ({
                          ...prev,
                          compilation: { ...prev.compilation, defaultGapMs: val },
                        }));
                      }
                    }}
                    className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                  />
                </label>

                <label className="block">
                  <span className="font-medium text-slate-700">
                    Default No-Audio Move Delay (ms)
                  </span>
                  <input
                    type="number"
                    min={100}
                    step={100}
                    value={compilation.defaultSilentDurationMs}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      if (Number.isFinite(val) && val > 0) {
                        onUpdateManifest((prev) => ({
                          ...prev,
                          compilation: { ...prev.compilation, defaultSilentDurationMs: val },
                        }));
                      }
                    }}
                    className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                  />
                </label>

                <label className="block">
                  <span className="font-medium text-slate-700">
                    Default Return-to-Node Pause (ms)
                  </span>
                  <input
                    type="number"
                    min={100}
                    step={100}
                    value={compilation.defaultReturnPauseMs}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      if (Number.isFinite(val) && val > 0) {
                        onUpdateManifest((prev) => ({
                          ...prev,
                          compilation: { ...prev.compilation, defaultReturnPauseMs: val },
                        }));
                      }
                    }}
                    className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                  />
                </label>
              </div>

              <label className="flex items-center gap-2 pt-1 text-[11px] text-slate-700">
                <input
                  type="checkbox"
                  checked={compilation.includeUnscheduledAudio}
                  onChange={(e) =>
                    onUpdateManifest((prev) => ({
                      ...prev,
                      compilation: {
                        ...prev.compilation,
                        includeUnscheduledAudio: e.target.checked,
                      },
                    }))
                  }
                  className="h-3.5 w-3.5 accent-slate-900"
                />
                Include unscheduled audio nodes automatically (`includeUnscheduledAudio`)
              </label>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-800">Raw PGN Source (study.pgn)</span>
                  {isRawPgnDirty && !hasRawPgnConflict ? (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                      Unapplied edits
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onApplyRawPgn(displayedPgn);
                    setRawPgnDraft(createRawPgnBuffer(draftId, displayedPgn));
                  }}
                  className="rounded bg-slate-900 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-slate-800"
                >
                  Apply PGN Changes
                </button>
              </div>
              {hasRawPgnConflict ? (
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-900">
                  <span>
                    The study changed elsewhere while you have unapplied raw PGN edits. Your edits
                    are preserved below.
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        onApplyRawPgn(displayedPgn);
                        setRawPgnDraft(createRawPgnBuffer(draftId, displayedPgn));
                      }}
                      className="rounded bg-amber-900 px-2 py-1 font-semibold text-white hover:bg-amber-800"
                    >
                      Apply My Raw PGN
                    </button>
                    <button
                      type="button"
                      onClick={() => setRawPgnDraft(createRawPgnBuffer(draftId, pgnText))}
                      className="rounded border border-amber-400 bg-white px-2 py-1 font-medium text-amber-900 hover:bg-amber-100"
                    >
                      Discard &amp; Reload Latest
                    </button>
                  </div>
                </div>
              ) : null}
              <textarea
                rows={7}
                value={displayedPgn}
                onChange={(e) => {
                  const nextValue = e.target.value;
                  setRawPgnDraft((prev) => editRawPgnBuffer(prev, draftId, pgnText, nextValue));
                }}
                className="w-full rounded-lg border border-slate-300 p-2 font-mono text-[11px] text-slate-800 focus:border-sky-500 focus:outline-none"
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
