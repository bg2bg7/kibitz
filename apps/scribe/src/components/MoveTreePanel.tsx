import type { ReactNode } from "react";
import type { NodeId, PgnaTimeline } from "@suite/pgna";
import type { IndexedStudyNode, StudyIndex } from "../local/studyTree";

export interface MoveTreePanelProps {
  studyIndex: StudyIndex;
  activeGameIndex: number;
  selectedNodeId: NodeId;
  timeline: PgnaTimeline;
  onSelectNode: (nodeId: NodeId) => void;
  onPromoteVariation: (nodeId: NodeId) => void;
  onDeleteSubtree: (nodeId: NodeId) => void;
  onScheduleNode: (nodeId: NodeId) => void;
}

const NAG_DISPLAY: Record<string, string> = {
  $1: "!",
  $2: "?",
  $3: "!!",
  $4: "??",
  $5: "!?",
  $6: "?!",
};

function formatNags(nags: readonly string[]): string {
  return nags.map((n) => NAG_DISPLAY[n] ?? n).join("");
}

export function MoveTreePanel({
  studyIndex,
  activeGameIndex,
  selectedNodeId,
  timeline,
  onSelectNode,
  onPromoteVariation,
  onDeleteSubtree,
  onScheduleNode,
}: MoveTreePanelProps) {
  const rootId = `g${activeGameIndex}` as NodeId;
  const rootNode = studyIndex.nodesById[rootId];
  const selectedNode = studyIndex.nodesById[selectedNodeId];

  const renderNodePill = (node: IndexedStudyNode, showMoveNum: boolean) => {
    const isSelected = node.nodeId === selectedNodeId;
    const idxEntry = timeline.nodeIndex[node.nodeId];
    const timelineIndices = idxEntry?.timelineIndices ?? [];
    const hasAudio = node.tags.audioClipId !== null;
    const hasGuess = node.tags.guess !== null;

    const movePrefix =
      node.san === null
        ? "Start"
        : node.turnMoved === "w"
          ? `${node.moveNumber}. ${node.san}`
          : showMoveNum
            ? `${node.moveNumber}... ${node.san}`
            : node.san;

    return (
      <button
        key={node.nodeId}
        type="button"
        onClick={() => onSelectNode(node.nodeId)}
        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition ${
          isSelected
            ? "bg-sky-600 font-semibold text-white shadow-xs"
            : "text-slate-800 hover:bg-slate-100"
        }`}
      >
        <span>
          {movePrefix}
          {node.nags.length > 0 ? (
            <span className={isSelected ? "text-amber-200" : "font-bold text-amber-700"}>
              {formatNags(node.nags)}
            </span>
          ) : null}
        </span>

        {hasAudio ? (
          <span
            title={`Audio: ${node.tags.audioClipId}`}
            className={`text-[10px] ${isSelected ? "text-emerald-200" : "text-emerald-600"}`}
          >
            ●
          </span>
        ) : null}

        {timelineIndices.map((tIdx, occIdx) => (
          <span
            key={`${node.nodeId}-t-${tIdx}`}
            title={
              occIdx === 0
                ? `Timeline entry #${tIdx + 1}`
                : `Silent return pause #${tIdx + 1}`
            }
            className={`rounded px-1 text-[10px] font-semibold ${
              occIdx === 0
                ? isSelected
                  ? "bg-white/20 text-white"
                  : "bg-sky-100 text-sky-800"
                : isSelected
                  ? "bg-amber-300/30 text-amber-100"
                  : "bg-amber-100 text-amber-800"
            }`}
          >
            {occIdx === 0 ? `#${tIdx + 1}` : `↩#${tIdx + 1}`}
          </span>
        ))}

        {hasGuess ? (
          <span
            title="Interactive [%guess] prompt"
            className={`rounded px-1 text-[10px] font-bold ${
              isSelected ? "bg-violet-300/30 text-white" : "bg-violet-100 text-violet-800"
            }`}
          >
            ?
          </span>
        ) : null}
      </button>
    );
  };

  const renderLine = (
    firstNodeId: NodeId,
    depth: number,
  ): ReactNode => {
    const items: ReactNode[] = [];
    let currentId: NodeId | undefined = firstNodeId;
    let forceMoveNum = true;

    while (currentId) {
      const node: IndexedStudyNode | undefined = studyIndex.nodesById[currentId];
      if (!node) break;

      items.push(renderNodePill(node, forceMoveNum));

      if (node.tags.prose) {
        items.push(
          <span
            key={`${node.nodeId}-prose`}
            className="mx-1 max-w-[180px] truncate text-[11px] italic text-slate-500"
            title={node.tags.prose}
          >
            {node.tags.prose}
          </span>,
        );
      }

      // Render sibling RAV variations attached to node's parent right after node (if node is child 0)
      const parent = node.parentId ? studyIndex.nodesById[node.parentId] : undefined;
      const siblingVariations =
        parent && node.siblingIndex === 0 ? parent.childIds.slice(1) : [];

      if (siblingVariations.length > 0) {
        items.push(
          <div
            key={`${node.nodeId}-ravs`}
            className="my-1 ml-3 w-full space-y-1 border-l-2 border-slate-200 pl-2.5"
          >
            {siblingVariations.map((ravId) => (
              <div key={ravId} className="flex flex-wrap items-center gap-0.5 text-slate-700">
                <span className="mr-0.5 text-[11px] text-slate-400">(</span>
                {renderLine(ravId, depth + 1)}
                <span className="ml-0.5 text-[11px] text-slate-400">)</span>
              </div>
            ))}
          </div>,
        );
        forceMoveNum = true;
      } else {
        forceMoveNum = Boolean(node.tags.prose);
      }

      currentId = node.childIds[0];
    }

    return items;
  };

  const canPromote = Boolean(selectedNode && selectedNode.ply > 0 && selectedNode.siblingIndex > 0);
  const canDelete = Boolean(selectedNode && selectedNode.ply > 0);

  return (
    <div className="flex flex-col rounded-xl border border-slate-200 bg-white shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Move Tree &amp; Variations
          </h2>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onScheduleNode(selectedNodeId)}
            className="rounded border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-800 hover:bg-sky-100"
            title="Append selected move to timeline (or add a silent return pause if already scheduled)"
          >
            {(timeline.nodeIndex[selectedNodeId]?.timelineIndices.length ?? 0) > 0
              ? "+ Return Pause"
              : "+ Timeline"}
          </button>
          {canPromote ? (
            <button
              type="button"
              onClick={() => onPromoteVariation(selectedNodeId)}
              className="rounded border border-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
            >
              Promote
            </button>
          ) : null}
          {canDelete ? (
            <button
              type="button"
              onClick={() => onDeleteSubtree(selectedNodeId)}
              className="rounded border border-red-200 px-2 py-0.5 text-[11px] font-medium text-red-600 hover:bg-red-50"
            >
              Delete
            </button>
          ) : null}
        </div>
      </div>

      <div className="max-h-[280px] overflow-y-auto p-3">
        {rootNode ? (
          <div className="flex flex-wrap items-center gap-1">
            {renderNodePill(rootNode, true)}
            {rootNode.tags.prose ? (
              <span className="mx-1 text-[11px] italic text-slate-500">{rootNode.tags.prose}</span>
            ) : null}
            {rootNode.childIds.length > 0 ? (
              <div className="mt-1 flex w-full flex-wrap items-center gap-0.5">
                {renderLine(rootNode.childIds[0]!, 0)}
              </div>
            ) : (
              <p className="mt-2 w-full text-xs text-slate-400">
                Play moves on the board to build the mainline and variations.
              </p>
            )}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 bg-slate-50/70 px-3.5 py-1.5 text-[10px] text-slate-500">
        <span>
          <span className="text-emerald-600">●</span> Audio attached
        </span>
        <span>
          <span className="rounded bg-sky-100 px-1 font-semibold text-sky-800">#N</span> Primary
          visit
        </span>
        <span>
          <span className="rounded bg-amber-100 px-1 font-semibold text-amber-800">↩#N</span>{" "}
          Silent return pause
        </span>
        <span>
          <span className="rounded bg-violet-100 px-1 font-bold text-violet-800">?</span> Guess
          prompt
        </span>
      </div>
    </div>
  );
}
