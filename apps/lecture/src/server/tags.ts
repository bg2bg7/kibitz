export const MAX_STUDY_TITLE_LENGTH = 200;
export const MAX_STUDY_DESCRIPTION_LENGTH = 4000;
export const MAX_STUDY_TAGS = 12;
export const MAX_TAG_LENGTH = 32;

const TAG_VALID_PATTERN = /^[a-z0-9][a-z0-9 _-]{0,31}$/;

/**
 * Normalizes a single user-supplied tag into a canonical lowercase slug-like display label.
 * Returns null if the tag is empty or contains invalid characters.
 */
export function normalizeTag(raw: string): string | null {
  const collapsed = raw.trim().replace(/\s+/g, " ").toLowerCase();
  if (!collapsed || collapsed.length > MAX_TAG_LENGTH) {
    return null;
  }
  if (!TAG_VALID_PATTERN.test(collapsed)) {
    return null;
  }
  return collapsed;
}

/**
 * Normalizes, validates, and deduplicates an array of tags (preserving first-seen order).
 * Reports valid tags beyond `MAX_STUDY_TAGS` in `overflow` so callers can reject rather than silently drop them.
 */
export function normalizeStudyTags(rawTags: readonly string[]): {
  tags: string[];
  invalid: string[];
  overflow: string[];
  truncated: boolean;
} {
  const tags: string[] = [];
  const seen = new Set<string>();
  const invalid: string[] = [];
  const overflow: string[] = [];
  let truncated = false;

  for (const item of rawTags) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const normalized = normalizeTag(trimmed);
    if (!normalized) {
      invalid.push(trimmed);
      continue;
    }
    if (seen.has(normalized)) continue;
    if (tags.length >= MAX_STUDY_TAGS) {
      truncated = true;
      seen.add(normalized);
      overflow.push(normalized);
      continue;
    }
    seen.add(normalized);
    tags.push(normalized);
  }

  return { tags, invalid, overflow, truncated };
}

/**
 * Parses tags from a FormData string (either a JSON array like `["openings","tactics"]`
 * or a comma-separated string like `openings, tactics`).
 */
export function parseRawTagsField(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === "string");
  }
  if (typeof raw !== "string") {
    return [];
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      // Fall through to comma-separated parsing
    }
  }
  return trimmed
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export interface TagCountSummary {
  tag: string;
  count: number;
}

export interface StudyTagGroup<T extends { tags: readonly string[] }> {
  tag: string;
  count: number;
  studies: T[];
}

/**
 * Aggregates tag frequencies across a list of studies (sorted by descending count, then A-Z).
 */
export function collectTagCounts<T extends { tags: readonly string[] }>(
  items: readonly T[],
): TagCountSummary[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of item.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Organizes an account's studies into tag groups (a multi-tagged study appears under each of its tags)
 * plus a list of untagged studies.
 */
export function groupStudiesByTag<T extends { tags: readonly string[] }>(
  items: readonly T[],
): {
  tagGroups: StudyTagGroup<T>[];
  untagged: T[];
  tags: TagCountSummary[];
} {
  const map = new Map<string, T[]>();
  const untagged: T[] = [];

  for (const item of items) {
    if (item.tags.length === 0) {
      untagged.push(item);
      continue;
    }
    for (const tag of item.tags) {
      let bucket = map.get(tag);
      if (!bucket) {
        bucket = [];
        map.set(tag, bucket);
      }
      bucket.push(item);
    }
  }

  const tagGroups: StudyTagGroup<T>[] = [...map.entries()]
    .map(([tag, studies]) => ({
      tag,
      count: studies.length,
      studies,
    }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  const tags: TagCountSummary[] = tagGroups.map((g) => ({ tag: g.tag, count: g.count }));

  return { tagGroups, untagged, tags };
}
