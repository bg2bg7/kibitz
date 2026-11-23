import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ChessBoard,
  createTimelineAudioEngine,
  type PromotionPiece,
  type TimelineAudioEngine,
} from "@suite/board-ui";
import {
  createPgnaPlayer,
  unpackPgnaArchive,
  type NodeId,
  type PlaybackSnapshot,
  type UnpackedPgnaArchive,
} from "@suite/pgna";
import { EmojiReactionBar, type CuratedStudentEmojiId } from "@suite/ui";
import {
  buildStudyArchiveUrl,
  fetchStudyArchiveBytes,
  fetchStudyDetail,
  type LectureStudy,
} from "../api";

export interface LectureViewerProps {
  studyId: string;
  onBackToBrowser: () => void;
  onOpenAccount: (handle: string) => void;
  onSelectTag: (tag: string) => void;
}

function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

interface UnpackedPlayerStageProps {
  unpacked: UnpackedPgnaArchive;
}

function UnpackedPlayerStage({ unpacked }: UnpackedPlayerStageProps) {
  const { manifest, timeline, audioByPath, subtitlesByPath } = unpacked;

  const player = useMemo(
    () =>
      createPgnaPlayer(timeline, {
        interactiveGuessesEnabled: true,
        subtitleLang: manifest.defaultSubtitleLang || "en",
        subtitlesByPath,
        clips: manifest.clips,
      }),
    [timeline, manifest.defaultSubtitleLang, manifest.clips, subtitlesByPath],
  );

  const snapshotRef = useRef<{ player: typeof player; snap: PlaybackSnapshot } | null>(null);
  const snapshot = useSyncExternalStore(
    (onStoreChange) =>
      player.subscribe((next) => {
        snapshotRef.current = { player, snap: next };
        onStoreChange();
      }),
    () => {
      if (snapshotRef.current?.player !== player) {
        snapshotRef.current = { player, snap: player.getSnapshot() };
      }
      return snapshotRef.current.snap;
    },
    () => player.getSnapshot(),
  );

  const [guessesEnabled, setGuessesEnabled] = useState(true);
  const audioEngineRef = useRef<TimelineAudioEngine | null>(null);

  useEffect(() => {
    player.setInteractiveGuessesEnabled(guessesEnabled);
  }, [player, guessesEnabled]);

  useEffect(() => {
    const engine = createTimelineAudioEngine(audioByPath, manifest.clips);
    audioEngineRef.current = engine;
    return () => {
      engine.dispose();
      if (audioEngineRef.current === engine) {
        audioEngineRef.current = null;
      }
    };
  }, [audioByPath, manifest.clips]);

  useEffect(() => {
    if (!snapshot.isPlaying) return;
    let rafId = 0;
    let lastTs = performance.now();

    const loop = (now: number) => {
      const dt = Number.isFinite(now - lastTs) ? Math.max(0, now - lastTs) : 0;
      lastTs = now;
      player.tick(dt);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);

    const onVisibilityChange = () => {
      if (typeof document !== "undefined" && document.hidden) {
        player.pause();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    return () => {
      cancelAnimationFrame(rafId);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [snapshot.isPlaying, player]);

  useEffect(() => {
    audioEngineRef.current?.sync(
      snapshot.isPlaying,
      snapshot.activeAudio,
      snapshot.audioTimeMs,
    );
  }, [snapshot.isPlaying, snapshot.activeAudio, snapshot.audioTimeMs]);

  const handleBoardMove = (move: { from: string; to: string; promotion?: PromotionPiece }) => {
    if (snapshot.guessPhase === "awaiting") {
      audioEngineRef.current?.unlock();
      player.submitGuessMove(move.from, move.to, move.promotion);
    }
  };

  const allNodeIds = Object.keys(timeline.nodeIndex) as NodeId[];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,540px)_1fr]">
      {/* Left: ChessBoard, Subtitles, Guess Banner & Transport */}
      <div className="flex flex-col gap-3 rounded-2xl border border-stone-200/90 bg-white p-4 shadow-2xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-slate-900 px-2.5 py-0.5 text-[11px] font-semibold text-white">
              {snapshot.mode === "timeline" ? "Timeline Auto-Play" : "Manual Exploration"}
            </span>
            {snapshot.isRevisit ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
                ↩ Silent Return Pause
              </span>
            ) : null}
          </div>

          <button
            type="button"
            onClick={() =>
              player.setMode(snapshot.mode === "timeline" ? "manual" : "timeline")
            }
            className="rounded-lg border border-stone-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-stone-50"
          >
            Switch to {snapshot.mode === "timeline" ? "Manual" : "Timeline"}
          </button>
        </div>

        <div className="mx-auto w-full max-w-[500px]">
          <ChessBoard
            fen={snapshot.fen}
            orientation={snapshot.orientation}
            lastMove={snapshot.lastMove}
            arrows={snapshot.arrows}
            highlights={snapshot.highlights}
            interactive={snapshot.guessPhase === "awaiting"}
            onMove={handleBoardMove}
          />
        </div>

        {/* Subtitle Overlay */}
        {snapshot.activeSubtitle ? (
          <div className="rounded-lg bg-slate-900 px-3 py-2 text-center text-xs font-medium text-white">
            {snapshot.activeSubtitle}
          </div>
        ) : null}

        {/* Interactive [%guess] Banner */}
        {snapshot.guessPhase !== "idle" && snapshot.activeGuess ? (
          <div className="rounded-xl border border-violet-300 bg-violet-50 p-3 text-xs">
            {snapshot.guessPhase === "awaiting" ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-violet-950">
                    Your Turn! Play your candidate move on the board.
                  </strong>
                  <button
                    type="button"
                    onClick={() => player.continueAfterGuess()}
                    className="rounded border border-violet-300 bg-white px-2 py-0.5 text-[11px] font-medium text-violet-800 hover:bg-violet-100"
                  >
                    Skip / Show Solution
                  </button>
                </div>
                {snapshot.lastGuessResult?.status === "unlisted" ? (
                  <p className="text-rose-700">
                    That legal move isn&apos;t in the study lines — try another candidate move!
                  </p>
                ) : null}
              </div>
            ) : snapshot.guessPhase === "playing_branch" ? (
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-violet-950">
                  Playing {snapshot.activeBranch?.san} ({snapshot.activeBranch?.outcome})…
                </span>
                <button
                  type="button"
                  onClick={() => player.returnToGuess()}
                  className="rounded border border-violet-300 bg-white px-2 py-0.5 text-[11px] font-medium text-violet-900"
                >
                  Return to Guess
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-violet-950">
                  Branch finished ({snapshot.activeBranch?.san}:{" "}
                  <span className="uppercase">{snapshot.activeBranch?.outcome}</span>)
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => player.returnToGuess()}
                    className="rounded bg-violet-700 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-violet-800"
                  >
                    Try Another Move
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      audioEngineRef.current?.unlock();
                      player.replayGuessBranch();
                    }}
                    className="rounded border border-violet-300 bg-white px-2 py-1 text-[11px] font-medium text-violet-900"
                  >
                    Replay
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      audioEngineRef.current?.unlock();
                      player.continueAfterGuess();
                    }}
                    className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700"
                  >
                    Continue
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : null}

        {/* Transport Controls & Scrubber */}
        <div className="space-y-2 border-t border-stone-100 pt-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={
                (timeline.totalDurationMs === 0 &&
                  snapshot.mode === "timeline" &&
                  snapshot.guessPhase !== "playing_branch") ||
                snapshot.guessPhase === "awaiting" ||
                snapshot.guessPhase === "branch_complete"
              }
              onClick={() => {
                if (snapshot.isPlaying) {
                  player.pause();
                } else {
                  audioEngineRef.current?.unlock();
                  player.play();
                }
              }}
              className="rounded-lg bg-slate-900 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:opacity-40"
            >
              {snapshot.isPlaying ? "Pause" : "Play"}
            </button>

            <input
              type="range"
              aria-label="Lecture timeline scrubber"
              min={0}
              max={Math.max(1, timeline.totalDurationMs)}
              value={snapshot.globalTimeMs}
              onChange={(e) => {
                if (snapshot.mode !== "timeline") player.setMode("timeline");
                player.seek(Number(e.target.value));
              }}
              className="flex-1 accent-slate-900"
            />

            <span className="font-mono text-xs text-slate-600">
              {formatClock(snapshot.globalTimeMs)} / {formatClock(timeline.totalDurationMs)}
            </span>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={guessesEnabled}
                onChange={(e) => {
                  setGuessesEnabled(e.target.checked);
                  player.setInteractiveGuessesEnabled(e.target.checked);
                }}
                className="accent-slate-900"
              />
              Interactive guess prompts
            </label>
            <button
              type="button"
              onClick={() => {
                player.resetResolvedGuesses();
                player.seek(0);
              }}
              className="text-[11px] font-medium text-sky-700 hover:underline"
            >
              Restart &amp; Reset Guesses
            </button>
          </div>
        </div>
      </div>

      {/* Right: Commentary, Timeline Steps & Manual Explorer */}
      <div className="flex flex-col gap-4">
        <div className="rounded-2xl border border-stone-200/90 bg-white p-4 shadow-2xs">
          <h2 className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
            Commentary &amp; Narration
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded bg-stone-100 px-2 py-0.5 font-mono font-semibold text-slate-800">
              {snapshot.activeNodeId ?? "—"}
            </span>
            <span className="text-slate-600">
              {snapshot.activeAudio
                ? `Audio clip: ${snapshot.activeAudio.clipId}`
                : snapshot.isRevisit
                  ? "Silent return pause"
                  : "Silent position"}
            </span>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-slate-800">
            {snapshot.comment || (
              <span className="italic text-slate-400">No commentary text on this position.</span>
            )}
          </p>
        </div>

        <div className="rounded-2xl border border-stone-200/90 bg-white p-4 shadow-2xs">
          <h2 className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
            Timeline Steps ({timeline.entries.length})
          </h2>
          {timeline.entries.length === 0 ? (
            <p className="mt-2 text-xs text-slate-500">
              This PGNA has no scheduled timeline steps — switch to Manual Exploration to step
              through positions.
            </p>
          ) : (
            <div className="mt-2.5 max-h-72 space-y-1.5 overflow-y-auto">
              {timeline.entries.map((entry) => {
                const isActive =
                  snapshot.mode === "timeline" && snapshot.activeEntryIndex === entry.index;
                return (
                  <button
                    key={`${entry.nodeId}-${entry.index}`}
                    type="button"
                    onClick={() => {
                      if (snapshot.mode !== "timeline") player.setMode("timeline");
                      player.seek(entry.startMs);
                    }}
                    className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-xs transition ${
                      isActive
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-stone-200 bg-white text-slate-800 hover:bg-stone-50"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] opacity-70">#{entry.index + 1}</span>
                      <span className="font-semibold">{entry.san ?? "Start"}</span>
                      {entry.isRevisit ? (
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                            isActive
                              ? "bg-amber-400/20 text-amber-200"
                              : "bg-amber-100 text-amber-900"
                          }`}
                        >
                          ↩ Return
                        </span>
                      ) : null}
                      {entry.guess ? (
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                            isActive
                              ? "bg-violet-400/20 text-violet-200"
                              : "bg-violet-100 text-violet-800"
                          }`}
                        >
                          ? Guess
                        </span>
                      ) : null}
                    </div>
                    <span className="font-mono text-[10px] opacity-75">
                      {(entry.startMs / 1000).toFixed(1)}s–{(entry.endMs / 1000).toFixed(1)}s
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {snapshot.mode === "manual" ? (
          <div className="rounded-2xl border border-stone-200/90 bg-white p-4 shadow-2xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
                Manual Positions ({allNodeIds.length})
              </h2>
              {snapshot.activeNodeId ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {(timeline.guesses?.[snapshot.activeNodeId]?.branches.length ?? 0) > 0 &&
                  snapshot.guessPhase === "idle" ? (
                    <button
                      type="button"
                      onClick={() => {
                        audioEngineRef.current?.unlock();
                        player.enterGuessPrompt(snapshot.activeNodeId!);
                      }}
                      className="rounded border border-violet-300 bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-900 hover:bg-violet-100"
                    >
                      Try Guess Prompt
                    </button>
                  ) : null}
                  {(timeline.nodeIndex[snapshot.activeNodeId]?.timelineIndices ?? []).map(
                    (entryIdx, occIdx) => (
                      <button
                        key={`jump-${snapshot.activeNodeId}-${entryIdx}`}
                        type="button"
                        onClick={() => {
                          player.jumpToNodeOnTimeline(snapshot.activeNodeId!, occIdx);
                        }}
                        className="rounded border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-800 hover:bg-sky-100"
                      >
                        {occIdx === 0
                          ? `Timeline #${entryIdx + 1}`
                          : `Return ↩#${entryIdx + 1}`}
                      </button>
                    ),
                  )}
                </div>
              ) : null}
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {allNodeIds.map((nid) => (
                <button
                  key={nid}
                  type="button"
                  onClick={() => player.selectNode(nid)}
                  className={`rounded-md border px-2 py-1 font-mono text-[11px] ${
                    snapshot.activeNodeId === nid
                      ? "border-slate-900 bg-slate-900 font-semibold text-white"
                      : "border-stone-200 bg-stone-50 text-slate-700 hover:bg-stone-100"
                  }`}
                >
                  {nid}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function LectureViewer({
  studyId,
  onBackToBrowser,
  onOpenAccount,
  onSelectTag,
}: LectureViewerProps) {
  const [study, setStudy] = useState<LectureStudy | null>(null);
  const [unpacked, setUnpacked] = useState<UnpackedPgnaArchive | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEmoji, setSelectedEmoji] = useState<CuratedStudentEmojiId | null>(null);

  useEffect(() => {
    let cancelled = false;

    void Promise.all([fetchStudyDetail(studyId), fetchStudyArchiveBytes(studyId)])
      .then(async ([detail, archiveBytes]) => {
        const archive = await unpackPgnaArchive(archiveBytes);
        if (cancelled) return;
        setStudy(detail.study);
        setUnpacked(archive);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to open PGNA lecture.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [studyId]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-28 animate-pulse rounded-2xl border border-stone-200 bg-white p-6" />
        <div className="grid gap-6 lg:grid-cols-[540px_1fr]">
          <div className="h-[520px] animate-pulse rounded-2xl border border-stone-200 bg-white" />
          <div className="h-[520px] animate-pulse rounded-2xl border border-stone-200 bg-white" />
        </div>
      </div>
    );
  }

  if (error || !study || !unpacked) {
    return (
      <div className="rounded-2xl border border-stone-200 bg-white p-8 text-center">
        <h1 className="text-xl font-bold text-slate-900">Unable to Open Lecture</h1>
        <p className="mt-2 text-sm text-slate-600">{error ?? "Study could not be loaded."}</p>
        <button
          type="button"
          onClick={onBackToBrowser}
          className="mt-5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
        >
          ← Back to Lecture Browser
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Study Metadata Header */}
      <section className="rounded-2xl border border-stone-200/90 bg-white p-5 shadow-2xs">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <button
                type="button"
                onClick={onBackToBrowser}
                className="font-medium hover:text-slate-900 hover:underline"
              >
                ← All Lectures
              </button>
              <span aria-hidden="true">/</span>
              <button
                type="button"
                onClick={() => onOpenAccount(study.ownerHandle)}
                className="font-mono font-semibold text-slate-800 hover:text-sky-700 hover:underline"
              >
                @{study.ownerHandle}
              </button>
            </div>

            <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950">{study.title}</h1>

            {study.description ? (
              <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-slate-600">
                {study.description}
              </p>
            ) : null}

            {study.tags.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {study.tags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => onSelectTag(tag)}
                    className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-0.5 text-xs font-medium text-slate-700 transition hover:bg-slate-900 hover:text-white"
                  >
                    #{tag}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <a
            href={buildStudyArchiveUrl(study.id)}
            download
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-stone-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 transition hover:border-slate-900 hover:bg-stone-50"
          >
            Download .pgna
          </a>
        </div>
      </section>

      {/* PGNA v1.0 Interactive Player */}
      <UnpackedPlayerStage unpacked={unpacked} />

      {/* Student-Safe Curated Emoji Reaction Bar */}
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-stone-200/90 bg-white px-5 py-4 shadow-2xs">
        <div>
          <h2 className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
            Quick Reaction
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Emoji-only feedback keeps Lecture safe and distraction-free for students.
          </p>
        </div>
        <EmojiReactionBar
          selected={selectedEmoji}
          onSelect={(id) => setSelectedEmoji((prev) => (prev === id ? null : id))}
          label="Lecture reaction"
        />
      </section>
    </div>
  );
}
