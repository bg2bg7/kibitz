import { useEffect, useState, type FormEvent } from "react";
import {
  AccessibleDialog,
  fetchKibitzSession,
  loginWithKibitzId,
  logoutKibitzSession,
  performKibitzSignOut,
  resolveServiceUrl,
  type KibitzSessionUser,
} from "@suite/ui";

const VITE_ENV = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

export interface AuthMenuProps {
  /** Optional initial user state (primarily for SSR / tests). */
  initialUser?: KibitzSessionUser | null;
  /** Optional initial sign-out error banner message (primarily for SSR / tests). */
  initialSignOutError?: string | null;
  /** Optional initial modal open state (primarily for SSR / tests). */
  initialModalOpen?: boolean;
}

export function AuthMenu({
  initialUser = null,
  initialSignOutError = null,
  initialModalOpen = false,
}: AuthMenuProps) {
  const idUrl = resolveServiceUrl("id", { env: VITE_ENV });
  const homeUrl = resolveServiceUrl("kibitz", { env: VITE_ENV });
  const registerUrl = `${idUrl}/?mode=register&returnTo=${encodeURIComponent(homeUrl)}`;

  const [user, setUser] = useState<KibitzSessionUser | null>(initialUser);
  const [modalOpen, setModalOpen] = useState(initialModalOpen);
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(initialSignOutError);

  useEffect(() => {
    let mounted = true;
    void fetchKibitzSession({ env: VITE_ENV }).then((session) => {
      if (mounted && session.authenticated) {
        setUser(session.user);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await loginWithKibitzId({ handle: handle.trim(), password }, { env: VITE_ENV });
    setSubmitting(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    setSignOutError(null);
    setUser(result.user);
    setPassword("");
    setModalOpen(false);
  };

  const handleSignOut = async () => {
    if (signingOut) return;
    await performKibitzSignOut({
      logout: () => logoutKibitzSession({ env: VITE_ENV }),
      onStart: () => {
        setSigningOut(true);
        setSignOutError(null);
      },
      onSuccess: () => {
        setSignOutError(null);
        setUser(null);
      },
      onFailure: (message) => {
        setSignOutError(message);
      },
      onFinally: () => {
        setSigningOut(false);
      },
    });
  };

  if (user) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <a
          id="nav-account-link"
          href={idUrl}
          className="inline-flex items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 transition hover:border-stone-300 hover:bg-stone-50"
        >
          <span>@{user.handle}</span>
          <span className="rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-amber-300 uppercase">
            {user.role}
          </span>
        </a>
        <button
          id="nav-sign-out"
          type="button"
          disabled={signingOut}
          onClick={() => void handleSignOut()}
          className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-stone-200/60 hover:text-slate-900 disabled:cursor-wait disabled:opacity-60"
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
        {signOutError ? (
          <div
            role="alert"
            className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700"
          >
            <span>{signOutError}</span>
            <button
              id="nav-sign-out-retry"
              type="button"
              disabled={signingOut}
              onClick={() => void handleSignOut()}
              className="rounded border border-red-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-red-800 transition hover:bg-red-100 disabled:cursor-wait disabled:opacity-60"
            >
              Retry
            </button>
          </div>
        ) : null}
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
        className="rounded-lg border border-stone-300 bg-white px-3.5 py-2 text-sm font-semibold text-slate-800 transition hover:border-stone-400 hover:bg-stone-50"
      >
        Sign in
      </button>

      <AccessibleDialog
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        ariaLabelledBy="kibitz-login-dialog-title"
        overlayClassName="fixed inset-0 z-50 flex min-h-dvh items-center justify-center overflow-y-auto bg-slate-950/45 p-4 backdrop-blur-xs"
        panelClassName="my-auto w-full max-w-md rounded-2xl border border-stone-200 bg-white p-6 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              id="kibitz-login-dialog-title"
              className="text-lg font-bold tracking-tight text-slate-950"
            >
              Sign in with Kibitz ID
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              One session across Kibitz, Scribe, Lecture, and Hall — plus read-only pulls in
              offline PWAs (Arbiter &amp; Seconds).
            </p>
          </div>
          <button
            type="button"
            aria-label="Close sign in dialog"
            onClick={() => setModalOpen(false)}
            className="rounded-md p-1 text-slate-400 transition hover:bg-stone-100 hover:text-slate-700"
          >
            ✕
          </button>
        </div>

        {error ? (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700"
          >
            {error}
          </div>
        ) : null}

        <form onSubmit={(e) => void handleLogin(e)} className="mt-5 space-y-4">
          <div>
            <label
              htmlFor="home-login-handle"
              className="block text-xs font-semibold text-slate-700"
            >
              Handle
            </label>
            <input
              id="home-login-handle"
              type="text"
              autoComplete="username"
              required
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="e.g. admin or coach_alice"
              className="mt-1.5 block w-full rounded-lg border border-stone-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="home-login-password"
              className="block text-xs font-semibold text-slate-700"
            >
              Password
            </label>
            <input
              id="home-login-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1.5 block w-full rounded-lg border border-stone-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
            />
          </div>

          <button
            id="home-login-submit"
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
          >
            {submitting ? "Signing in…" : "Sign In"}
          </button>
        </form>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 pt-4 text-xs text-slate-500">
          <span>Invite-only · Zero PII</span>
          <a href={registerUrl} className="font-semibold text-slate-900 hover:underline">
            Have an invite code? Register →
          </a>
        </div>
      </AccessibleDialog>
    </>
  );
}
