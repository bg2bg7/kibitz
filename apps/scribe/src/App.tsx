import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BoardAnnotationColor, PromotionPiece } from "@suite/board-ui";
import { parsePgnGames, serializePgnGames, type PgnGameDocument } from "@suite/chess-core";
import {
  PGNA_MIME_TYPE,
  compilePgna,
  isValidSubtitleLang,
  packPgnaArchive,
  unpackPgnaArchive,
  validatePgnaPackage,
  type BoardOrientation,
  type ClipDefinition,
  type NodeId,
  type ParsedNodeTags,
  type PgnaManifest,
} from "@suite/pgna";
import { BoardStage } from "./components/BoardStage";
import { DraftsModal } from "./components/DraftsModal";
import { MoveTreePanel } from "./components/MoveTreePanel";
import { NodeInspector } from "./components/NodeInspector";
import { PreviewPlayer } from "./components/PreviewPlayer";
import { StudioHeader, type StudioMode } from "./components/StudioHeader";
import { TimelineDock } from "./components/TimelineDock";
import { decodeAudioMetadataBatch } from "./local/audioStudio";
import {
  deleteLocalDraft,
  listLocalDrafts,
  loadLocalDraft,
  saveLocalDraft,
  type DraftSummary,
} from "./local/draftStore";
import {
  createBlankDraft,
  createDemoItalianDraft,
  createDraftId,
  createLocalDraftManifest,
  type ScribeDraft,
} from "./local/draftWorkspace";
import {
  addNewGame,
  appendNodeToTimeline,
  cloneGames,
  collectReferencedClipIds,
  deleteGame,
  deleteNodeSubtree,
  indexStudyGames,
  playMoveAtNode,
  promoteVariation,
  removeTimelineOccurrenceFromNode,
  reorderTimelineEntries,
  toggleBoardArrow,
  toggleBoardHighlight,
  toggleNodeNag,
  updateAtTagDuration,
  updateNodeTags,
} from "./local/studyTree";
import { PublishModal } from "./publish/PublishModal";

const MAX_PGNA_IMPORT_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_PGN_IMPORT_BYTES = 5 * 1024 * 1024; // 5 MB

function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slugifyFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "pgna-study";
}

function pruneUnreferencedClipAssets(
  prev: ScribeDraft,
  nextGames: readonly PgnGameDocument[],
): {
  clips: Record<string, ClipDefinition>;
  audioByPath: Record<string, Uint8Array>;
  subtitlesByPath: Record<string, string>;
} {
  const referenced = collectReferencedClipIds(nextGames);
  const nextClips: Record<string, ClipDefinition> = {};
  const nextAudioByPath: Record<string, Uint8Array> = { ...prev.audioByPath };
  const nextSubtitlesByPath: Record<string, string> = { ...prev.subtitlesByPath };

  const keptAudioPaths = new Set<string>();
  const keptSubtitlePaths = new Set<string>();

  for (const [clipId, clip] of Object.entries(prev.manifest.clips)) {
    if (referenced.has(clipId)) {
      nextClips[clipId] = clip;
      keptAudioPaths.add(clip.path);
      if (clip.subtitles) {
        for (const subPath of Object.values(clip.subtitles)) {
          keptSubtitlePaths.add(subPath);
        }
      }
    }
  }

  for (const [clipId, clip] of Object.entries(prev.manifest.clips)) {
    if (!referenced.has(clipId)) {
      if (!keptAudioPaths.has(clip.path)) {
        delete nextAudioByPath[clip.path];
      }
      if (clip.subtitles) {
        for (const subPath of Object.values(clip.subtitles)) {
          if (!keptSubtitlePaths.has(subPath)) {
            delete nextSubtitlesByPath[subPath];
          }
        }
      }
    }
  }

  return {
    clips: nextClips,
    audioByPath: nextAudioByPath,
    subtitlesByPath: nextSubtitlesByPath,
  };
}

