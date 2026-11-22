import {
  ChessPosition,
  INITIAL_FEN,
  validateFen,
  type PgnGameDocument,
  type PgnMoveNode,
} from "@suite/chess-core";
import {
  formatNodeComment,
  parseNodeComments,
  type AnnotationColor,
  type BoardOrientation,
  type LastMoveCoords,
  type NodeId,
  type ParsedNodeTags,
  type TimelineEntry,
} from "@suite/pgna";

export interface IndexedStudyNode {
  nodeId: NodeId;
  gameIndex: number;
  ply: number;
  moveNumber: number;
  turnMoved: "w" | "b" | null;
  san: string | null;
  fen: string;
  lastMove: LastMoveCoords | null;
  orientation: BoardOrientation;
  parentId: NodeId | null;
  childIds: NodeId[];
  siblingIndex: number;
  siblingCount: number;
  nags: string[];
  tags: ParsedNodeTags;
}

export interface StudyIndex {
  nodesById: Record<string, IndexedStudyNode>;
  rootIds: NodeId[];
}

function childNodeId(parentId: NodeId, childIdx: number): NodeId {
  return (parentId.includes("/") ? `${parentId}.${childIdx}` : `${parentId}/${childIdx}`) as NodeId;
}

function getFenMoveMeta(fen: string): { turn: "w" | "b"; moveNumber: number } {
  const parts = fen.trim().split(/\s+/);
  const turn: "w" | "b" = parts[1] === "b" ? "b" : "w";
  const parsed = parts[5] ? Number.parseInt(parts[5], 10) : 1;
  return { turn, moveNumber: Number.isFinite(parsed) && parsed >= 1 ? parsed : 1 };
}

/**
 * Indexes all games and moves in `PgnGameDocument[]` by canonical PGNA `NodeId`.
 */
export function indexStudyGames(games: readonly PgnGameDocument[]): StudyIndex {
  const nodesById: Record<string, IndexedStudyNode> = {};
  const rootIds: NodeId[] = [];

  const walkChildren = (
    pgnChildren: readonly PgnMoveNode[],
    parent: IndexedStudyNode,
    gameOrientation: BoardOrientation,
  ): void => {
    for (let i = 0; i < pgnChildren.length; i++) {
      const child = pgnChildren[i]!;
      const id = childNodeId(parent.nodeId, i);
      const { turn: turnMoved, moveNumber } = getFenMoveMeta(parent.fen);
      const pos = new ChessPosition(parent.fen);
      const applied = pos.tryMove(child.san);
      if (!applied) continue;

      const { tags } = parseNodeComments(child.comments, id);
      const indexed: IndexedStudyNode = {
        nodeId: id,
        gameIndex: parent.gameIndex,
        ply: parent.ply + 1,
        moveNumber,
        turnMoved,
        san: applied.san,
        fen: applied.fen,
        lastMove: { from: applied.from, to: applied.to },
        orientation: tags.orientation ?? gameOrientation,
        parentId: parent.nodeId,
        childIds: [],
        siblingIndex: i,
        siblingCount: pgnChildren.length,
        nags: [...child.nags],
        tags,
      };
      parent.childIds.push(id);
      nodesById[id] = indexed;
      walkChildren(child.children, indexed, gameOrientation);
    }
  };

  for (let gameIndex = 0; gameIndex < games.length; gameIndex++) {
    const game = games[gameIndex]!;
    const rawFen = game.headers["FEN"]?.trim();
    const initialFen = rawFen && validateFen(rawFen) ? rawFen : INITIAL_FEN;
    const gameOrientation: BoardOrientation =
      game.headers["Orientation"]?.trim().toLowerCase() === "black" ? "black" : "white";

    const rootId = `g${gameIndex}` as NodeId;
    const { tags } = parseNodeComments(game.rootComments, rootId);
    const { moveNumber } = getFenMoveMeta(initialFen);

    const rootNode: IndexedStudyNode = {
      nodeId: rootId,
      gameIndex,
      ply: 0,
      moveNumber,
      turnMoved: null,
      san: null,
      fen: initialFen,
      lastMove: null,
      orientation: tags.orientation ?? gameOrientation,
      parentId: null,
      childIds: [],
      siblingIndex: 0,
      siblingCount: 1,
      nags: [],
      tags,
    };

    rootIds.push(rootId);
    nodesById[rootId] = rootNode;
    walkChildren(game.rootMoves, rootNode, gameOrientation);
  }

  return { nodesById, rootIds };
}

