import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  AppShell,
  fetchKibitzSession,
  isAllowedSuiteUrl,
  loginWithKibitzId,
  logoutKibitzSession,
  resolveApiUrl,
  resolveServiceUrl,
  type KibitzSessionUser,
  type KibitzUserRole,
} from "@suite/ui";

const VITE_ENV = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

interface InviteItem {
  code: string;
  assignedRole: KibitzUserRole;
  maxUses: number;
  usedCount: number;
  expiresAt: string | null;
  createdAt: string;
}

interface ActiveLinkItem {
  peerUserId: string;
  peerHandle: string;
  peerRole: KibitzUserRole;
  relation: "coach" | "student";
  createdAt: string;
}

type AuthTab = "login" | "register";

function getInitialQueryParams(): { tab: AuthTab; invite: string; returnTo: string | null } {
  if (typeof window === "undefined") {
    return { tab: "login", invite: "", returnTo: null };
  }
  const params = new URLSearchParams(window.location.search);
  const invite = params.get("invite")?.trim() ?? "";
  const mode = params.get("mode");
  const rawReturnTo = params.get("returnTo");
  const safeReturnTo =
    rawReturnTo && isAllowedSuiteUrl(rawReturnTo, { env: VITE_ENV }) ? rawReturnTo : null;
  return {
    tab: mode === "register" || invite ? "register" : "login",
    invite,
    returnTo: safeReturnTo,
  };
}

export interface IdAppProps {
  initialUser?: KibitzSessionUser | null;
  initialLogoutError?: string | null;
}