export function App() {
  const [draft, setDraft] = useState<ScribeDraft>(() => createDemoItalianDraft());
  const [selectedNodeId, setSelectedNodeId] = useState<NodeId>("g0");
  const [studioMode, setStudioMode] = useState<StudioMode>("author");
  const [annotationColor, setAnnotationColor] = useState<BoardAnnotationColor>("G");
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showDraftsModal, setShowDraftsModal] = useState(false);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [draftList, setDraftList] = useState<DraftSummary[]>([]);
  const [saveStatus, setSaveStatus] = useState("Local-only · Ready");
  const [statusBanner, setStatusBanner] = useState<{
    kind: "info" | "error";
    text: string;
  } | null>(null);
  const [waveformPeaksByClipId, setWaveformPeaksByClipId] = useState<Record<string, number[]>>({});

  // Dirty flag prevents startup auto-save from overwriting previously edited drafts in IndexedDB
  const isDirtyRef = useRef(false);
  const activeDraftIdRef = useRef(draft.id);
  const waveformDecodeTokenRef = useRef(0);

  useEffect(() => {
    activeDraftIdRef.current = draft.id;
  }, [draft.id]);

  // Helper to batch-decode waveform peaks for a draft with stale-draft cancellation
  const decodeWaveformsForDraft = useCallback(async (targetDraft: ScribeDraft) => {
    const token = ++waveformDecodeTokenRef.current;
    const items: Array<{ id: string; bytes: Uint8Array; fallbackDurationMs: number }> = [];
    for (const clip of Object.values(targetDraft.manifest.clips ?? {})) {
      const audioBytes = targetDraft.audioByPath[clip.path];
      if (audioBytes) {
        items.push({ id: clip.id, bytes: audioBytes, fallbackDurationMs: clip.durationMs });
      }
    }
    if (items.length === 0) {
      if (waveformDecodeTokenRef.current === token && activeDraftIdRef.current === targetDraft.id) {
        setWaveformPeaksByClipId({});
      }
      return;
    }
    const decoded = await decodeAudioMetadataBatch(items);
    if (waveformDecodeTokenRef.current !== token || activeDraftIdRef.current !== targetDraft.id) {
      return;
    }
    const peakEntries: Record<string, number[]> = {};
    for (const [id, meta] of Object.entries(decoded)) {
      peakEntries[id] = meta.peaks;
    }
    setWaveformPeaksByClipId(peakEntries);
  }, []);

  // Parse PGN AST & build node index
  const games = useMemo<PgnGameDocument[]>(() => {
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
  }, [draft.pgnText, draft.manifest.title]);

  const studyIndex = useMemo(() => indexStudyGames(games), [games]);

  const safeSelectedNodeId: NodeId = studyIndex.nodesById[selectedNodeId]
    ? selectedNodeId
    : (studyIndex.rootIds[0] ?? "g0");
  const activeNode = studyIndex.nodesById[safeSelectedNodeId]!;
  const activeGameOrientation: BoardOrientation =
    games[activeNode.gameIndex]?.headers["Orientation"]?.trim().toLowerCase() === "black"
      ? "black"
      : "white";

  // Live PGNA v1.0 compilation
  const compiled = useMemo(
    () =>
      compilePgna({
        manifest: draft.manifest,
        pgnText: draft.pgnText,
        subtitlesByPath: draft.subtitlesByPath,
      }),
    [draft.manifest, draft.pgnText, draft.subtitlesByPath],
  );

  const errorCount = compiled.diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = compiled.diagnostics.filter((d) => d.severity === "warning").length;

  // Refresh saved draft list
  const refreshDraftList = useCallback(async () => {
    try {
      const items = await listLocalDrafts();
      setDraftList(items);
    } catch {
      // ignore in restricted environments
    }
  }, []);

  // On startup, list saved drafts and auto-open the most recently edited local draft if present
  useEffect(() => {
    let cancelled = false;
    void listLocalDrafts()
      .then(async (items) => {
        if (cancelled) return;
        setDraftList(items);
        if (items.length > 0 && !isDirtyRef.current) {
          const mostRecent = await loadLocalDraft(items[0]!.id);
          if (!cancelled && mostRecent && !isDirtyRef.current) {
            isDirtyRef.current = false;
            activeDraftIdRef.current = mostRecent.id;
            setDraft(mostRecent);
            setSelectedNodeId("g0");
            setSaveStatus("Loaded saved draft (IndexedDB)");
            void decodeWaveformsForDraft(mostRecent);
          }
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [decodeWaveformsForDraft]);

  // Debounced IndexedDB auto-save (only after user mutations)
  useEffect(() => {
    if (!isDirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void saveLocalDraft(draft)
        .then(() => {
          setSaveStatus("Saved locally (IndexedDB)");
          void refreshDraftList();
        })
        .catch(() => {
          setSaveStatus("Local session (unsaved)");
        });
    }, 500);
    return () => clearTimeout(timer);
  }, [draft, refreshDraftList]);

  // Commit updated games AST back into serialized PGN text
  const commitGames = useCallback(
    (
      nextGames: PgnGameDocument[],
      nextNodeId?: NodeId,
      options?: { pruneOrphans?: boolean },
    ) => {
      const nextPgn = serializePgnGames(nextGames);
      const now = new Date().toISOString();
      isDirtyRef.current = true;
      setDraft((prev) => {
        if (options?.pruneOrphans) {
          const pruned = pruneUnreferencedClipAssets(prev, nextGames);
          return {
            ...prev,
            pgnText: nextPgn,
            manifest: { ...prev.manifest, updatedAt: now, clips: pruned.clips },
            audioByPath: pruned.audioByPath,
            subtitlesByPath: pruned.subtitlesByPath,
            updatedAt: now,
          };
        }
        return {
          ...prev,
          pgnText: nextPgn,
          manifest: { ...prev.manifest, updatedAt: now },
          updatedAt: now,
        };
      });
      if (nextNodeId) {
        setSelectedNodeId(nextNodeId);
      }
    },
    [],
  );

  // Navigation helpers
  const stepFirst = useCallback(() => {
    setSelectedNodeId(`g${activeNode.gameIndex}` as NodeId);
  }, [activeNode.gameIndex]);

  const stepPrev = useCallback(() => {
    if (activeNode.parentId) {
      setSelectedNodeId(activeNode.parentId);
    }
  }, [activeNode.parentId]);

  const stepNext = useCallback(() => {
    const firstChild = activeNode.childIds[0];
    if (firstChild) {
      setSelectedNodeId(firstChild);
    }
  }, [activeNode.childIds]);

  const stepLast = useCallback(() => {
    let cur = activeNode;
    while (cur.childIds[0]) {
      const next = studyIndex.nodesById[cur.childIds[0]];
      if (!next) break;
      cur = next;
    }
    setSelectedNodeId(cur.nodeId);
  }, [activeNode, studyIndex.nodesById]);

  // Keyboard move navigation in Author mode
  useEffect(() => {
    if (studioMode !== "author") return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        stepNext();
      } else if (e.key === "Home") {
        e.preventDefault();
        stepFirst();
      } else if (e.key === "End") {
        e.preventDefault();
        stepLast();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [studioMode, stepFirst, stepLast, stepNext, stepPrev]);

  // Board interactions
  const handleMove = (move: { from: string; to: string; promotion?: PromotionPiece }) => {
    const result = playMoveAtNode(games, safeSelectedNodeId, move);
    if (result) {
      commitGames(result.games, result.nextNodeId);
    }
  };

  const handleToggleArrow = (from: string, to: string, color: BoardAnnotationColor) => {
    commitGames(toggleBoardArrow(games, safeSelectedNodeId, from, to, color));
  };

  const handleToggleHighlight = (square: string, color: BoardAnnotationColor) => {
    commitGames(toggleBoardHighlight(games, safeSelectedNodeId, square, color));
  };

  const handleClearAnnotations = () => {
    commitGames(
      updateNodeTags(games, safeSelectedNodeId, (prev) => ({
        ...prev,
        arrows: [],
        highlights: [],
      })),
    );
  };

  const handleFlipBoard = () => {
    const nextOrient = activeNode.orientation === "white" ? "black" : "white";
    if (activeNode.tags.orientation !== null) {
      commitGames(
        updateNodeTags(games, safeSelectedNodeId, (prev) => ({
          ...prev,
          orientation: nextOrient,
        })),
      );
      return;
    }
    const cloned = cloneGames(games);
    const g = cloned[activeNode.gameIndex];
    if (g) {
      g.headers["Orientation"] = nextOrient;
      commitGames(cloned);
    }
  };

  // Node & variation mutations
  const handleUpdateNodeTags = (
    nodeId: NodeId,
    updater: (prev: ParsedNodeTags) => ParsedNodeTags,
  ) => {
    commitGames(updateNodeTags(games, nodeId, updater));
  };

  const handleToggleNag = (nodeId: NodeId, nag: string) => {
    commitGames(toggleNodeNag(games, nodeId, nag));
  };

  const handlePromoteVariation = (nodeId: NodeId) => {
    const res = promoteVariation(games, nodeId);
    commitGames(res.games, res.nextNodeId);
  };

  const handleDeleteSubtree = (nodeId: NodeId) => {
    const res = deleteNodeSubtree(games, nodeId);
    commitGames(res.games, res.fallbackNodeId, { pruneOrphans: true });
  };

  const nextTimestampMs =
    compiled.timeline.entries.length > 0
      ? compiled.timeline.totalDurationMs + (draft.manifest.compilation?.defaultGapMs ?? 0)
      : 0;

  const handleScheduleNode = (nodeId: NodeId, durMs?: number) => {
    commitGames(appendNodeToTimeline(games, nodeId, durMs, { nextTimestampMs }));
  };

  const handleRemoveAtTag = (nodeId: NodeId, atIndex: number) => {
    commitGames(removeTimelineOccurrenceFromNode(games, nodeId, atIndex));
  };

  const handleUpdateAtTagDuration = (
    nodeId: NodeId,
    atIndex: number,
    durMs: number | undefined,
  ) => {
    commitGames(updateAtTagDuration(games, nodeId, atIndex, durMs));
  };

  const handleReorderTimeline = (fromIndex: number, toIndex: number) => {
    commitGames(reorderTimelineEntries(games, compiled.timeline.entries, fromIndex, toIndex));
  };

  // Audio clip & subtitle mutations (enforcing max 1 clip per node)
  const handleAttachAudioClip = (
    nodeId: NodeId,
    clip: ClipDefinition,
    bytes: Uint8Array,
    peaks: number[],
  ) => {
    const existingNode = studyIndex.nodesById[nodeId];
    const shouldAutoSchedule = (existingNode?.tags.atTags.length ?? 0) === 0;

    let nextGames = updateNodeTags(games, nodeId, (prev) => ({
      ...prev,
      audioClipId: clip.id,
      // Clear any stale silent [%dur] so attaching audio never leaves an IGNORED_DUR_TAG warning
      durMs: null,
    }));
    if (shouldAutoSchedule) {
      nextGames = appendNodeToTimeline(nextGames, nodeId, undefined, { nextTimestampMs });
    }
    const nextPgn = serializePgnGames(nextGames);
    const now = new Date().toISOString();

    isDirtyRef.current = true;
    setWaveformPeaksByClipId((prev) => ({ ...prev, [clip.id]: peaks }));
    setDraft((prev) => {
      const nextAudioByPath = { ...prev.audioByPath, [clip.path]: bytes };
      const oldClip = prev.manifest.clips[clip.id];
      if (oldClip && oldClip.path !== clip.path) {
        const pathStillUsedByOtherClip = Object.entries(prev.manifest.clips).some(
          ([otherId, otherClip]) => otherId !== clip.id && otherClip.path === oldClip.path,
        );
        if (!pathStillUsedByOtherClip) {
          delete nextAudioByPath[oldClip.path];
        }
      }
      return {
        ...prev,
        pgnText: nextPgn,
        manifest: {
          ...prev.manifest,
          updatedAt: now,
          clips: {
            ...prev.manifest.clips,
            [clip.id]: clip,
          },
        },
        audioByPath: nextAudioByPath,
        updatedAt: now,
      };
    });
  };

  const handleUpdateClip = (clipId: string, updater: (prev: ClipDefinition) => ClipDefinition) => {
    isDirtyRef.current = true;
    const now = new Date().toISOString();
    setDraft((prev) => {
      const existing = prev.manifest.clips[clipId];
      if (!existing) return prev;
      return {
        ...prev,
        manifest: {
          ...prev.manifest,
          updatedAt: now,
          clips: {
            ...prev.manifest.clips,
            [clipId]: updater(existing),
          },
        },
        updatedAt: now,
      };
    });
  };

  const handleDetachAudioClip = (nodeId: NodeId) => {
    const node = studyIndex.nodesById[nodeId];
    const clipId = node?.tags.audioClipId;
    const nextGames = updateNodeTags(games, nodeId, (prev) => ({
      ...prev,
      audioClipId: null,
    }));
    const nextPgn = serializePgnGames(nextGames);
    const now = new Date().toISOString();

    // Check whether any other node still references this clipId before removing from manifest
    const stillUsed =
      clipId !== null &&
      clipId !== undefined &&
      Object.values(studyIndex.nodesById).some(
        (n) => n.nodeId !== nodeId && n.tags.audioClipId === clipId,
      );

    isDirtyRef.current = true;
    setDraft((prev) => {
      const nextClips = { ...prev.manifest.clips };
      const nextAudioByPath = { ...prev.audioByPath };
      const nextSubtitlesByPath = { ...prev.subtitlesByPath };
      if (clipId && !stillUsed) {
        const oldClip = nextClips[clipId];
        if (oldClip) {
          delete nextClips[clipId];
          const remainingClips = Object.values(nextClips);
          if (!remainingClips.some((c) => c.path === oldClip.path)) {
            delete nextAudioByPath[oldClip.path];
          }
          if (oldClip.subtitles) {
            const keptSubPaths = new Set<string>();
            for (const c of remainingClips) {
              for (const sp of Object.values(c.subtitles ?? {})) {
                keptSubPaths.add(sp);
              }
            }
            for (const subPath of Object.values(oldClip.subtitles)) {
              if (!keptSubPaths.has(subPath)) {
                delete nextSubtitlesByPath[subPath];
              }
            }
          }
        }
      }
      return {
        ...prev,
        pgnText: nextPgn,
        manifest: {
          ...prev.manifest,
          updatedAt: now,
          clips: nextClips,
        },
        audioByPath: nextAudioByPath,
        subtitlesByPath: nextSubtitlesByPath,
        updatedAt: now,
      };
    });
  };

  const handleUpdateSubtitle = (clipId: string, lang: string, vttText: string) => {
    const trimmedLang = lang.trim();
    if (!isValidSubtitleLang(trimmedLang)) {
      return;
    }
    const subPath = `subtitles/${trimmedLang}/${clipId}.vtt`;
    const now = new Date().toISOString();
    isDirtyRef.current = true;
    setDraft((prev) => {
      const clip = prev.manifest.clips[clipId];
      if (!clip) return prev;
      const nextSubtitles = { ...(clip.subtitles ?? {}) };
      const nextSubByPath = { ...prev.subtitlesByPath };
      if (vttText.trim() === "") {
        delete nextSubtitles[trimmedLang];
        delete nextSubByPath[subPath];
      } else {
        nextSubtitles[trimmedLang] = subPath;
        nextSubByPath[subPath] = vttText;
      }
      return {
        ...prev,
        manifest: {
          ...prev.manifest,
          updatedAt: now,
          clips: {
            ...prev.manifest.clips,
            [clipId]: {
              ...clip,
              ...(Object.keys(nextSubtitles).length > 0
                ? { subtitles: nextSubtitles }
                : { subtitles: undefined }),
            },
          },
        },
        subtitlesByPath: nextSubByPath,
        updatedAt: now,
      };
    });
  };

  const handleUpdateManifest = (updater: (prev: PgnaManifest) => PgnaManifest) => {
    const now = new Date().toISOString();
    isDirtyRef.current = true;
    setDraft((prev) => ({
      ...prev,
      manifest: { ...updater(prev.manifest), updatedAt: now },
      updatedAt: now,
    }));
  };

  // Multi-game chapter mutations
  const handleAddGame = (
    title: string,
    initialFen?: string,
    players?: { white?: string; black?: string },
  ) => {
    const res = addNewGame(games, title, initialFen, players);
    commitGames(res.games, res.rootNodeId);
  };

  const handleUpdateGameHeaders = (gameIndex: number, headers: Record<string, string>) => {
    const cloned = cloneGames(games);
    const target = cloned[gameIndex];
    if (!target) return;
    target.headers = headers;
    commitGames(cloned);
  };

  const handleDeleteGame = (gameIndex: number) => {
    const res = deleteGame(games, gameIndex);
    commitGames(res.games, res.fallbackNodeId, { pruneOrphans: true });
  };

  // Import .pgna or .pgn
  const handleImportFile = async (file: File) => {
    setStatusBanner(null);
    try {
      if (file.name.toLowerCase().endsWith(".pgna")) {
        if (file.size > MAX_PGNA_IMPORT_BYTES) {
          setStatusBanner({
            kind: "error",
            text: `Import failed: "${file.name}" exceeds the 50 MB .pgna import limit.`,
          });
          return;
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const unpacked = await unpackPgnaArchive(bytes);
        const validation = validatePgnaPackage(unpacked.entries);
        const importErrors = validation.diagnostics.filter((d) => d.severity === "error");
        const importWarnings = validation.diagnostics.filter((d) => d.severity === "warning");

        // Strip compiler-generated merged timeline.vtt entries so re-export never duplicates them
        const referencedSubPaths = new Set<string>();
        for (const clip of Object.values(unpacked.manifest.clips ?? {})) {
          for (const sp of Object.values(clip.subtitles ?? {})) {
            referencedSubPaths.add(sp);
          }
        }
        const mergedSubPaths = new Set<string>(
          Object.values(unpacked.timeline.mergedSubtitles ?? {}),
        );
        const perClipSubtitles: Record<string, string> = {};
        for (const [subPath, vtt] of Object.entries(unpacked.subtitlesByPath)) {
          if (
            referencedSubPaths.has(subPath) ||
            (!mergedSubPaths.has(subPath) && !/^subtitles\/[^/]+\/timeline\.vtt$/.test(subPath))
          ) {
            perClipSubtitles[subPath] = vtt;
          }
        }

        const importedDraft: ScribeDraft = {
          id: createDraftId(),
          manifest: unpacked.manifest,
          pgnText: unpacked.pgnText,
          audioByPath: unpacked.audioByPath,
          subtitlesByPath: perClipSubtitles,
          updatedAt: new Date().toISOString(),
        };
        isDirtyRef.current = true;
        activeDraftIdRef.current = importedDraft.id;
        setDraft(importedDraft);
        setSelectedNodeId("g0");
        setWaveformPeaksByClipId({});

        const clipCount = Object.keys(unpacked.manifest.clips ?? {}).length;
        if (importErrors.length > 0) {
          setShowDiagnostics(true);
          setStatusBanner({
            kind: "error",
            text: `Imported "${file.name}" (${clipCount} audio clips) with ${importErrors.length} validation error(s): ${importErrors[0]?.code ?? "INVALID"} — ${importErrors[0]?.message ?? ""}`,
          });
        } else if (importWarnings.length > 0) {
          setStatusBanner({
            kind: "info",
            text: `Imported PGNA archive "${file.name}" (${clipCount} audio clips, ${importWarnings.length} warning(s)).`,
          });
        } else {
          setStatusBanner({
            kind: "info",
            text: `Imported valid PGNA archive "${file.name}" (${clipCount} audio clips).`,
          });
        }

        void decodeWaveformsForDraft(importedDraft);
      } else {
        if (file.size > MAX_PGN_IMPORT_BYTES) {
          setStatusBanner({
            kind: "error",
            text: `Import failed: "${file.name}" exceeds the 5 MB .pgn import limit.`,
          });
          return;
        }
        const pgnText = await file.text();
        const title = file.name.replace(/\.pgn$/i, "") || "Imported PGN Study";
        const importedDraft: ScribeDraft = {
          id: createDraftId(),
          manifest: createLocalDraftManifest(title),
          pgnText,
          audioByPath: {},
          subtitlesByPath: {},
          updatedAt: new Date().toISOString(),
        };
        isDirtyRef.current = true;
        activeDraftIdRef.current = importedDraft.id;
        waveformDecodeTokenRef.current++;
        setDraft(importedDraft);
        setSelectedNodeId("g0");
        setWaveformPeaksByClipId({});
        setStatusBanner({
          kind: "info",
          text: `Imported PGN "${file.name}".`,
        });
      }
    } catch (err) {
      setStatusBanner({
        kind: "error",
        text: `Import failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  // Build validated .pgna ZIP bytes
  const buildArchiveBytes = async (): Promise<Uint8Array> => {
    const packed = await packPgnaArchive({
      manifest: draft.manifest,
      pgnText: draft.pgnText,
      audioByPath: draft.audioByPath,
      subtitlesByPath: draft.subtitlesByPath,
    });
    return packed.zipBytes;
  };

  const handleExportPgna = async () => {
    setStatusBanner(null);
    if (errorCount > 0) {
      setShowDiagnostics(true);
      setStatusBanner({
        kind: "error",
        text: `Fix ${errorCount} compiler error(s) in Diagnostics before exporting a valid .pgna archive.`,
      });
      return;
    }
    try {
      const zipBytes = await buildArchiveBytes();
      const copy = new Uint8Array(zipBytes.byteLength);
      copy.set(zipBytes);
      triggerBrowserDownload(
        new Blob([copy], { type: PGNA_MIME_TYPE }),
        `${slugifyFilename(draft.manifest.title || "study")}.pgna`,
      );
      setStatusBanner({
        kind: "info",
        text: `Exported valid PGNA v1.0 archive (${(zipBytes.byteLength / 1024).toFixed(1)} KB).`,
      });
    } catch (err) {
      setStatusBanner({
        kind: "error",
        text: `Export failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handleExportPgn = () => {
    triggerBrowserDownload(
      new Blob([draft.pgnText], { type: "application/x-chess-pgn" }),
      `${slugifyFilename(draft.manifest.title || "study")}.pgn`,
    );
  };

  // Draft management
  const handleCreateBlankDraft = () => {
    const blank = createBlankDraft("Untitled PGNA Study");
    isDirtyRef.current = true;
    activeDraftIdRef.current = blank.id;
    waveformDecodeTokenRef.current++;
    setDraft(blank);
    setSelectedNodeId("g0");
    setWaveformPeaksByClipId({});
  };

  const handleLoadDemo = () => {
    const demo = createDemoItalianDraft();
    isDirtyRef.current = false;
    activeDraftIdRef.current = demo.id;
    waveformDecodeTokenRef.current++;
    setDraft(demo);
    setSelectedNodeId("g0");
    setWaveformPeaksByClipId({});
    setSaveStatus("Demo loaded · Edit to save");
  };

  const handleOpenDraft = async (id: string) => {
    const loaded = await loadLocalDraft(id);
    if (loaded) {
      isDirtyRef.current = false;
      activeDraftIdRef.current = loaded.id;
      setDraft(loaded);
      setSelectedNodeId("g0");
      setWaveformPeaksByClipId({});
      setSaveStatus("Loaded saved draft (IndexedDB)");
      void decodeWaveformsForDraft(loaded);
    }
  };

  const handleDeleteDraft = async (id: string) => {
    await deleteLocalDraft(id);
    await refreshDraftList();
  };

  return (
    <div className="min-h-screen bg-slate-100/80 text-slate-900">
      <StudioHeader
        title={draft.manifest.title ?? ""}
        onChangeTitle={(nextTitle) =>
          handleUpdateManifest((prev) => ({ ...prev, title: nextTitle }))
        }
        studioMode={studioMode}
        onChangeStudioMode={setStudioMode}
        saveStatus={saveStatus}
        errorCount={errorCount}
        warningCount={warningCount}
        onToggleDiagnostics={() => setShowDiagnostics((v) => !v)}
        onOpenDrafts={() => {
          void refreshDraftList();
          setShowDraftsModal(true);
        }}
        onImportFile={(file) => void handleImportFile(file)}
        onExportPgna={() => void handleExportPgna()}
        onExportPgn={handleExportPgn}
        onOpenPublish={() => setShowPublishModal(true)}
      />

      <main className="mx-auto max-w-[1600px] space-y-4 p-4">
        {statusBanner ? (
          <div
            className={`flex items-center justify-between rounded-lg border px-3.5 py-2 text-xs ${
              statusBanner.kind === "error"
                ? "border-red-200 bg-red-50 text-red-800"
                : "border-sky-200 bg-sky-50 text-sky-900"
            }`}
          >
            <span>{statusBanner.text}</span>
            <button
              type="button"
              onClick={() => setStatusBanner(null)}
              className="ml-4 font-semibold opacity-70 hover:opacity-100"
            >
              Dismiss
            </button>
          </div>
        ) : null}

        {studioMode === "author" ? (
          <>
            <div className="grid gap-4 xl:grid-cols-[minmax(0,530px)_minmax(0,1fr)]">
              {/* Left Column: Board Stage */}
              <BoardStage
                games={games}
                activeGameIndex={activeNode.gameIndex}
                fen={activeNode.fen}
                lastMove={activeNode.lastMove}
                orientation={activeNode.orientation}
                arrows={activeNode.tags.arrows}
                highlights={activeNode.tags.highlights}
                annotationColor={annotationColor}
                onChangeAnnotationColor={setAnnotationColor}
                onMove={handleMove}
                onToggleArrow={handleToggleArrow}
                onToggleHighlight={handleToggleHighlight}
                onClearAnnotations={handleClearAnnotations}
                onFlipBoard={handleFlipBoard}
                onStepFirst={stepFirst}
                onStepPrev={stepPrev}
                onStepNext={stepNext}
                onStepLast={stepLast}
                onSelectGame={(idx) => setSelectedNodeId(`g${idx}` as NodeId)}
                onAddGame={handleAddGame}
                onUpdateGameHeaders={handleUpdateGameHeaders}
                onDeleteGame={handleDeleteGame}
                activeNodeId={safeSelectedNodeId}
              />

              {/* Right Column: Move Tree + Node Inspector */}
              <div className="flex min-w-0 flex-col gap-4">
                <MoveTreePanel
                  studyIndex={studyIndex}
                  activeGameIndex={activeNode.gameIndex}
                  selectedNodeId={safeSelectedNodeId}
                  timeline={compiled.timeline}
                  onSelectNode={setSelectedNodeId}
                  onPromoteVariation={handlePromoteVariation}
                  onDeleteSubtree={handleDeleteSubtree}
                  onScheduleNode={(nid) => handleScheduleNode(nid)}
                />

                <NodeInspector
                  node={activeNode}
                  gameOrientation={activeGameOrientation}
                  studyIndex={studyIndex}
                  manifest={draft.manifest}
                  timeline={compiled.timeline}
                  pgnText={draft.pgnText}
                  audioByPath={draft.audioByPath}
                  subtitlesByPath={draft.subtitlesByPath}
                  onUpdateNodeTags={handleUpdateNodeTags}
                  onToggleNag={handleToggleNag}
                  onScheduleNode={handleScheduleNode}
                  onRemoveAtTag={handleRemoveAtTag}
                  onUpdateAtTagDuration={handleUpdateAtTagDuration}
                  onAttachAudioClip={handleAttachAudioClip}
                  onUpdateClip={handleUpdateClip}
                  onDetachAudioClip={handleDetachAudioClip}
                  onUpdateSubtitle={handleUpdateSubtitle}
                  onUpdateManifest={handleUpdateManifest}
                  onApplyRawPgn={(nextPgn) => {
                    const now = new Date().toISOString();
                    isDirtyRef.current = true;
                    setDraft((prev) => ({
                      ...prev,
                      pgnText: nextPgn,
                      manifest: { ...prev.manifest, updatedAt: now },
                      updatedAt: now,
                    }));
                  }}
                  waveformPeaksByClipId={waveformPeaksByClipId}
                />
              </div>
            </div>

            {/* Bottom Dock: Compiled Linear Timeline + Diagnostics */}
            <TimelineDock
              timeline={compiled.timeline}
              selectedNodeId={safeSelectedNodeId}
              diagnostics={compiled.diagnostics}
              showDiagnostics={showDiagnostics}
              onToggleDiagnostics={() => setShowDiagnostics((v) => !v)}
              onSelectNode={setSelectedNodeId}
              onScheduleSelectedNode={() => handleScheduleNode(safeSelectedNodeId)}
              onReorderEntry={handleReorderTimeline}
            />
          </>
        ) : (
          <PreviewPlayer
            manifest={draft.manifest}
            timeline={compiled.timeline}
            audioByPath={draft.audioByPath}
            subtitlesByPath={draft.subtitlesByPath}
            mergedSubtitlesVtt={compiled.mergedSubtitlesVtt}
          />
        )}
      </main>

      <DraftsModal
        open={showDraftsModal}
        activeDraftId={draft.id}
        drafts={draftList}
        onClose={() => setShowDraftsModal(false)}
        onCreateBlank={handleCreateBlankDraft}
        onLoadDemo={handleLoadDemo}
        onOpenDraft={(id) => void handleOpenDraft(id)}
        onDeleteDraft={(id) => void handleDeleteDraft(id)}
      />

      <PublishModal
        open={showPublishModal}
        manifest={draft.manifest}
        onClose={() => setShowPublishModal(false)}
        onBuildArchive={buildArchiveBytes}
        onExportLocalPgna={() => void handleExportPgna()}
      />
    </div>
  );
}
