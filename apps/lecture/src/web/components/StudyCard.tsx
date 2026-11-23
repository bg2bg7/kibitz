import type { LectureStudy } from "../api";

export interface StudyCardProps {
  study: LectureStudy;
  showAuthor?: boolean;
  onOpenStudy: (studyId: string) => void;
  onSelectAuthor: (handle: string) => void;
  onSelectTag: (tag: string) => void;
  onEditStudy?: (study: LectureStudy) => void;
  onDeleteStudy?: (study: LectureStudy) => void;
}

function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function visibilityLabel(visibility: LectureStudy["visibility"]): string | null {
  switch (visibility) {
    case "private":
      return "Private";
    case "coach_students":
      return "Linked Students";
    case "program":
      return "Program";
    case "public_moderated":
    default:
      return null;
  }
}

export function StudyCard({
  study,
  showAuthor = true,
  onOpenStudy,
  onSelectAuthor,
  onSelectTag,
  onEditStudy,
  onDeleteStudy,
}: StudyCardProps) {
  const visBadge = visibilityLabel(study.visibility);
  const dateLabel = formatShortDate(study.updatedAt);

  return (
    <article className="group flex flex-col justify-between rounded-2xl border border-stone-200/90 bg-white p-5 shadow-2xs transition hover:-translate-y-0.5 hover:border-stone-300 hover:shadow-sm">
      <div>
        <div className="flex items-start justify-between gap-2">
          <button
            type="button"
            onClick={() => onOpenStudy(study.id)}
            className="text-left text-base font-semibold tracking-tight text-slate-900 transition group-hover:text-sky-800"
          >
            {study.title}
          </button>
          {visBadge ? (
            <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
              {visBadge}
            </span>
          ) : null}
        </div>

        {showAuthor ? (
          <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-500">
            <button
              type="button"
              onClick={() => onSelectAuthor(study.ownerHandle)}
              className="font-mono font-medium text-slate-700 hover:text-sky-700 hover:underline"
            >
              @{study.ownerHandle}
            </button>
            <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 uppercase">
              {study.ownerRole}
            </span>
          </div>
        ) : null}

        {study.description ? (
          <p className="mt-2.5 line-clamp-2 text-xs leading-relaxed text-slate-600">
            {study.description}
          </p>
        ) : (
          <p className="mt-2.5 text-xs italic text-slate-400">PGNA v1.0 interactive chess study</p>
        )}

        {study.tags.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {study.tags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => onSelectTag(tag)}
                className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-0.5 text-[11px] font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-900 hover:text-white"
              >
                #{tag}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 pt-3 text-xs">
        <span className="text-[11px] text-slate-400">{dateLabel}</span>

        <div className="flex items-center gap-2">
          {onEditStudy ? (
            <button
              type="button"
              onClick={() => onEditStudy(study)}
              className="rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900"
            >
              Edit tags
            </button>
          ) : null}
          {onDeleteStudy ? (
            <button
              type="button"
              onClick={() => onDeleteStudy(study)}
              className="rounded-md border border-rose-200 px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-50"
            >
              Delete
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onOpenStudy(study.id)}
            className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-800"
          >
            Watch <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>
    </article>
  );
}