function cloneMoveNode(node: PgnMoveNode): PgnMoveNode {
  return {
    san: node.san,
    nags: [...node.nags],
    comments: [...node.comments],
    children: node.children.map(cloneMoveNode),
  };
}

export function cloneGames(games: readonly PgnGameDocument[]): PgnGameDocument[] {
  return games.map((g) => ({
    headers: { ...g.headers },
    rootComments: [...g.rootComments],
    rootMoves: g.rootMoves.map(cloneMoveNode),
    result: g.result,
  }));
}

function parseNodePath(nodeId: NodeId): { gameIndex: number; steps: number[] } | null {
  const slashIdx = nodeId.indexOf("/");
  if (slashIdx === -1) {
    const gameIndex = Number.parseInt(nodeId.slice(1), 10);
    return Number.isFinite(gameIndex) ? { gameIndex, steps: [] } : null;
  }
  const gameIndex = Number.parseInt(nodeId.slice(1, slashIdx), 10);
  const steps = nodeId
    .slice(slashIdx + 1)
    .split(".")
    .map((s) => Number.parseInt(s, 10));
  if (!Number.isFinite(gameIndex) || steps.some((n) => !Number.isFinite(n))) {
    return null;
  }
  return { gameIndex, steps };
}

function locateNodeInGames(
  games: PgnGameDocument[],
  nodeId: NodeId,
): {
  game: PgnGameDocument;
  node: PgnMoveNode | null;
  parentChildren: PgnMoveNode[];
  indexInParent: number;
} | null {
  const parsed = parseNodePath(nodeId);
  if (!parsed) return null;
  const game = games[parsed.gameIndex];
  if (!game) return null;

  if (parsed.steps.length === 0) {
    return { game, node: null, parentChildren: game.rootMoves, indexInParent: -1 };
  }

  let siblings = game.rootMoves;
  let current: PgnMoveNode | null = null;
  let lastIdx = -1;

  for (let i = 0; i < parsed.steps.length; i++) {
    const idx = parsed.steps[i]!;
    const next = siblings[idx];
    if (!next) return null;
    if (i === parsed.steps.length - 1) {
      return { game, node: next, parentChildren: siblings, indexInParent: idx };
    }
    current = next;
    lastIdx = idx;
    siblings = current.children;
  }

  return current ? { game, node: current, parentChildren: siblings, indexInParent: lastIdx } : null;
}

/**
 * Plays a legal chess move from `nodeId`.
 * - If an identical child move already exists, navigates to it without duplicating.
 * - Otherwise appends it (mainline if first child, or new RAV variation if sibling exists).
 */
export function playMoveAtNode(
  games: readonly PgnGameDocument[],
  nodeId: NodeId,
  move: { from: string; to: string; promotion?: "q" | "r" | "b" | "n" },
): { games: PgnGameDocument[]; nextNodeId: NodeId } | null {
  const index = indexStudyGames(games);
  const current = index.nodesById[nodeId];
  if (!current) return null;

  const pos = new ChessPosition(current.fen);
  const applied = pos.tryMove(move);
  if (!applied) return null;

  const cloned = cloneGames(games);
  const located = locateNodeInGames(cloned, nodeId);
  if (!located) return null;

  const targetChildren = located.node ? located.node.children : located.game.rootMoves;
  const existingIdx = targetChildren.findIndex((c) => c.san === applied.san);
  if (existingIdx !== -1) {
    return {
      games: cloned,
      nextNodeId: childNodeId(nodeId, existingIdx),
    };
  }

  targetChildren.push({
    san: applied.san,
    nags: [],
    comments: [],
    children: [],
  });

  return {
    games: cloned,
    nextNodeId: childNodeId(nodeId, targetChildren.length - 1),
  };
}

