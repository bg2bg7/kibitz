import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChessBoard, type PromotionPiece } from "@suite/board-ui";
import {
  createPgnaPlayer,
  type NodeId,
  type PgnaManifest,
  type PgnaTimeline,
  type PlaybackSnapshot,
} from "@suite/pgna";
import {
  createTimelineAudioEngine,
  type TimelineAudioEngine,
} from "../local/audioPlaybackEngine";

export interface PreviewPlayerProps {
  manifest: PgnaManifest;
  timeline: PgnaTimeline;
  audioByPath: Record<string, Uint8Array>;
  subtitlesByPath: Record<string, string>;
  mergedSubtitlesVtt: Record<string, string>;
}

function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function PreviewPlayer({
  manifest,
  timeline,
  audioByPath,
  subtitlesByPath,
  mergedSubtitlesVtt,
}: PreviewPlayerProps) {
  const combinedSubtitles = useMemo(
    () => ({ ...subtitlesByPath, ...mergedSubtitlesVtt }),
    [subtitlesByPath, mergedSubtitlesVtt],
  );

  const player = useMemo(
    () =>
      createPgnaPlayer(timeline, {
        interactiveGuessesEnabled: true,
        subtitleLang: manifest.defaultSubtitleLang || "en",
        subtitlesByPath: combinedSubtitles,
        clips: manifest.clips,
      }),
    [timeline, manifest.defaultSubtitleLang, manifest.clips, combinedSubtitles],
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

  // Keep player's interactive guess toggle synchronized even if player instance recreates
  useEffect(() => {
    player.setInteractiveGuessesEnabled(guessesEnabled);
  }, [player, guessesEnabled]);

  // Initialize Web Audio multi-clip engine and pre-decode all audio clips
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

  // Animation loop driving player.tick(dt) while playing
  useEffect(() => {
    if (!snapshot.isPlaying) return;
    let rafId = 0;
    let lastTs = performance.now();

    const loop = (now: number) => {
      const dt = Math.min(100, Math.max(0, now - lastTs));
      lastTs = now;
      player.tick(dt);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(rafId);
  }, [snapshot.isPlaying, player]);

  // Sync Web Audio engine to snapshot.activeAudio & snapshot.audioTimeMs
  // Strictly silent whenever activeAudio === null (gaps, silent moves, and silent revisits!)
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
    <div className="grid gap-6 lg:grid-cols-[minmax(0,520px)_1fr]">
      {/* Left: Playback Board & Subtitle Overlay */}
      <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-slate-900 px-2.5 py-0.5 text-[11px] font-semibold text-white">
              {snapshot.mode === "timeline" ? "Timeline Auto-Play" : "Manual Chess Mode"}
            </span>
            {snapshot.isRevisit ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
                ↩ Silent Return Pause
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() =>
                player.setMode(snapshot.mode === "timeline" ? "manual" : "timeline")
              }
              className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Switch to {snapshot.mode === "timeline" ? "Manual" : "Timeline"}
            </button>
          </div>
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
          <div className="rounded-lg border border-violet-300 bg-violet-50 p-3 text-xs">
            {snapshot.guessPhase === "awaiting" ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
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
                  <p className="text-red-700">
                    That legal move isn&apos;t in the study lines — try another move!
                  </p>
                ) : null}
              </div>
            ) : snapshot.guessPhase === "playing_branch" ? (
              <div className="flex items-center justify-between">
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
                    Return to Guess
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

        {/* Transport & Scrubber */}
        <div className="space-y-2 border-t border-slate-100 pt-2">
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={
                (timeline.totalDurationMs === 0 && snapshot.mode === "timeline") ||
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
              className="rounded-md bg-slate-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-40"
            >
              {snapshot.isPlaying ? "Pause" : "Play"}
            </button>

            <input
              type="range"
              aria-label="Timeline scrubber"
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
              Interactive `[%guess]` prompts
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

      {/* Right: Commentary, Timeline Steps & Manual Node Jump */}
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Active Narration &amp; State
          </h3>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded bg-slate-100 px-2 py-0.5 font-mono font-semibold text-slate-800">
              {snapshot.activeNodeId ?? "—"}
            </span>
            <span className="text-slate-600">
              {snapshot.activeAudio
                ? `Playing audio: ${snapshot.activeAudio.clipId}`
                : snapshot.isRevisit
                  ? "Silent return pause (audio muted per PGNA spec)"
                  : "Silent position"}
            </span>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-slate-800">
            {snapshot.comment || (
              <span className="italic text-slate-400">No commentary prose on this node.</span>
            )}
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Timeline Chapters ({timeline.entries.length})
          </h3>
          <div className="mt-2.5 max-h-64 space-y-1.5 overflow-y-auto">
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
                  className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs transition ${
                    isActive
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-200 bg-white text-slate-800 hover:bg-slate-50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] opacity-70">#{entry.index + 1}</span>
                    <span className="font-semibold">{entry.san ?? `Start`}</span>
                    {entry.isRevisit ? (
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                          isActive ? "bg-amber-400/20 text-amber-200" : "bg-amber-100 text-amber-900"
                        }`}
                      >
                        ↩ Return Pause
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
        </div>

        {snapshot.mode === "manual" ? (
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Manual Node Inspector ({allNodeIds.length} positions)
              </h3>
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
                          ? `Jump to Timeline #${entryIdx + 1}`
                          : `Jump to ↩#${entryIdx + 1}`}
                      </button>
                    ),
                  )}
                </div>
              ) : null}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {allNodeIds.map((nid) => (
                <button
                  key={nid}
                  type="button"
                  onClick={() => player.selectNode(nid)}
                  className={`rounded border px-2 py-1 font-mono text-[11px] ${
                    snapshot.activeNodeId === nid
                      ? "border-sky-600 bg-sky-600 font-semibold text-white"
                      : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100"
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
