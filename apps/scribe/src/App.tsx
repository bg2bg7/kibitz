import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BoardAnnotationColor, PromotionPiece } from "@suite/board-ui";
import { parsePgnGames, serializePgnGames, type PgnGameDocument } from "@suite/chess-core";
import {
  PGNA_MIME_TYPE,
  PgnaPackError,
  compilePgna,
  unpackPgnaArchive,
  validatePgnaPackage,
  type BoardOrientation,
  type ClipDefinition,
  type NodeId,
  type ParsedNodeTags,
  type PgnaManifest,
} from "@suite/pgna";
import { fetchKibitzSession, type KibitzSessionUser } from "@suite/ui";
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
  getDraftStorageMode,
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
import {
  applyAudioClipAttachment,
  applySubtitleUpdate,
  buildImportedPgnaDraft,
  buildValidatedPgnaArchive,
  createWorkspaceController,
  formatPgnaExportError,
  formatSaveStatus,
  type AudioClipAttachmentTemplate,
  type WorkspaceController,
} from "./local/workspaceTransitions";
import { PublishModal, type PublishSubmitInput } from "./publish/PublishModal";
import {
  INITIAL_PUBLISH_JOB_STATE,
  createPublishSessionController,
  type PublishJobState,
  type PublishSessionController,
  type PublishToKibitzResult,
} from "./publish/kibitzPublisher";

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

const VITE_ENV = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