/**
 * Updates the parsed PGNA tags/prose on a node losslessly and rewrites its comment block.
 */
export function updateNodeTags(
  games: readonly PgnGameDocument[],
  nodeId: NodeId,
  updater: (prev: ParsedNodeTags) => ParsedNodeTags,
): PgnGameDocument[] {
  const cloned = cloneGames(games);
  const located = locateNodeInGames(cloned, nodeId);
  if (!located) return cloned;

  const existingComments = located.node ? located.node.comments : located.game.rootComments;
  const { tags } = parseNodeComments(existingComments, nodeId);
  const updated = updater(tags);
  const formatted = formatNodeComment(updated);
  const nextComments = formatted.length > 0 ? [formatted] : [];

  if (located.node) {
    located.node.comments = nextComments;
  } else {
    located.game.rootComments = nextComments;
  }

  return cloned;
}

export function toggleNodeNag(
  games: readonly PgnGameDocument[],
  nodeId: NodeId,
  nag: string,
): PgnGameDocument[] {
  const cloned = cloneGames(games);
  const located = locateNodeInGames(cloned, nodeId);
  if (!located?.node) return cloned;

  const ASSESSMENT_NAGS = new Set(["$1", "$2", "$3", "$4", "$5", "$6"]);
  const hasNag = located.node.nags.includes(nag);
  if (hasNag) {
    located.node.nags = located.node.nags.filter((n) => n !== nag);
  } else if (ASSESSMENT_NAGS.has(nag)) {
    located.node.nags = [...located.node.nags.filter((n) => !ASSESSMENT_NAGS.has(n)), nag];
  } else {
    located.node.nags = [...located.node.nags, nag];
  }
  return cloned;
}

export function toggleBoardArrow(
  games: readonly PgnGameDocument[],
  nodeId: NodeId,
  from: string,
  to: string,
  color: AnnotationColor,
): PgnGameDocument[] {
  return updateNodeTags(games, nodeId, (tags) => {
    const exists = tags.arrows.some((a) => a.from === from && a.to === to && a.color === color);
    const filtered = tags.arrows.filter((a) => !(a.from === from && a.to === to));
    return {
      ...tags,
      arrows: exists ? filtered : [...filtered, { color, from, to }],
    };
  });
}

export function toggleBoardHighlight(
  games: readonly PgnGameDocument[],
  nodeId: NodeId,
  square: string,
  color: AnnotationColor,
): PgnGameDocument[] {
  return updateNodeTags(games, nodeId, (tags) => {
    const exists = tags.highlights.some((h) => h.square === square && h.color === color);
    const filtered = tags.highlights.filter((h) => h.square !== square);
    return {
      ...tags,
      highlights: exists ? filtered : [...filtered, { color, square }],
    };
  });
}

/**
 * Promotes a variation one step closer to mainline (swapping with previous sibling, or promoting to mainline).
 */
export function promoteVariation(
  games: readonly PgnGameDocument[],
  nodeId: NodeId,
): { games: PgnGameDocument[]; nextNodeId: NodeId } {
  const cloned = cloneGames(games);
  const located = locateNodeInGames(cloned, nodeId);
  if (!located?.node || located.indexInParent <= 0) {
    return { games: cloned, nextNodeId: nodeId };
  }

  const idx = located.indexInParent;
  const [moved] = located.parentChildren.splice(idx, 1);
  if (!moved) return { games: cloned, nextNodeId: nodeId };
  located.parentChildren.splice(idx - 1, 0, moved);

  const parsed = parseNodePath(nodeId)!;
  const nextSteps = [...parsed.steps];
  nextSteps[nextSteps.length - 1] = idx - 1;
  const nextNodeId = `g${parsed.gameIndex}/${nextSteps.join(".")}` as NodeId;
  return { games: cloned, nextNodeId };
}

