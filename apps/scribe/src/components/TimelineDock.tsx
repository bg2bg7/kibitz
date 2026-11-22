import type { NodeId, PgnaDiagnostic, PgnaTimeline } from "@suite/pgna";

export interface TimelineDockProps {
  timeline: PgnaTimeline;
  selectedNodeId: NodeId;
  diagnostics: readonly PgnaDiagnostic[];
  showDiagnostics: boolean;
  onToggleDiagnostics: () => void;
  onSelectNode: (nodeId: NodeId) => void;
  onScheduleSelectedNode: () => void;
  onReorderEntry: (fromIndex: number, toIndex: number) => void;
}

function formatMsShort(ms: number): string {
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const m = Math.floor(secs / 60);
  const s = (secs % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

export function TimelineDock({
  timeline,
  selectedNodeId,
  diagnostics,
  showDiagnostics,
  onToggleDiagnostics,
  onSelectNode,
  onScheduleSelectedNode,
  onReorderEntry,
}: TimelineDockProps) {
  const selectedIsScheduled =
    (timeline.nodeIndex[selectedNodeId]?.timelineIndices.length ?? 0) > 0;

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Compiled Linear Timeline
          </h2>
          <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px] font-medium text-slate-700">
            {timeline.entries.length} entr{timeline.entries.length === 1 ? "y" : "ies"} · Total{" "}
            {formatMsShort(timeline.totalDurationMs)}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onScheduleSelectedNode}
            className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
              selectedIsScheduled
                ? "border border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
                : "bg-slate-900 text-white hover:bg-slate-800"
            }`}
          >
            {selectedIsScheduled
              ? `+ Add Silent Return Pause (${selectedNodeId})`
              : `+ Schedule ${selectedNodeId} on Timeline`}
          </button>

          <button
            type="button"
            onClick={onToggleDiagnostics}
            className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            Diagnostics ({diagnostics.length})
          </button>
        </div>
      </div>

      {/* Horizontal Entry Strip */}
      <div className="overflow-x-auto px-4 py-3">
        {timeline.entries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-xs text-slate-400">
            No moves scheduled on the timeline yet. Select a move and click{" "}
            <strong className="text-slate-600">+ Schedule on Timeline</strong> to start sequencing
            autoplay.
          </div>
        ) : (
          <div className="flex items-stretch gap-2">
            {timeline.entries.map((entry, idx) => {
              const durationMs = entry.endMs - entry.startMs;
              const isSelected = entry.nodeId === selectedNodeId;
              const widthPx = Math.max(120, Math.min(260, Math.round(durationMs / 18)));

              const kindClass = entry.isRevisit
                ? "border-amber-300 bg-amber-50/80"
                : entry.audio
                  ? "border-emerald-300 bg-emerald-50/70"
                  : "border-sky-200 bg-sky-50/60";

              return (
                <div
                  key={`${entry.nodeId}-${entry.index}`}
                  style={{ minWidth: `${widthPx}px` }}
                  className={`flex flex-col justify-between rounded-lg border p-2.5 transition ${kindClass} ${
                    isSelected ? "ring-2 ring-slate-900 ring-offset-1" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-1.5">
                    <button
                      type="button"
                      onClick={() => onSelectNode(entry.nodeId)}
                      className="text-left"
                    >
                      <div className="flex items-center gap-1">
                        <span className="font-mono text-[10px] font-bold text-slate-500">
                          #{idx + 1}
                        </span>
                        <span className="text-xs font-bold text-slate-900">
                          {entry.san ?? `g${entry.gameIndex} Start`}
                        </span>
                        {entry.isRevisit ? (
                          <span className="rounded bg-amber-200/80 px-1 text-[9px] font-bold text-amber-950">
                            ↩ Return
                          </span>
                        ) : null}
                        {entry.guess ? (
                          <span className="rounded bg-violet-200 px-1 text-[9px] font-bold text-violet-900">
                            ? Guess
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-[10px] text-slate-600">
                        {entry.isRevisit
                          ? "Silent return pause"
                          : entry.audio
                            ? `Audio: ${entry.audio.clipId}`
                            : "Silent move"}
                      </div>
                    </button>

                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        disabled={idx === 0}
                        title="Move earlier on timeline"
                        onClick={() => onReorderEntry(idx, idx - 1)}
                        className="rounded px-1 py-0.5 text-[10px] font-bold text-slate-600 hover:bg-white/80 disabled:opacity-30"
                      >
                        ←
                      </button>
                      <button
                        type="button"
                        disabled={idx === timeline.entries.length - 1}
                        title="Move later on timeline"
                        onClick={() => onReorderEntry(idx, idx + 1)}
                        className="rounded px-1 py-0.5 text-[10px] font-bold text-slate-600 hover:bg-white/80 disabled:opacity-30"
                      >
                        →
                      </button>
                    </div>
                  </div>

                  <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-slate-500">
                    <span>
                      {formatMsShort(entry.startMs)}–{formatMsShort(entry.endMs)}
                    </span>
                    <span>{(durationMs / 1000).toFixed(1)}s</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Collapsible Compiler Diagnostics Drawer */}
      {showDiagnostics ? (
        <div className="border-t border-slate-200 bg-slate-50 px-4 py-3">
          <h3 className="mb-2 text-xs font-semibold text-slate-700">Compiler Diagnostics</h3>
          {diagnostics.length === 0 ? (
            <p className="text-xs text-emerald-700">
              All PGNA v1.0 invariants passed with zero errors or warnings.
            </p>
          ) : (
            <ul className="space-y-1.5 text-xs">
              {diagnostics.map((d, i) => (
                <li
                  key={`${d.code}-${i}`}
                  className={`flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-1.5 ${
                    d.severity === "error"
                      ? "border-red-200 bg-red-50 text-red-800"
                      : "border-amber-200 bg-amber-50 text-amber-900"
                  }`}
                >
                  <div>
                    <code className="mr-2 font-bold">{d.code}</code>
                    <span>{d.message}</span>
                  </div>
                  {d.nodeId ? (
                    <button
                      type="button"
                      onClick={() => onSelectNode(d.nodeId!)}
                      className="rounded bg-white/80 px-2 py-0.5 font-mono text-[11px] font-semibold underline"
                    >
                      Jump to {d.nodeId}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
