import { resolveApiUrl, type KibitzUserRole } from "@suite/ui";

const VITE_ENV = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

export type StudyVisibility = "public_moderated" | "coach_students" | "program" | "private";

export interface LectureStudy {
  id: string;
  title: string;
  description: string;
  tags: string[];
  ownerHandle: string;
  ownerRole: KibitzUserRole;
  visibility: StudyVisibility;
  moderationStatus: "pending" | "approved" | "rejected";
  archivePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface AuthorSummary {
  handle: string;
  role: KibitzUserRole;
  count: number;
}

export interface StudyTagGroup {
  tag: string;
  count: number;
  studies: LectureStudy[];
}

export interface StudiesListResponse {
  studies: LectureStudy[];
  tags: TagCount[];
  authors: AuthorSummary[];
}

export interface AccountLectureResponse {
  account: {
    handle: string;
    role: KibitzUserRole;
  };
  isOwner: boolean;
  studies: LectureStudy[];
  tagGroups: StudyTagGroup[];
  untagged: LectureStudy[];
  tags: TagCount[];
}

export interface StudyDetailResponse {
  study: LectureStudy;
  canEdit: boolean;
}

export function getLectureApiBaseUrl(): string {
  return resolveApiUrl("lecture", { env: VITE_ENV });
}

export function buildStudyArchiveUrl(studyId: string): string {
  return `${getLectureApiBaseUrl()}/api/studies/${encodeURIComponent(studyId)}/archive`;
}

export async function fetchLectureStudies(filters?: {
  tag?: string | null;
  author?: string | null;
  q?: string | null;
}): Promise<StudiesListResponse> {
  const params = new URLSearchParams();
  if (filters?.tag) params.set("tag", filters.tag);
  if (filters?.author) params.set("author", filters.author);
  if (filters?.q?.trim()) params.set("q", filters.q.trim());
  const qs = params.toString();

  const res = await fetch(`${getLectureApiBaseUrl()}/api/studies${qs ? `?${qs}` : ""}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to load lectures (HTTP ${res.status}).`);
  }
  return (await res.json()) as StudiesListResponse;
}

export async function fetchAccountLecturePage(handle: string): Promise<AccountLectureResponse> {
  const cleanHandle = handle.trim().replace(/^@+/, "");
  const res = await fetch(
    `${getLectureApiBaseUrl()}/api/accounts/${encodeURIComponent(cleanHandle)}/studies`,
    {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Account @${cleanHandle} not found (HTTP ${res.status}).`);
  }
  return (await res.json()) as AccountLectureResponse;
}

export async function fetchStudyDetail(studyId: string): Promise<StudyDetailResponse> {
  const res = await fetch(
    `${getLectureApiBaseUrl()}/api/studies/${encodeURIComponent(studyId)}`,
    {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Lecture not found (HTTP ${res.status}).`);
  }
  return (await res.json()) as StudyDetailResponse;
}

export async function fetchStudyArchiveBytes(studyId: string): Promise<Uint8Array> {
  const res = await fetch(buildStudyArchiveUrl(studyId), {
    method: "GET",
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`Failed to download .pgna archive (HTTP ${res.status}).`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export async function updateStudyMetadata(
  studyId: string,
  patch: {
    title?: string;
    description?: string;
    tags?: string[];
    visibility?: StudyVisibility;
  },
): Promise<LectureStudy> {
  const res = await fetch(
    `${getLectureApiBaseUrl()}/api/studies/${encodeURIComponent(studyId)}`,
    {
      method: "PATCH",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to update study (HTTP ${res.status}).`);
  }
  const data = (await res.json()) as { study: LectureStudy };
  return data.study;
}

export async function deleteStudyById(studyId: string): Promise<void> {
  const res = await fetch(
    `${getLectureApiBaseUrl()}/api/studies/${encodeURIComponent(studyId)}`,
    {
      method: "DELETE",
      credentials: "include",
      headers: { Accept: "application/json" },
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to delete study (HTTP ${res.status}).`);
  }
}