/**
 * Deletes a move node and its entire subtree, returning its parent NodeId.
 */
export function deleteNodeSubtree(
  games: readonly PgnGameDocument[],
  nodeId: NodeId,
): { games: PgnGameDocument[]; fallbackNodeId: NodeId } {
  const cloned = cloneGames(games);
  const located = locateNodeInGames(cloned, nodeId);
  if (!located?.node || located.indexInParent < 0) {
    return { games: cloned, fallbackNodeId: nodeId };
  }

  located.parentChildren.splice(located.indexInParent, 1);
  const parsed = parseNodePath(nodeId)!;
  if (parsed.steps.length <= 1) {
    return { games: cloned, fallbackNodeId: `g${parsed.gameIndex}` as NodeId };
  }
  const parentSteps = parsed.steps.slice(0, -1);
  return {
    games: cloned,
    fallbackNodeId: `g${parsed.gameIndex}/${parentSteps.join(".")}` as NodeId,
  };
}

/**
 * Finds the next available `#N` integer ordinal across all games.
 */
export function getNextTimelineOrdinal(games: readonly PgnGameDocument[]): number {
  const index = indexStudyGames(games);
  let maxOrd = 0;
  for (const node of Object.values(index.nodesById)) {
    for (const at of node.tags.atTags) {
      if (at.mode === "ordinal" && at.value > maxOrd) {
        maxOrd = Math.floor(at.value);
      }
    }
  }
  return maxOrd + 1;
}

/**
 * Appends a new `[%at #N]` (or `[%at #N dur=...]`) tag to `nodeId`.
 * Works both for initial scheduling AND for adding a silent return/revisit pause to an already-scheduled node!
 */
export function appendNodeToTimeline(
  games: readonly PgnGameDocument[],
  nodeId: NodeId,
  durMs?: number,
): PgnGameDocument[] {
  const nextOrd = getNextTimelineOrdinal(games);
  return updateNodeTags(games, nodeId, (tags) => ({
    ...tags,
    atTags: [
      ...tags.atTags,
      {
        mode: "ordinal",
        value: nextOrd,
        ...(durMs !== undefined ? { durMs } : {}),
        rawSpec: `#${nextOrd}`,
      },
    ],
  }));
}

/**
 * Removes a specific `[%at]` tag occurrence from `nodeId`.
 */
export function removeTimelineOccurrenceFromNode(
  games: readonly PgnGameDocument[],
  nodeId: NodeId,
  atTagIndex: number,
): PgnGameDocument[] {
  return updateNodeTags(games, nodeId, (tags) => ({
    ...tags,
    atTags: tags.atTags.filter((_, idx) => idx !== atTagIndex),
  }));
}

/**
 * Updates `dur=` override on a specific `[%at]` tag occurrence of `nodeId`.
 */
export function updateAtTagDuration(
  games: readonly PgnGameDocument[],
  nodeId: NodeId,
  atTagIndex: number,
  durMs: number | undefined,
): PgnGameDocument[] {
  return updateNodeTags(games, nodeId, (tags) => ({
    ...tags,
    atTags: tags.atTags.map((at, idx) => {
      if (idx !== atTagIndex) return at;
      const next = { ...at };
      if (durMs === undefined) {
        delete next.durMs;
      } else {
        next.durMs = durMs;
      }
      return next;
    }),
  }));
}

/**
 * Reorders compiled timeline entries by moving `fromIndex` to `toIndex`, cleanly normalizing
 * all `[%at]` tags across the study to sequential `#1, #2, ..., #K` ordinals while preserving
 * each occurrence's `dur=` override.
 */
