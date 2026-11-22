import { useMemo, useState } from "react";
import type { SessionPayload } from "@suite/auth-core";
import type { PgnaManifest } from "@suite/pgna";
import {
  publishArchiveToKibitz,
  validateKibitzApiBaseUrl,
  type PublishToKibitzResult,
  type StudyVisibility,
} from "./kibitzPublisher";

export interface PublishModalProps {
  open: boolean;
  manifest: PgnaManifest;
  onClose: () => void;
  onBuildArchive: () => Promise<Uint8Array>;
  onExportLocalPgna: () => void;
}

type DecodedJwtState =
  | { status: "empty" }
  | { status: "invalid"; error: string }
  | { status: "expired"; session: SessionPayload; error: string }
  | { status: "valid"; session: SessionPayload };

const ALLOWED_ROLES = new Set(["student", "coach", "admin"]);

function decodeBase64UrlToUtf8(segment: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new Error("Invalid base64url segment.");
  }
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (base64.length % 4)) % 4;
  const binary = atob(base64 + "=".repeat(padLen));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Decodes a pasted JWT payload client-side for preview and pre-flight validation.
 * NOTE: Cryptographic signature verification is performed authoritatively by the Kibitz server.
 */
function decodePastedSessionJwt(rawToken: string): DecodedJwtState {
  const trimmed = rawToken.trim();
  if (trimmed.length === 0) {
    return { status: "empty" };
  }

  const parts = trimmed.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return {
      status: "invalid",
      error: "Malformed JWT: expected 3 dot-separated segments (header.payload.signature).",
    };
  }

  let parsed: unknown;
  try {
    const json = decodeBase64UrlToUtf8(parts[1]);
    parsed = JSON.parse(json);
  } catch {
    return {
      status: "invalid",
      error: "Malformed JWT: payload could not be decoded as valid base64url JSON.",
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      status: "invalid",
      error: "Malformed JWT: payload must be a JSON object.",
    };
  }

  const claims = parsed as Record<string, unknown>;
  const sub = typeof claims["sub"] === "string" ? claims["sub"].trim() : "";
  const handle = typeof claims["handle"] === "string" ? claims["handle"].trim() : "";
  const role = typeof claims["role"] === "string" ? claims["role"] : "";
  const iat = claims["iat"];
  const exp = claims["exp"];

  if (!sub) {
    return { status: "invalid", error: "JWT payload is missing a valid `sub` claim." };
  }
  if (!handle) {
    return { status: "invalid", error: "JWT payload is missing a valid `handle` claim." };
  }
  if (!ALLOWED_ROLES.has(role)) {
    return {
      status: "invalid",
      error: `JWT payload has unsupported role "${role || "(missing)"}". Expected student, coach, or admin.`,
    };
  }
  if (typeof iat !== "number" || !Number.isFinite(iat) || iat < 0) {
    return { status: "invalid", error: "JWT payload is missing a valid numeric `iat` claim." };
  }
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) {
    return { status: "invalid", error: "JWT payload is missing a valid numeric `exp` claim." };
  }

  const rawProgramIds = claims["programIds"];
  const programIds =
    Array.isArray(rawProgramIds) && rawProgramIds.every((id): id is string => typeof id === "string")
      ? rawProgramIds
      : [];

  const session: SessionPayload = {
    sub,
    handle,
    role: role as SessionPayload["role"],
    programIds,
    iat: Math.floor(iat),
    exp: Math.floor(exp),
  };

  if (session.exp * 1000 <= Date.now()) {
    return {
      status: "expired",
      session,
      error: `Session JWT for @${session.handle} has expired. Paste a fresh token from the id service.`,
    };
  }

  return { status: "valid", session };
}

/**
 * Isolated optional publishing modal inside apps/scribe/src/publish/**.
 * Local authoring and .pgna export never require signing in or touching a backend.
 */
