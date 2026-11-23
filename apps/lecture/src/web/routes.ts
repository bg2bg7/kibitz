export type LectureRoute =
  | { kind: "browser"; tag: string | null; query: string }
  | { kind: "account"; handle: string }
  | { kind: "viewer"; studyId: string };

export function parseLectureLocation(pathname: string, search: string): LectureRoute {
  const cleanPath = pathname.replace(/\/+$/, "") || "/";

  const accountMatch = /^\/@([^/]+)$/.exec(cleanPath);
  if (accountMatch?.[1]) {
    return { kind: "account", handle: decodeURIComponent(accountMatch[1]) };
  }

  const studyMatch = /^\/studies\/([^/]+)$/.exec(cleanPath);
  if (studyMatch?.[1]) {
    return { kind: "viewer", studyId: decodeURIComponent(studyMatch[1]) };
  }

  const params = new URLSearchParams(search);
  return {
    kind: "browser",
    tag: params.get("tag")?.trim() || null,
    query: params.get("q")?.trim() || "",
  };
}