export function reorderTimelineEntries(
  games: readonly PgnGameDocument[],
  entries: readonly TimelineEntry[],
  fromIndex: number,
  toIndex: number,
): PgnGameDocument[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= entries.length ||
    toIndex >= entries.length
  ) {
    return cloneGames(games);
  }

  const index = indexStudyGames(games);

  // Pair each compiled entry with its corresponding durMs from the source node's sorted atTags
  const occurrenceCounters = new Map<string, number>();
  const orderedDescriptors = entries.map((entry) => {
    const occNum = occurrenceCounters.get(entry.nodeId) ?? 0;
    occurrenceCounters.set(entry.nodeId, occNum + 1);
    const node = index.nodesById[entry.nodeId];
    const sortedAt = [...(node?.tags.atTags ?? [])].sort((a, b) => a.value - b.value);
    const matchingAt = sortedAt[occNum];
    return {
      nodeId: entry.nodeId,
      durMs: matchingAt?.durMs,
    };
  });

  const [moved] = orderedDescriptors.splice(fromIndex, 1);
  if (!moved) return cloneGames(games);
  orderedDescriptors.splice(toIndex, 0, moved);

  // Rebuild atTags per nodeId with clean #1..#K ordinals
  const newAtTagsByNode = new Map<NodeId, ParsedNodeTags["atTags"]>();
  orderedDescriptors.forEach((desc, idx) => {
    const ord = idx + 1;
    let list = newAtTagsByNode.get(desc.nodeId);
    if (!list) {
      list = [];
      newAtTagsByNode.set(desc.nodeId, list);
    }
    list.push({
      mode: "ordinal",
      value: ord,
      ...(desc.durMs !== undefined ? { durMs: desc.durMs } : {}),
      rawSpec: `#${ord}`,
    });
  });

  let updatedGames = cloneGames(games);
  for (const nodeId of Object.keys(index.nodesById) as NodeId[]) {
    const nextAtTags = newAtTagsByNode.get(nodeId);
    if (nextAtTags !== undefined || (index.nodesById[nodeId]?.tags.atTags.length ?? 0) > 0) {
      updatedGames = updateNodeTags(updatedGames, nodeId, (tags) => ({
        ...tags,
        atTags: nextAtTags ?? [],
      }));
    }
  }
  return updatedGames;
}

export function addNewGame(
  games: readonly PgnGameDocument[],
  title?: string,
  initialFen?: string,
): { games: PgnGameDocument[]; rootNodeId: NodeId } {
  const cloned = cloneGames(games);
  const nextIdx = cloned.length;
  const headers: Record<string, string> = {
    Event: title?.trim() || `Chapter ${nextIdx + 1}`,
    Site: "Scribe Studio",
    White: "White",
    Black: "Black",
    Orientation: "white",
    Result: "*",
  };
  if (initialFen && initialFen.trim() !== "" && initialFen.trim() !== INITIAL_FEN) {
    headers["FEN"] = initialFen.trim();
    headers["SetUp"] = "1";
  }
  cloned.push({
    headers,
    rootComments: [],
    rootMoves: [],
    result: "*",
  });
  return { games: cloned, rootNodeId: `g${nextIdx}` as NodeId };
}

export function deleteGame(
  games: readonly PgnGameDocument[],
  gameIndex: number,
): { games: PgnGameDocument[]; fallbackNodeId: NodeId } {
  if (games.length <= 1) {
    return { games: cloneGames(games), fallbackNodeId: "g0" };
  }
  const cloned = cloneGames(games);
  cloned.splice(gameIndex, 1);
  const nextGameIdx = Math.max(0, Math.min(gameIndex, cloned.length - 1));
  return { games: cloned, fallbackNodeId: `g${nextGameIdx}` as NodeId };
}
