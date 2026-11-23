import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { resolveServiceUrl } from "./services.js";
import {
  fetchKibitzSession,
  loginWithKibitzId,
  logoutKibitzSession,
  type KibitzSessionUser,
} from "./session.js";

export interface KibitzAuthMenuProps {
  /** Optional Vite-style env record for resolving service URLs. */
  env?: Record<string, string | undefined>;
  /** Controlled authenticated user. When omitted, the menu fetches and manages session state itself. */
  user?: KibitzSessionUser | null;
  /** Called whenever sign-in, sign-out, or initial session fetch changes the active user. */
  onSessionChange?: (user: KibitzSessionUser | null) => void;
  /** Optional URL to redirect back to after invite registration on Kibitz ID. */
  returnTo?: string;
  /** Optional custom href for clicking the signed-in @handle pill (defaults to Kibitz ID). */
  accountHref?: string;
  /** Optional compact styling for dense toolbars like Scribe. */
  compact?: boolean;
}

/**
 * Shared cross-service Kibitz ID authentication menu & sign-in modal.
 * Uses inline styles so it renders consistently across all apps regardless of Tailwind scanning.
 * Zero @suite/auth-core or @suite/db dependencies — communicates exclusively via Kibitz ID HTTP API.
 */
export function KibitzAuthMenu({
  env,
  user: controlledUser,
  onSessionChange,
  returnTo,
  accountHref,
  compact = false,
}: KibitzAuthMenuProps) {
  const isControlled = controlledUser !== undefined;
  const [internalUser, setInternalUser] = useState<KibitzSessionUser | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const user = isControlled ? controlledUser : internalUser;

  const idUrl = resolveServiceUrl("id", { env });
  const fallbackReturnTo =
    returnTo ??
    (typeof window !== "undefined" ? window.location.href : resolveServiceUrl("kibitz", { env }));
  const registerUrl = `${idUrl}/?mode=register&returnTo=${encodeURIComponent(fallbackReturnTo)}`;

  useEffect(() => {
    if (isControlled) return;
    let mounted = true;
    void fetchKibitzSession({ env }).then((session) => {
      if (!mounted) return;
      const nextUser = session.authenticated ? session.user : null;
      setInternalUser(nextUser);
      onSessionChange?.(nextUser);
    });
    return () => {
      mounted = false;
    };
  }, [env, isControlled, onSessionChange]);

  useEffect(() => {
    if (!modalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setModalOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [modalOpen]);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await loginWithKibitzId({ handle: handle.trim(), password }, { env });
    setSubmitting(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    if (!isControlled) {
      setInternalUser(result.user);
    }
    onSessionChange?.(result.user);
    setPassword("");
    setModalOpen(false);
  };

  const handleSignOut = async () => {
    await logoutKibitzSession({ env });
    if (!isControlled) {
      setInternalUser(null);
    }
    onSessionChange?.(null);
  };

  if (user) {
    return (
      <div style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
        <a
          id="nav-account-link"
          href={accountHref ?? idUrl}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.45rem",
            borderRadius: "0.5rem",
            border: "1px solid #e2e8f0",
            backgroundColor: "#ffffff",
            padding: compact ? "0.28rem 0.6rem" : "0.375rem 0.75rem",
            fontSize: compact ? "0.75rem" : "0.875rem",
            fontWeight: 500,
            color: "#0f172a",
            textDecoration: "none",
          }}
        >
          <span>@{user.handle}</span>
          <span
            style={{
              borderRadius: "0.25rem",
              backgroundColor: "#0f172a",
              padding: "0.1rem 0.35rem",
              fontSize: "0.625rem",
              fontWeight: 600,
              letterSpacing: "0.04em",
              color: "#fcd34d",
              textTransform: "uppercase",
            }}
          >
            {user.role}
          </span>
        </a>
        <button
          id="nav-sign-out"
          type="button"
          onClick={() => void handleSignOut()}
          style={{
            borderRadius: "0.5rem",
            border: "1px solid transparent",
            backgroundColor: "transparent",
            padding: compact ? "0.28rem 0.5rem" : "0.375rem 0.625rem",
            fontSize: compact ? "0.75rem" : "0.875rem",
            fontWeight: 500,
            color: "#475569",
            cursor: "pointer",
          }}
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <>
      <button
        id="nav-sign-in"
        type="button"
        onClick={() => {
          setError(null);
          setModalOpen(true);
        }}
        style={{
          borderRadius: "0.5rem",
          border: "1px solid #cbd5e1",
          backgroundColor: "#ffffff",
          padding: compact ? "0.32rem 0.7rem" : "0.45rem 0.875rem",
          fontSize: compact ? "0.75rem" : "0.875rem",
          fontWeight: 600,
          color: "#1e293b",
          cursor: "pointer",
        }}
      >
        Sign in
      </button>

      {modalOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="kibitz-login-dialog-title"
              style={{
                position: "fixed",
                inset: 0,
                zIndex: 100,
                display: "flex",
                minHeight: "100dvh",
                alignItems: "center",
                justifyContent: "center",
                overflowY: "auto",
                backgroundColor: "rgba(2, 6, 23, 0.45)",
                padding: "1rem",
                backdropFilter: "blur(2px)",
                fontFamily:
                  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
              }}
              onClick={(e) => {
                if (e.target === e.currentTarget) {
                  setModalOpen(false);
                }
              }}
            >
              <div
                style={{
                  margin: "auto",
                  width: "100%",
                  maxWidth: "28rem",
                  borderRadius: "1rem",
                  border: "1px solid #e7e5e4",
                  backgroundColor: "#ffffff",
                  padding: "1.5rem",
                  boxShadow: "0 20px 25px -5px rgba(15, 23, 42, 0.2)",
                  color: "#0f172a",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: "1rem",
                  }}
                >
                  <div>
                    <h2
                      id="kibitz-login-dialog-title"
                      style={{
                        margin: 0,
                        fontSize: "1.125rem",
                        fontWeight: 700,
                        letterSpacing: "-0.015em",
                        color: "#020617",
                      }}
                    >
                      Sign in with Kibitz ID
                    </h2>
                    <p
                      style={{
                        margin: "0.3rem 0 0",
                        fontSize: "0.75rem",
                        lineHeight: 1.5,
                        color: "#64748b",
                      }}
                    >
                      One session across Kibitz, Scribe, Lecture, and Hall — plus read-only pulls in
                      offline PWAs (Arbiter &amp; Seconds).
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label="Close sign in dialog"
                    onClick={() => setModalOpen(false)}
                    style={{
                      border: "none",
                      backgroundColor: "transparent",
                      borderRadius: "0.375rem",
                      padding: "0.25rem 0.4rem",
                      color: "#94a3b8",
                      cursor: "pointer",
                      fontSize: "0.9rem",
                    }}
                  >
                    ✕
                  </button>
                </div>

                {error ? (
                  <div
                    role="alert"
                    style={{
                      marginTop: "1rem",
                      borderRadius: "0.5rem",
                      border: "1px solid #fecaca",
                      backgroundColor: "#fef2f2",
                      padding: "0.5rem 0.75rem",
                      fontSize: "0.75rem",
                      fontWeight: 500,
                      color: "#b91c1c",
                    }}
                  >
                    {error}
                  </div>
                ) : null}

                <form
                  onSubmit={(e) => void handleLogin(e)}
                  style={{
                    marginTop: "1.25rem",
                    display: "flex",
                    flexDirection: "column",
                    gap: "1rem",
                  }}
                >
                  <div>
                    <label
                      htmlFor="kibitz-auth-login-handle"
                      style={{
                        display: "block",
                        fontSize: "0.75rem",
                        fontWeight: 600,
                        color: "#334155",
                      }}
                    >
                      Handle
                    </label>
                    <input
                      id="kibitz-auth-login-handle"
                      type="text"
                      autoComplete="username"
                      required
                      value={handle}
                      onChange={(e) => setHandle(e.target.value)}
                      placeholder="e.g. admin or coach_alice"
                      style={{
                        marginTop: "0.375rem",
                        display: "block",
                        width: "100%",
                        boxSizing: "border-box",
                        borderRadius: "0.5rem",
                        border: "1px solid #d6d3d1",
                        padding: "0.5rem 0.75rem",
                        fontSize: "0.875rem",
                        color: "#0f172a",
                      }}
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="kibitz-auth-login-password"
                      style={{
                        display: "block",
                        fontSize: "0.75rem",
                        fontWeight: 600,
                        color: "#334155",
                      }}
                    >
                      Password
                    </label>
                    <input
                      id="kibitz-auth-login-password"
                      type="password"
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      style={{
                        marginTop: "0.375rem",
                        display: "block",
                        width: "100%",
                        boxSizing: "border-box",
                        borderRadius: "0.5rem",
                        border: "1px solid #d6d3d1",
                        padding: "0.5rem 0.75rem",
                        fontSize: "0.875rem",
                        color: "#0f172a",
                      }}
                    />
                  </div>

                  <button
                    id="kibitz-auth-login-submit"
                    type="submit"
                    disabled={submitting}
                    style={{
                      width: "100%",
                      borderRadius: "0.5rem",
                      border: "none",
                      backgroundColor: "#0f172a",
                      padding: "0.625rem 1rem",
                      fontSize: "0.875rem",
                      fontWeight: 600,
                      color: "#ffffff",
                      cursor: submitting ? "wait" : "pointer",
                      opacity: submitting ? 0.65 : 1,
                    }}
                  >
                    {submitting ? "Signing in…" : "Sign In"}
                  </button>
                </form>

                <div
                  style={{
                    marginTop: "1.25rem",
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "0.5rem",
                    borderTop: "1px solid #f5f5f4",
                    paddingTop: "1rem",
                    fontSize: "0.75rem",
                    color: "#64748b",
                  }}
                >
                  <span>Invite-only · Zero PII</span>
                  <a
                    href={registerUrl}
                    style={{ fontWeight: 600, color: "#0f172a", textDecoration: "none" }}
                  >
                    Have an invite code? Register →
                  </a>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
