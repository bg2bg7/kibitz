import {
  resolveApiUrl,
  type ResolveServiceUrlOptions,
  type SuiteApiServiceId,
} from "./services.js";

export type KibitzUserRole = "admin" | "moderator" | "coach" | "student";

export interface KibitzSessionUser {
  sub: string;
  handle: string;
  role: KibitzUserRole;
  programIds: string[];
  iat: number;
  exp: number;
}

export interface KibitzSessionResponse {
  authenticated: boolean;
  user: KibitzSessionUser | null;
}

export interface SessionClientOptions extends ResolveServiceUrlOptions {
  fetchImpl?: typeof fetch;
}

export type LoginResult = { ok: true; user: KibitzSessionUser } | { ok: false; error: string };

export type ReadOnlyPullResult<T> =
  { ok: true; status: number; data: T } | { ok: false; status: number; error: string };

function isSessionUser(value: unknown): value is KibitzSessionUser {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["sub"] === "string" &&
    typeof obj["handle"] === "string" &&
    (obj["role"] === "admin" ||
      obj["role"] === "moderator" ||
      obj["role"] === "coach" ||
      obj["role"] === "student") &&
    Array.isArray(obj["programIds"]) &&
    typeof obj["iat"] === "number" &&
    typeof obj["exp"] === "number"
  );
}

/**
 * Fetches the current cross-service KibitzID session via `GET /auth/session` with
 * `credentials: "include"`. Safely returns `{ authenticated: false, user: null }` when offline.
 */
export async function fetchKibitzSession(
  options: SessionClientOptions = {},
): Promise<KibitzSessionResponse> {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    return { authenticated: false, user: null };
  }

  const baseUrl = resolveApiUrl("id", options);
  try {
    const res = await fetchFn(`${baseUrl}/auth/session`, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return { authenticated: false, user: null };
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (body && body["authenticated"] === true && isSessionUser(body["user"])) {
      return { authenticated: true, user: body["user"] };
    }
    return { authenticated: false, user: null };
  } catch {
    return { authenticated: false, user: null };
  }
}

/**
 * Authenticates against KibitzID (`POST /auth/login`) so the browser stores the cross-service
 * `HttpOnly` session cookie across all suite subdomains and localhost ports.
 */
export async function loginWithKibitzId(
  credentials: { handle: string; password: string },
  options: SessionClientOptions = {},
): Promise<LoginResult> {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    return { ok: false, error: "Network client unavailable." };
  }

  const baseUrl = resolveApiUrl("id", options);
  try {
    const res = await fetchFn(`${baseUrl}/auth/login`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        handle: credentials.handle,
        password: credentials.password,
      }),
    });

    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const msg =
        typeof body?.["error"] === "string"
          ? body["error"]
          : `Sign in failed (HTTP ${res.status}).`;
      return { ok: false, error: msg };
    }

    if (body && isSessionUser(body["user"])) {
      return { ok: true, user: body["user"] };
    }

    return { ok: false, error: "Unexpected response from Kibitz ID." };
  } catch {
    return { ok: false, error: "Unable to reach Kibitz ID service." };
  }
}

/**
 * Clears the cross-service `kibitz_session` cookie via `POST /auth/logout`.
 */
export async function logoutKibitzSession(options: SessionClientOptions = {}): Promise<boolean> {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    return false;
  }

  const baseUrl = resolveApiUrl("id", options);
  try {
    const res = await fetchFn(`${baseUrl}/auth/logout`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Strictly read-only (`GET` only, zero body) pull helper using the shared KibitzID session cookie.
 * Built for offline-first PWAs (`arbiter`, `seconds`) so they can pull read-only data such as
 * scheduled tournaments while upholding the Zero-Upload Firewall.
 */
export async function pullReadOnlyFromService<T>(
  serviceId: SuiteApiServiceId,
  path: string,
  options: SessionClientOptions = {},
): Promise<ReadOnlyPullResult<T>> {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    return { ok: false, status: 0, error: "Network client unavailable." };
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const baseUrl = resolveApiUrl(serviceId, options);

  try {
    const res = await fetchFn(`${baseUrl}${normalizedPath}`, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });

    const body = (await res.json().catch(() => null)) as T | { error?: string } | null;
    if (!res.ok) {
      const errorMessage =
        typeof (body as { error?: unknown } | null)?.error === "string"
          ? (body as { error: string }).error
          : `Request failed (HTTP ${res.status}).`;
      return { ok: false, status: res.status, error: errorMessage };
    }

    return { ok: true, status: res.status, data: body as T };
  } catch {
    return { ok: false, status: 0, error: "Offline or service unreachable." };
  }
}
