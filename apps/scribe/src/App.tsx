import { useCallback, useEffect, useMemo, useState } from "react";
import type { BoardAnnotationColor, PromotionPiece } from "@suite/board-ui";
import { parsePgnGames, serializePgnGames, type PgnGameDocument } from "@suite/chess-core";
import {
  PGNA_MIME_TYPE,
  compilePgna,
  packPgnaArchive,
  unpackPgnaArchive,
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
import { decodeAudioMetadata } from "./local/audioStudio";
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

  // Refresh saved draft list on mount
  const refreshDraftList = useCallback(async () => {
    try {
      const items = await listLocalDrafts();
      setDraftList(items);
    } catch {
      // ignore in restricted environments
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listLocalDrafts()
      .then((items) => {
        if (!cancelled) {
          setDraftList(items);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced IndexedDB auto-save
  useEffect(() => {
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
  const commitGames = useCallback((nextGames: PgnGameDocument[], nextNodeId?: NodeId) => {
    const nextPgn = serializePgnGames(nextGames);
    setDraft((prev) => ({
      ...prev,
      pgnText: nextPgn,
      manifest: { ...prev.manifest, updatedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    }));
    if (nextNodeId) {
      setSelectedNodeId(nextNodeId);
    }
  }, []);

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
    commitGames(res.games, res.fallbackNodeId);
  };

  const handleScheduleNode = (nodeId: NodeId, durMs?: number) => {
    commitGames(appendNodeToTimeline(games, nodeId, durMs));
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
    const nextGames = updateNodeTags(games, nodeId, (prev) => ({
      ...prev,
      audioClipId: clip.id,
      // Auto-schedule on timeline if node wasn't scheduled yet
      atTags: prev.atTags.length > 0 ? prev.atTags : prev.atTags,
    }));
    const nextPgn = serializePgnGames(nextGames);

    setWaveformPeaksByClipId((prev) => ({ ...prev, [clip.id]: peaks }));
    setDraft((prev) => ({
      ...prev,
      pgnText: nextPgn,
      manifest: {
        ...prev.manifest,
        updatedAt: new Date().toISOString(),
        clips: {
          ...prev.manifest.clips,
          [clip.id]: clip,
        },
      },
      audioByPath: {
        ...prev.audioByPath,
        [clip.path]: bytes,
      },
      updatedAt: new Date().toISOString(),
    }));
  };

  const handleUpdateClip = (clipId: string, updater: (prev: ClipDefinition) => ClipDefinition) => {
    setDraft((prev) => {
      const existing = prev.manifest.clips[clipId];
      if (!existing) return prev;
      return {
        ...prev,
        manifest: {
          ...prev.manifest,
          updatedAt: new Date().toISOString(),
          clips: {
            ...prev.manifest.clips,
            [clipId]: updater(existing),
          },
        },
        updatedAt: new Date().toISOString(),
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

    // Check whether any other node still references this clipId before removing from manifest
    const stillUsed =
      clipId !== null &&
      clipId !== undefined &&
      Object.values(studyIndex.nodesById).some(
        (n) => n.nodeId !== nodeId && n.tags.audioClipId === clipId,
      );

    setDraft((prev) => {
      const nextClips = { ...prev.manifest.clips };
      const nextAudioByPath = { ...prev.audioByPath };
      if (clipId && !stillUsed) {
        const oldClip = nextClips[clipId];
        if (oldClip) {
          delete nextAudioByPath[oldClip.path];
          delete nextClips[clipId];
        }
      }
      return {
        ...prev,
        pgnText: nextPgn,
        manifest: {
          ...prev.manifest,
          updatedAt: new Date().toISOString(),
          clips: nextClips,
        },
        audioByPath: nextAudioByPath,
        updatedAt: new Date().toISOString(),
      };
    });
  };

  const handleUpdateSubtitle = (clipId: string, lang: string, vttText: string) => {
    const subPath = `subtitles/${lang}/${clipId}.vtt`;
    setDraft((prev) => {
      const clip = prev.manifest.clips[clipId];
      if (!clip) return prev;
      const nextSubtitles = { ...(clip.subtitles ?? {}) };
      const nextSubByPath = { ...prev.subtitlesByPath };
      if (vttText.trim() === "") {
        delete nextSubtitles[lang];
        delete nextSubByPath[subPath];
      } else {
        nextSubtitles[lang] = subPath;
        nextSubByPath[subPath] = vttText;
      }
      return {
        ...prev,
        manifest: {
          ...prev.manifest,
          updatedAt: new Date().toISOString(),
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
        updatedAt: new Date().toISOString(),
      };
    });
  };

  const handleUpdateManifest = (updater: (prev: PgnaManifest) => PgnaManifest) => {
    setDraft((prev) => ({
      ...prev,
      manifest: { ...updater(prev.manifest), updatedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    }));
  };

  // Multi-game chapter mutations
  const handleAddGame = (title: string, initialFen?: string) => {
    const res = addNewGame(games, title, initialFen);
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
    commitGames(res.games, res.fallbackNodeId);
  };

  // Import .pgna or .pgn
  const handleImportFile = async (file: File) => {
    setStatusBanner(null);
    try {
      if (file.name.toLowerCase().endsWith(".pgna")) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const unpacked = await unpackPgnaArchive(bytes);
        const importedDraft: ScribeDraft = {
          id: createDraftId(),
          manifest: unpacked.manifest,
          pgnText: unpacked.pgnText,
          audioByPath: unpacked.audioByPath,
          subtitlesByPath: unpacked.subtitlesByPath,
          updatedAt: new Date().toISOString(),
        };
        setDraft(importedDraft);
        setSelectedNodeId("g0");
        setStatusBanner({
          kind: "info",
          text: `Imported PGNA archive "${file.name}" (${Object.keys(unpacked.manifest.clips).length} audio clips).`,
        });

        // Decode waveform peaks in background
        const peakEntries: Record<string, number[]> = {};
        for (const clip of Object.values(unpacked.manifest.clips)) {
          const audioBytes = unpacked.audioByPath[clip.path];
          if (audioBytes) {
            const meta = await decodeAudioMetadata(audioBytes, clip.durationMs);
            peakEntries[clip.id] = meta.peaks;
          }
        }
        setWaveformPeaksByClipId(peakEntries);
      } else {
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
        setDraft(importedDraft);
        setSelectedNodeId("g0");
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
    setDraft(createBlankDraft("Untitled PGNA Study"));
    setSelectedNodeId("g0");
    setWaveformPeaksByClipId({});
  };

  const handleLoadDemo = () => {
    setDraft(createDemoItalianDraft());
    setSelectedNodeId("g0");
    setWaveformPeaksByClipId({});
  };

  const handleOpenDraft = async (id: string) => {
    const loaded = await loadLocalDraft(id);
    if (loaded) {
      setDraft(loaded);
      setSelectedNodeId("g0");
      setWaveformPeaksByClipId({});
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
                  onApplyRawPgn={(nextPgn) =>
                    setDraft((prev) => ({
                      ...prev,
                      pgnText: nextPgn,
                      updatedAt: new Date().toISOString(),
                    }))
                  }
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
