import type { DraftSummary } from "../local/draftStore";

export interface DraftsModalProps {
  open: boolean;
  activeDraftId: string;
  drafts: readonly DraftSummary[];
  onClose: () => void;
  onCreateBlank: () => void;
  onLoadDemo: () => void;
  onOpenDraft: (id: string) => void;
  onDeleteDraft: (id: string) => void;
}

export function DraftsModal({
  open,
  activeDraftId,
  drafts,
  onClose,
  onCreateBlank,
  onLoadDemo,
  onOpenDraft,
  onDeleteDraft,
}: DraftsModalProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Local Browser Drafts</h2>
            <p className="text-xs text-slate-500">
              Stored privately in IndexedDB on this device. Zero account required.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
          >
            Close
          </button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              onCreateBlank();
              onClose();
            }}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
          >
            + New Blank Study
          </button>
          <button
            type="button"
            onClick={() => {
              onLoadDemo();
              onClose();
            }}
            className="rounded-md border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-800 hover:bg-sky-100"
          >
            Load Italian Game Demo
          </button>
        </div>

        <div className="mt-4 max-h-72 space-y-2 overflow-y-auto">
          {drafts.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">
              No saved local drafts yet. Your current study auto-saves automatically.
            </p>
          ) : (
            drafts.map((d) => {
              const isCurrent = d.id === activeDraftId;
              return (
                <div
                  key={d.id}
                  className={`flex items-center justify-between rounded-lg border px-3 py-2.5 text-xs ${
                    isCurrent ? "border-sky-300 bg-sky-50/50" : "border-slate-200 bg-white"
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold text-slate-900">{d.title}</span>
                      {isCurrent ? (
                        <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800">
                          Active
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {d.clipCount} audio clip{d.clipCount === 1 ? "" : "s"} · Updated{" "}
                      {new Date(d.updatedAt).toLocaleString()}
                    </p>
                  </div>

                  <div className="ml-3 flex shrink-0 items-center gap-1.5">
                    {!isCurrent ? (
                      <button
                        type="button"
                        onClick={() => {
                          onOpenDraft(d.id);
                          onClose();
                        }}
                        className="rounded border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Open
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onDeleteDraft(d.id)}
                      className="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