export function PublishModal({
  open,
  manifest,
  onClose,
  onBuildArchive,
  onExportLocalPgna,
}: PublishModalProps) {
  const [apiUrl, setApiUrl] = useState("http://localhost:4002");
  const [accessToken, setAccessToken] = useState("");
  const [visibility, setVisibility] = useState<StudyVisibility>("coach_students");
  const [isBusy, setIsBusy] = useState(false);
  const [result, setResult] = useState<PublishToKibitzResult | null>(null);

  const decodedToken = useMemo(() => decodePastedSessionJwt(accessToken), [accessToken]);
  const urlValidation = useMemo(() => validateKibitzApiBaseUrl(apiUrl), [apiUrl]);

  if (!open) return null;

  const trimmedToken = accessToken.trim();
  const hasPublishRole =
    decodedToken.status === "valid" &&
    (decodedToken.session.role === "coach" || decodedToken.session.role === "admin");
  const canPublish =
    !isBusy && trimmedToken.length > 0 && decodedToken.status === "valid" && hasPublishRole && urlValidation.ok;

  const handlePublish = async () => {
    if (trimmedToken.length === 0) {
      setResult({
        published: false,
        message: "A non-empty Bearer token from the id service is required to publish remotely.",
      });
      return;
    }

    if (decodedToken.status !== "valid") {
      setResult({
        published: false,
        message:
          decodedToken.status === "empty"
            ? "A Bearer token is required to publish to Kibitz."
            : decodedToken.error,
      });
      return;
    }

    setIsBusy(true);
    setResult(null);
    try {
      const archiveBytes = await onBuildArchive();
      const res = await publishArchiveToKibitz({
        kibitzApiBaseUrl: apiUrl,
        session: decodedToken.session,
        accessToken: trimmedToken,
        visibility,
        manifest,
        archiveBytes,
      });
      setResult(res);
    } catch (err) {
      setResult({
        published: false,
        message: err instanceof Error ? err.message : "Failed to compile archive.",
      });
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Publish to Kibitz Library</h2>
            <p className="text-xs text-slate-500">
              Optional remote upload isolated in <code>src/publish/</code>. Local `.pgna` export is
              always free of accounts.
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

        <div className="mt-4 space-y-3 text-xs">
          <label className="block">
            <span className="font-medium text-slate-700">Kibitz API Base URL</span>
            <input
              type="url"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-xs"
            />
            {!urlValidation.ok ? (
              <p className="mt-1 text-[11px] text-rose-700">{urlValidation.error}</p>
            ) : null}
          </label>

          <label className="block">
            <span className="font-medium text-slate-700">Visibility</span>
            <select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as StudyVisibility)}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5"
            >
              <option value="private">Private (only me)</option>
              <option value="coach_students">Linked Students</option>
              <option value="program">School / Program</option>
              <option value="public_moderated">Public (queued for moderation)</option>
            </select>
          </label>

          <label className="block">
            <span className="font-medium text-slate-700">Bearer Token (from id service)</span>
            <input
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder="Paste session JWT…"
              className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 font-mono"
            />
          </label>

          {decodedToken.status === "empty" ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-[11px] text-slate-600">
              Paste a signed session JWT from the id service to publish remotely. The Kibitz server
              authoritatively verifies the cryptographic signature on upload.
            </div>
          ) : null}

          {decodedToken.status === "invalid" || decodedToken.status === "expired" ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-[11px] text-rose-800">
              {decodedToken.error}
            </div>
          ) : null}

          {decodedToken.status === "valid" ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-slate-700">Decoded Token Preview</span>
                <div className="flex items-center gap-1.5">
                  <span className="rounded-full bg-slate-200 px-2 py-0.5 font-mono text-[11px] text-slate-800">
                    @{decodedToken.session.handle}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      hasPublishRole
                        ? "bg-emerald-100 text-emerald-800"
                        : "bg-amber-100 text-amber-800"
                    }`}
                  >
                    {decodedToken.session.role}
                  </span>
                </div>
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                Read-only client preview; the Kibitz server authoritatively verifies the JWT
                signature.
              </p>
              {!hasPublishRole ? (
                <p className="mt-1 text-[11px] font-medium text-amber-800">
                  Only coach or admin accounts may publish .pgna studies to Kibitz.
                </p>
              ) : null}
            </div>
          ) : null}

          {result ? (
            <div
              className={`rounded-lg border p-2.5 text-xs ${
                result.published
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-amber-200 bg-amber-50 text-amber-900"
              }`}
            >
              {result.message}
            </div>
          ) : null}
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={onExportLocalPgna}
            className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Download .pgna Locally
          </button>

          <button
            type="button"
            disabled={!canPublish}
            onClick={handlePublish}
            className="rounded-md bg-sky-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-sky-800 disabled:opacity-50"
          >
            {isBusy ? "Validating & Uploading…" : "Validate & Publish"}
          </button>
        </div>
      </div>
    </div>
  );
}
