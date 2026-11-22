import { useState } from "react";
import type { SessionPayload, UserRole } from "@suite/auth-core";
import type { PgnaManifest } from "@suite/pgna";
import {
  publishArchiveToKibitz,
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
  const [handle, setHandle] = useState("coach");
  const [role, setRole] = useState<UserRole>("coach");
  const [accessToken, setAccessToken] = useState("");
  const [visibility, setVisibility] = useState<StudyVisibility>("coach_students");
  const [isBusy, setIsBusy] = useState(false);
  const [result, setResult] = useState<PublishToKibitzResult | null>(null);

  if (!open) return null;

  const handlePublish = async () => {
    setIsBusy(true);
    setResult(null);
    try {
      const archiveBytes = await onBuildArchive();
      const nowSec = Math.floor(Date.now() / 1000);
      const session: SessionPayload = {
        sub: "00000000-0000-4000-8000-000000000000",
        handle: handle.trim() || "coach",
        role,
        programIds: [],
        iat: nowSec,
        exp: nowSec + 3600,
      };
      const res = await publishArchiveToKibitz({
        kibitzApiBaseUrl: apiUrl,
        session,
        accessToken: accessToken.trim() || undefined,
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
          </label>

          <div className="grid grid-cols-2 gap-2.5">
            <label className="block">
              <span className="font-medium text-slate-700">Account Handle</span>
              <input
                type="text"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5"
              />
            </label>

            <label className="block">
              <span className="font-medium text-slate-700">Role</span>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as UserRole)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5"
              >
                <option value="coach">coach</option>
                <option value="admin">admin</option>
                <option value="student">student (blocked)</option>
              </select>
            </label>
          </div>

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
            disabled={isBusy}
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