export function App() {
  const [draft, setDraft] = useState<ScribeDraft>(() => createDemoItalianDraft());
  const [selectedNodeId, setSelectedNodeId] = useState<NodeId>("g0");
  const [studioMode, setStudioMode] = useState<StudioMode>("author");
  const [annotationColor, setAnnotationColor] = useState<BoardAnnotationColor>("G");
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showDraftsModal, setShowDraftsModal] = useState(false);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [publishState, setPublishState] = useState<PublishJobState>(INITIAL_PUBLISH_JOB_STATE);
  const [sessionUser, setSessionUser] = useState<KibitzSessionUser | null>(null);
  const [draftList, setDraftList] = useState<DraftSummary[]>([]);
  const [saveStatus, setSaveStatus] = useState(() => formatSaveStatus("idle-demo"));
  const [statusBanner, setStatusBanner] = useState<{
    kind: "info" | "error";
    text: string;
  } | null>(null);
  const [waveformPeaksByClipId, setWaveformPeaksByClipId] = useState<Record<string, number[]>>({});

  // Always-fresh draft/session references + unified workspace & publish controllers
  const draftRef = useRef<ScribeDraft>(draft);
  const sessionUserRef = useRef<KibitzSessionUser | null>(sessionUser);
  const waveformDecodeTokenRef = useRef(0);
  const refreshDraftListRef = useRef<() => Promise<void>>(async () => undefined);
  const workspaceControllerRef = useRef<WorkspaceController | null>(null);
  const publishControllerRef = useRef<PublishSessionController | null>(null);

  const getPublishController = useCallback((): PublishSessionController => {
    if (!publishControllerRef.current) {
      publishControllerRef.current = createPublishSessionController({
        onStateChange: setPublishState,
        onUnauthorized: () => {
          setSessionUser(null);
        },
      });
    }
    return publishControllerRef.current;
  }, []);

  const getWorkspaceController = useCallback((): WorkspaceController => {
    if (!workspaceControllerRef.current) {
      workspaceControllerRef.current = createWorkspaceController({
        getDraft: () => draftRef.current,
        setDraft: (nextDraft) => {
          draftRef.current = nextDraft;
          setDraft(nextDraft);
        },
        saveDraft: saveLocalDraft,
        getStorageMode: getDraftStorageMode,
        debounceMs: 500,
        onSaveStatus: setSaveStatus,
        onAfterSave: () => refreshDraftListRef.current(),
        onSaveError: (err) => {
          setStatusBanner({
            kind: "error",
            text: `Local save failed (${err instanceof Error ? err.message : String(err)}). Your study is still open — export a .pgna archive to keep your changes.`,
          });
        },
      });
    }
    return workspaceControllerRef.current;
  }, []);

  useEffect(() => {
    draftRef.current = draft;
    publishControllerRef.current?.syncActiveDraft(draft.id);
  }, [draft]);

  useEffect(() => {
    sessionUserRef.current = sessionUser;
  }, [sessionUser]);

  useEffect(() => {
    return () => {
      workspaceControllerRef.current?.dispose();
      workspaceControllerRef.current = null;
    };
  }, []);

  // Centralized draft mutation helper: keeps draftRef synchronously updated for flush & concurrent edits
  const applyDraftUpdate = useCallback(
    (updater: (prev: ScribeDraft) => ScribeDraft | null, options?: { markDirty?: boolean }) => {
      const next = updater(draftRef.current);
      if (!next || next === draftRef.current) {
        return null;
      }
      draftRef.current = next;
      setDraft(next);
      if (options?.markDirty !== false) {
        getWorkspaceController().markDirty();
      }
      return next;
    },
    [getWorkspaceController],
  );

  // Fetch active cross-service Kibitz ID session (non-blocking; authoring works offline/signed out)
  useEffect(() => {
    let mounted = true;
    void fetchKibitzSession({ env: VITE_ENV }).then((session) => {
      if (!mounted) return;
      if (session.authenticated && session.user) {
        setSessionUser(session.user);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  const handleSessionChange = useCallback(
    (nextUser: KibitzSessionUser | null) => {
      setSessionUser(nextUser);
      if (nextUser) {
        applyDraftUpdate(
          (prev) => {
            if ((prev.manifest.author ?? "").trim() !== "") return prev;
            return {
              ...prev,
              manifest: {
                ...prev.manifest,
                author: `@${nextUser.handle}`,
              },
            };
          },
          { markDirty: false },
        );
      }
    },
    [applyDraftUpdate],
  );

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
      if (waveformDecodeTokenRef.current === token && draftRef.current.id === targetDraft.id) {
        setWaveformPeaksByClipId({});
      }
      return;
    }
    const decoded = await decodeAudioMetadataBatch(items);
    if (waveformDecodeTokenRef.current !== token || draftRef.current.id !== targetDraft.id) {
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

  useEffect(() => {
    refreshDraftListRef.current = refreshDraftList;
  }, [refreshDraftList]);

  // On startup, list saved drafts and auto-open the most recently edited local draft if present
  useEffect(() => {
    let cancelled = false;
    const controller = getWorkspaceController();
    const startupGen = controller.getGeneration();
    void listLocalDrafts()
      .then(async (items) => {
        if (cancelled) return;
        setDraftList(items);
        if (items.length > 0 && !controller.isDirty() && controller.getGeneration() === startupGen) {
          const mostRecent = await loadLocalDraft(items[0]!.id);
          if (!cancelled && mostRecent) {
            const committed = controller.commitIfGenerationMatches(startupGen, {
              draft: mostRecent,
              dirty: false,
            });
            if (committed) {
              setSelectedNodeId("g0");
              setWaveformPeaksByClipId({});
              void decodeWaveformsForDraft(mostRecent);
            }
          }
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [decodeWaveformsForDraft, getWorkspaceController]);

  // Commit updated games AST back into serialized PGN text
  const commitGames = useCallback(
    (
      nextGames: PgnGameDocument[],
      nextNodeId?: NodeId,
      options?: { pruneOrphans?: boolean },
    ) => {
      const nextPgn = serializePgnGames(nextGames);
      const now = new Date().toISOString();
      applyDraftUpdate((prev) => {
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
    [applyDraftUpdate],
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

  // Audio clip & subtitle mutations (draft-identity guarded & applied against live state)
  const handleAttachAudioClip = useCallback(
    (params: {
      targetDraftId: string;
      nodeId: NodeId;
      requestedClipId: string | null;
      clipTemplate: AudioClipAttachmentTemplate;
      bytes: Uint8Array;
      peaks: number[];
    }) => {
      const applied = applyAudioClipAttachment(draftRef.current, {
        targetDraftId: params.targetDraftId,
        nodeId: params.nodeId,
        requestedClipId: params.requestedClipId,
        clipTemplate: params.clipTemplate,
        bytes: params.bytes,
      });
      if (!applied) {
        return;
      }
      draftRef.current = applied.draft;
      setDraft(applied.draft);
      setWaveformPeaksByClipId((prev) => ({ ...prev, [applied.clipId]: params.peaks }));
      getWorkspaceController().markDirty();
    },
    [getWorkspaceController],
  );

  const handleUpdateClip = useCallback(
    (clipId: string, updater: (prev: ClipDefinition) => ClipDefinition) => {
      const now = new Date().toISOString();
      applyDraftUpdate((prev) => {
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
    },
    [applyDraftUpdate],
  );

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

    applyDraftUpdate((prev) => {
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

  const handleUpdateSubtitle = useCallback(
    (clipId: string, lang: string, vttText: string, targetDraftId?: string) => {
      applyDraftUpdate((prev) =>
        applySubtitleUpdate(prev, {
          targetDraftId: targetDraftId ?? prev.id,
          clipId,
          lang,
          vttText,
        }),
      );
    },
    [applyDraftUpdate],
  );

  const handleUpdateManifest = useCallback(
    (updater: (prev: PgnaManifest) => PgnaManifest) => {
      const now = new Date().toISOString();
      applyDraftUpdate((prev) => ({
        ...prev,
        manifest: { ...updater(prev.manifest), updatedAt: now },
        updatedAt: now,
      }));
    },
    [applyDraftUpdate],
  );

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

  // Import .pgna or .pgn (routed through unified flush + generation-guarded workspace transition)
  const handleImportFile = async (file: File) => {
    setStatusBanner(null);
    const isPgna = file.name.toLowerCase().endsWith(".pgna");
    if (isPgna && file.size > MAX_PGNA_IMPORT_BYTES) {
      setStatusBanner({
        kind: "error",
        text: `Import failed: "${file.name}" exceeds the 50 MB .pgna import limit.`,
      });
      return;
    }
    if (!isPgna && file.size > MAX_PGN_IMPORT_BYTES) {
      setStatusBanner({
        kind: "error",
        text: `Import failed: "${file.name}" exceeds the 5 MB .pgn import limit.`,
      });
      return;
    }

    type ImportMeta =
      | {
          kind: "pgna";
          clipCount: number;
          importErrors: Array<{ code: string; message: string }>;
          importWarningsCount: number;
        }
      | { kind: "pgn" };

    try {
      const transition = await getWorkspaceController().transitionWorkspace<ImportMeta>(
        async () => {
          if (isPgna) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const unpacked = await unpackPgnaArchive(bytes);
            const validation = validatePgnaPackage(unpacked.entries);
            const importErrors = validation.diagnostics
              .filter((d) => d.severity === "error")
              .map((d) => ({ code: d.code, message: d.message }));
            const importWarningsCount = validation.diagnostics.filter(
              (d) => d.severity === "warning",
            ).length;
            const importedDraft = buildImportedPgnaDraft(unpacked);
            const clipCount = Object.keys(importedDraft.manifest.clips).length;
            return {
              draft: importedDraft,
              dirty: true,
              meta: { kind: "pgna", clipCount, importErrors, importWarningsCount },
            };
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
          return {
            draft: importedDraft,
            dirty: true,
            meta: { kind: "pgn" },
          };
        },
      );

      if (transition.status !== "committed") {
        return;
      }

      setSelectedNodeId("g0");
      setWaveformPeaksByClipId({});

      if (transition.meta?.kind === "pgna") {
        const { clipCount, importErrors, importWarningsCount } = transition.meta;
        if (importErrors.length > 0) {
          setShowDiagnostics(true);
          setStatusBanner({
            kind: "error",
            text: `Imported "${file.name}" (${clipCount} audio clips) with ${importErrors.length} validation error(s): ${importErrors[0]?.code ?? "INVALID"} — ${importErrors[0]?.message ?? ""}`,
          });
        } else if (importWarningsCount > 0) {
          setStatusBanner({
            kind: "info",
            text: `Imported PGNA archive "${file.name}" (${clipCount} audio clips, ${importWarningsCount} warning(s)).`,
          });
        } else {
          setStatusBanner({
            kind: "info",
            text: `Imported valid PGNA archive "${file.name}" (${clipCount} audio clips).`,
          });
        }
        void decodeWaveformsForDraft(transition.draft);
      } else {
        waveformDecodeTokenRef.current++;
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

  // Route publishing through the external PublishSessionController so pending/result state
  // survives PublishModal close/reopen and enforces single in-flight + idempotent retries (SCR-05)
  const handleStartPublish = useCallback(
    async (input: PublishSubmitInput): Promise<PublishToKibitzResult> => {
      const activeSession = sessionUserRef.current;
      if (!activeSession) {
        return {
          published: false,
          message: "Sign in with Kibitz ID before publishing to Lecture.",
        };
      }
      const currentDraft = draftRef.current;
      return getPublishController().startPublish({
        draftId: currentDraft.id,
        kibitzApiBaseUrl: input.kibitzApiBaseUrl,
        session: activeSession,
        visibility: input.visibility,
        programId: input.programId,
        tags: input.tags,
        title: input.title,
        description: input.description,
        manifest: currentDraft.manifest,
        buildArchive: () => buildValidatedPgnaArchive(currentDraft),
      });
    },
    [getPublishController],
  );

  const handleResetPublishResult = useCallback(() => {
    publishControllerRef.current?.resetResult();
  }, []);

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
    const exportDraft = draftRef.current;
    try {
      const zipBytes = await buildValidatedPgnaArchive(exportDraft);
      const copy = new Uint8Array(zipBytes.byteLength);
      copy.set(zipBytes);
      triggerBrowserDownload(
        new Blob([copy], { type: PGNA_MIME_TYPE }),
        `${slugifyFilename(exportDraft.manifest.title || "study")}.pgna`,
      );
      setStatusBanner({
        kind: "info",
        text: `Exported valid PGNA v1.0 archive (${(zipBytes.byteLength / 1024).toFixed(1)} KB).`,
      });
    } catch (err) {
      if (err instanceof PgnaPackError) {
        setShowDiagnostics(true);
      }
      setStatusBanner({
        kind: "error",
        text: formatPgnaExportError(err),
      });
    }
  };

  const handleExportPgn = () => {
    const current = draftRef.current;
    triggerBrowserDownload(
      new Blob([current.pgnText], { type: "application/x-chess-pgn" }),
      `${slugifyFilename(current.manifest.title || "study")}.pgn`,
    );
  };

  // Draft management (all routed through unified flush-before-switch + monotonic generation)
  const handleCreateBlankDraft = async () => {
    const res = await getWorkspaceController().transitionWorkspace(() => {
      const blank = createBlankDraft("Untitled PGNA Study");
      if (sessionUser) {
        blank.manifest.author = `@${sessionUser.handle}`;
      }
      return { draft: blank, dirty: true };
    });
    if (res.status === "committed") {
      waveformDecodeTokenRef.current++;
      setSelectedNodeId("g0");
      setWaveformPeaksByClipId({});
    }
  };

  const handleLoadDemo = async () => {
    const res = await getWorkspaceController().transitionWorkspace(() => ({
      draft: createDemoItalianDraft(),
      dirty: false,
      saveStatusState: "idle-demo",
    }));
    if (res.status === "committed") {
      waveformDecodeTokenRef.current++;
      setSelectedNodeId("g0");
      setWaveformPeaksByClipId({});
    }
  };

  const handleOpenDraft = async (id: string) => {
    const res = await getWorkspaceController().transitionWorkspace(async () => {
      const loaded = await loadLocalDraft(id);
      if (!loaded) return null;
      return { draft: loaded, dirty: false };
    });
    if (res.status === "committed") {
      setSelectedNodeId("g0");
      setWaveformPeaksByClipId({});
      void decodeWaveformsForDraft(res.draft);
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
        sessionUser={sessionUser}
        onSessionChange={handleSessionChange}
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
                  draftId={draft.id}
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
                    applyDraftUpdate((prev) => ({
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
        onCreateBlank={() => void handleCreateBlankDraft()}
        onLoadDemo={() => void handleLoadDemo()}
        onOpenDraft={(id) => void handleOpenDraft(id)}
        onDeleteDraft={(id) => void handleDeleteDraft(id)}
      />

      <PublishModal
        open={showPublishModal}
        manifest={draft.manifest}
        sessionUser={sessionUser}
        publishState={publishState}
        onSessionChange={handleSessionChange}
        onStartPublish={handleStartPublish}
        onResetPublishResult={handleResetPublishResult}
        onClose={() => setShowPublishModal(false)}
        onExportLocalPgna={() => void handleExportPgna()}
      />
    </div>
  );
}