export function App({ initialUser = null, initialLogoutError = null }: IdAppProps) {
  const initialParams = getInitialQueryParams();
  const homeUrl = resolveServiceUrl("kibitz", { env: VITE_ENV });
  const idWebUrl = resolveServiceUrl("id", { env: VITE_ENV });
  const idApiUrl = resolveApiUrl("id", { env: VITE_ENV });

  const [sessionLoading, setSessionLoading] = useState(initialUser === null);
  const [user, setUser] = useState<KibitzSessionUser | null>(initialUser);
  const [activeTab, setActiveTab] = useState<AuthTab>(initialParams.tab);
  const [returnTo] = useState<string | null>(initialParams.returnTo);

  // Login form state
  const [loginHandle, setLoginHandle] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);

  // Register (invite redemption) form state
  const [inviteCode, setInviteCode] = useState(initialParams.invite);
  const [regHandle, setRegHandle] = useState("");
  const [regPassword, setRegPassword] = useState("");

  // Signed-in management state
  const [logoutError, setLogoutError] = useState<string | null>(initialLogoutError);
  const [logoutSubmitting, setLogoutSubmitting] = useState(false);
  const [invites, setInvites] = useState<InviteItem[]>([]);
  const [inviteRole, setInviteRole] = useState<KibitzUserRole>("student");
  const [inviteMaxUses, setInviteMaxUses] = useState("1");
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const [links, setLinks] = useState<ActiveLinkItem[]>([]);
  const [targetHandle, setTargetHandle] = useState("");
  const [linkNotice, setLinkNotice] = useState<string | null>(null);

  const loadAccountData = useCallback(
    async (currentUser: KibitzSessionUser) => {
      try {
        const linksRes = await fetch(`${idApiUrl}/links`, {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        if (linksRes.ok) {
          const data = (await linksRes.json()) as { links?: ActiveLinkItem[] };
          setLinks(data.links ?? []);
        }
      } catch {
        // Ignore transient network errors when offline
      }

      if (currentUser.role === "admin" || currentUser.role === "coach") {
        try {
          const invitesRes = await fetch(`${idApiUrl}/invites`, {
            credentials: "include",
            headers: { Accept: "application/json" },
          });
          if (invitesRes.ok) {
            const data = (await invitesRes.json()) as { invites?: InviteItem[] };
            setInvites(data.invites ?? []);
          }
        } catch {
          // Ignore transient network errors when offline
        }
      }
    },
    [idApiUrl],
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      const session = await fetchKibitzSession({ env: VITE_ENV });
      if (!active) return;
      setUser(session.authenticated ? session.user : null);
      setSessionLoading(false);
      if (session.authenticated && session.user) {
        await loadAccountData(session.user);
      }
    })();
    return () => {
      active = false;
    };
  }, [loadAccountData]);

  const handleLoginSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthSubmitting(true);

    const res = await loginWithKibitzId(
      { handle: loginHandle.trim(), password: loginPassword },
      { env: VITE_ENV },
    );

    setAuthSubmitting(false);
    if (!res.ok) {
      setAuthError(res.error);
      return;
    }

    setLoginPassword("");
    setLogoutError(null);
    if (returnTo && typeof window !== "undefined") {
      window.location.assign(returnTo);
      return;
    }
    setUser(res.user);
    await loadAccountData(res.user);
  };

  const handleRegisterSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthSubmitting(true);

    try {
      const res = await fetch(`${idApiUrl}/auth/register`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          inviteCode: inviteCode.trim(),
          handle: regHandle.trim(),
          password: regPassword,
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        user?: KibitzSessionUser;
        error?: string;
      } | null;

      if (!res.ok || !body?.user) {
        setAuthError(body?.error ?? `Registration failed (HTTP ${res.status}).`);
        setAuthSubmitting(false);
        return;
      }

      setRegPassword("");
      setLogoutError(null);
      setAuthSubmitting(false);
      if (returnTo && typeof window !== "undefined") {
        window.location.assign(returnTo);
        return;
      }
      setUser(body.user);
      await loadAccountData(body.user);
    } catch {
      setAuthError("Unable to reach Kibitz ID service.");
      setAuthSubmitting(false);
    }
  };

  const handleLogout = async () => {
    setLogoutError(null);
    setLogoutSubmitting(true);
    const ok = await logoutKibitzSession({ env: VITE_ENV });
    setLogoutSubmitting(false);
    if (!ok) {
      setLogoutError(
        "Unable to sign out cleanly. Your session may still be active — please try again.",
      );
      return;
    }
    setUser(null);
    setInvites([]);
    setLinks([]);
  };

  const handleCreateInvite = async (e: FormEvent) => {
    e.preventDefault();
    setInviteStatus(null);
    const parsedMaxUses = Math.max(1, Math.min(500, Number(inviteMaxUses) || 1));
    try {
      const res = await fetch(`${idApiUrl}/invites`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          assignedRole: user?.role === "coach" ? "student" : inviteRole,
          maxUses: parsedMaxUses,
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        invite?: InviteItem;
        error?: string;
      } | null;
      if (!res.ok || !body?.invite) {
        setInviteStatus(body?.error ?? "Could not create invite.");
        return;
      }
      setInvites((prev) => [body.invite!, ...prev]);
      setInviteStatus(`Created invite ${body.invite.code}.`);
    } catch {
      setInviteStatus("Unable to reach Kibitz ID service.");
    }
  };

  const handleCopyInviteLink = async (code: string) => {
    const link = `${idWebUrl}/?mode=register&invite=${encodeURIComponent(code)}`;
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(link).catch(() => undefined);
    }
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  const handleLinkIntentSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLinkNotice(null);
    const cleaned = targetHandle.trim();
    if (!cleaned) return;
    try {
      const res = await fetch(`${idApiUrl}/links/intent`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ targetHandle: cleaned }),
      });
      const body = (await res.json().catch(() => null)) as {
        message?: string;
        error?: string;
      } | null;
      if (!res.ok) {
        setLinkNotice(body?.error ?? "Could not submit link intent.");
        return;
      }
      setTargetHandle("");
      setLinkNotice(
        body?.message ??
          "If both accounts submit matching handles, the link will activate automatically.",
      );
      if (user) {
        await loadAccountData(user);
      }
    } catch {
      setLinkNotice("Unable to reach Kibitz ID service.");
    }
  };

  const handleRevokeLink = async (peerUserId: string) => {
    try {
      const res = await fetch(`${idApiUrl}/links/${encodeURIComponent(peerUserId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        setLinks((prev) => prev.filter((item) => item.peerUserId !== peerUserId));
      }
    } catch {
      // Ignore transient network errors
    }
  };

  return (
    <AppShell
      appName="Kibitz ID"
      subdomain="id.kibitz.local"
      badge="Invite-Only Identity · Double-Blind Linking"
      homeHref={homeUrl}
    >
      {user ? (
        <div className="space-y-6">
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-2xs">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
                  Active Cross-Service Session
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2.5">
                  <h1 className="text-2xl font-bold tracking-tight text-slate-950">
                    @{user.handle}
                  </h1>
                  <span className="rounded-full bg-slate-900 px-2.5 py-0.5 text-xs font-semibold text-amber-300 capitalize">
                    {user.role}
                  </span>
                </div>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600">
                  Your HttpOnly session cookie is active across Kibitz, Scribe, Lecture, and Hall.
                  Offline PWAs (Arbiter &amp; Seconds) can pull read-only data using this session
                  without ever uploading rosters or student data.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                {returnTo ? (
                  <a
                    href={returnTo}
                    className="rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
                  >
                    Continue Back →
                  </a>
                ) : (
                  <a
                    href={homeUrl}
                    className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
                  >
                    Back to Kibitz
                  </a>
                )}
                <button
                  id="id-sign-out-button"
                  type="button"
                  disabled={logoutSubmitting}
                  onClick={() => void handleLogout()}
                  className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2 text-sm font-medium text-red-700 transition hover:bg-red-100 disabled:opacity-60"
                >
                  {logoutSubmitting ? "Signing out…" : "Sign Out"}
                </button>
              </div>
            </div>

            {logoutError ? (
              <div
                id="id-sign-out-error"
                role="alert"
                className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700"
              >
                <span>{logoutError}</span>
                <button
                  id="id-sign-out-retry-button"
                  type="button"
                  disabled={logoutSubmitting}
                  onClick={() => void handleLogout()}
                  className="rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-semibold text-red-700 transition hover:bg-red-100 disabled:opacity-60"
                >
                  {logoutSubmitting ? "Retrying…" : "Retry Sign Out"}
                </button>
              </div>
            ) : null}
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-2xs">
              <h2 className="text-base font-semibold text-slate-900">
                Double-Blind Coach-Student Linking
              </h2>
              <p className="mt-1.5 text-sm text-slate-600">
                Enter your coach or student&apos;s handle. Responses are strictly opaque — a link
                activates only when both sides submit matching handles.
              </p>

              <form onSubmit={(e) => void handleLinkIntentSubmit(e)} className="mt-4 flex gap-2">
                <input
                  id="link-target-handle"
                  type="text"
                  required
                  value={targetHandle}
                  onChange={(e) => setTargetHandle(e.target.value)}
                  placeholder="Enter handle (e.g. coach_alice)"
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                />
                <button
                  type="submit"
                  className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
                >
                  Submit
                </button>
              </form>

              {linkNotice ? (
                <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                  {linkNotice}
                </p>
              ) : null}

              <div className="mt-5 border-t border-slate-100 pt-4">
                <h3 className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
                  Active Mutual Links ({links.length})
                </h3>
                {links.length === 0 ? (
                  <p className="mt-2 text-sm text-slate-500">No active coach-student links yet.</p>
                ) : (
                  <ul className="mt-2 divide-y divide-slate-100">
                    {links.map((item) => (
                      <li
                        key={item.peerUserId}
                        className="flex items-center justify-between gap-3 py-2.5 text-sm"
                      >
                        <div>
                          <span className="font-medium text-slate-900">@{item.peerHandle}</span>
                          <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600 capitalize">
                            {item.relation}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleRevokeLink(item.peerUserId)}
                          className="text-xs font-medium text-red-600 hover:text-red-800"
                        >
                          Revoke
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            {user.role === "admin" || user.role === "coach" ? (
              <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-2xs">
                <h2 className="text-base font-semibold text-slate-900">Invite Codes</h2>
                <p className="mt-1.5 text-sm text-slate-600">
                  Public registration is disabled. Issue single-use or quota-limited invite codes to
                  onboard new accounts.
                </p>

                <form
                  onSubmit={(e) => void handleCreateInvite(e)}
                  className="mt-4 flex flex-wrap items-end gap-3"
                >
                  <label className="flex flex-col gap-1 text-xs font-medium text-slate-700">
                    Role
                    <select
                      value={user.role === "coach" ? "student" : inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as KibitzUserRole)}
                      disabled={user.role === "coach"}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                    >
                      <option value="student">Student</option>
                      {user.role === "admin" ? (
                        <>
                          <option value="coach">Coach</option>
                          <option value="moderator">Moderator</option>
                          <option value="admin">Admin</option>
                        </>
                      ) : null}
                    </select>
                  </label>

                  <label className="flex w-24 flex-col gap-1 text-xs font-medium text-slate-700">
                    Max Uses
                    <input
                      type="number"
                      min={1}
                      max={500}
                      value={inviteMaxUses}
                      onChange={(e) => setInviteMaxUses(e.target.value)}
                      className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
                    />
                  </label>

                  <button
                    type="submit"
                    className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
                  >
                    Generate Invite
                  </button>
                </form>

                {inviteStatus ? (
                  <p className="mt-3 text-xs font-medium text-slate-700">{inviteStatus}</p>
                ) : null}

                <div className="mt-5 border-t border-slate-100 pt-4">
                  <h3 className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
                    Issued Invites ({invites.length})
                  </h3>
                  {invites.length === 0 ? (
                    <p className="mt-2 text-sm text-slate-500">No invites issued yet.</p>
                  ) : (
                    <ul className="mt-2 divide-y divide-slate-100">
                      {invites.map((inv) => (
                        <li
                          key={inv.code}
                          className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
                        >
                          <div className="flex items-center gap-2">
                            <code className="rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-900">
                              {inv.code}
                            </code>
                            <span className="text-xs text-slate-500 capitalize">
                              {inv.assignedRole} · {inv.usedCount}/{inv.maxUses} used
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleCopyInviteLink(inv.code)}
                            className="text-xs font-medium text-slate-700 hover:text-slate-950"
                          >
                            {copiedCode === inv.code ? "Copied Link" : "Copy Link"}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="grid gap-8 lg:grid-cols-12 lg:items-start">
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-2xs lg:col-span-7">
            <div className="flex items-center justify-between gap-4 border-b border-slate-100 pb-4">
              <h1 className="text-xl font-bold tracking-tight text-slate-950">
                {activeTab === "login" ? "Sign in to Kibitz ID" : "Redeem an Invite Code"}
              </h1>
              <div
                role="tablist"
                aria-label="Authentication mode"
                className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5 text-xs font-medium"
              >
                <button
                  id="tab-sign-in"
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "login"}
                  onClick={() => {
                    setActiveTab("login");
                    setAuthError(null);
                  }}
                  className={`rounded-md px-3 py-1.5 transition ${
                    activeTab === "login"
                      ? "bg-white text-slate-900 shadow-2xs"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  Sign In
                </button>
                <button
                  id="tab-redeem-invite"
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "register"}
                  onClick={() => {
                    setActiveTab("register");
                    setAuthError(null);
                  }}
                  className={`rounded-md px-3 py-1.5 transition ${
                    activeTab === "register"
                      ? "bg-white text-slate-900 shadow-2xs"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  Redeem Invite
                </button>
              </div>
            </div>

            {sessionLoading ? (
              <p className="mt-4 text-xs text-slate-500">Checking existing session…</p>
            ) : null}

            {authError ? (
              <div
                role="alert"
                className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700"
              >
                {authError}
              </div>
            ) : null}

            {activeTab === "login" ? (
              <form onSubmit={(e) => void handleLoginSubmit(e)} className="mt-5 space-y-4">
                <div>
                  <label
                    htmlFor="id-login-handle"
                    className="block text-sm font-medium text-slate-800"
                  >
                    Handle
                  </label>
                  <input
                    id="id-login-handle"
                    type="text"
                    autoComplete="username"
                    required
                    value={loginHandle}
                    onChange={(e) => setLoginHandle(e.target.value)}
                    placeholder="e.g. admin or coach_alice"
                    className="mt-1.5 block w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                  />
                </div>

                <div>
                  <label
                    htmlFor="id-login-password"
                    className="block text-sm font-medium text-slate-800"
                  >
                    Password
                  </label>
                  <input
                    id="id-login-password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    className="mt-1.5 block w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                  />
                </div>

                <button
                  id="id-login-submit"
                  type="submit"
                  disabled={authSubmitting}
                  className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
                >
                  {authSubmitting ? "Signing in…" : "Sign In"}
                </button>
              </form>
            ) : (
              <form onSubmit={(e) => void handleRegisterSubmit(e)} className="mt-5 space-y-4">
                <div>
                  <label
                    htmlFor="id-register-invite"
                    className="block text-sm font-medium text-slate-800"
                  >
                    Invite Code
                  </label>
                  <input
                    id="id-register-invite"
                    type="text"
                    required
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    placeholder="KBZ-XXXX-XXXX-XXXX"
                    className="mt-1.5 block w-full rounded-lg border border-slate-300 px-3.5 py-2.5 font-mono text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                  />
                </div>

                <div>
                  <label
                    htmlFor="id-register-handle"
                    className="block text-sm font-medium text-slate-800"
                  >
                    Pseudonymous Handle
                  </label>
                  <input
                    id="id-register-handle"
                    type="text"
                    autoComplete="username"
                    required
                    value={regHandle}
                    onChange={(e) => setRegHandle(e.target.value)}
                    placeholder="letters, numbers, _ or - (no email)"
                    className="mt-1.5 block w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                  />
                </div>

                <div>
                  <label
                    htmlFor="id-register-password"
                    className="block text-sm font-medium text-slate-800"
                  >
                    Password (min 10 characters)
                  </label>
                  <input
                    id="id-register-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={10}
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    className="mt-1.5 block w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                  />
                </div>

                <button
                  id="id-register-submit"
                  type="submit"
                  disabled={authSubmitting}
                  className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
                >
                  {authSubmitting ? "Creating account…" : "Create Account with Invite"}
                </button>
              </form>
            )}
          </section>

          <aside className="rounded-2xl border border-slate-200 bg-white p-6 shadow-2xs lg:col-span-5">
            <h2 className="text-sm font-semibold tracking-wider text-slate-500 uppercase">
              How Kibitz ID Works
            </h2>
            <ul className="mt-4 space-y-3 text-sm leading-relaxed text-slate-600">
              <li>
                <strong className="font-semibold text-slate-900">One login across services:</strong>{" "}
                Signing in sets a single HttpOnly session cookie shared across Kibitz, Scribe,
                Lecture, and Hall.
              </li>
              <li>
                <strong className="font-semibold text-slate-900">
                  Read-only pull for offline PWAs:
                </strong>{" "}
                Arbiter and Seconds can pull scheduled tournament data using your Kibitz ID session
                without ever uploading club rosters or student names.
              </li>
              <li>
                <strong className="font-semibold text-slate-900">
                  Zero-PII &amp; invite-only:
                </strong>{" "}
                No open registration, no student emails, and no real names — pseudonymous handles
                only.
              </li>
            </ul>
          </aside>
        </div>
      )}
    </AppShell>
  );
}
