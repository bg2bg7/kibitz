import { AppShell } from "@suite/ui";

export function App() {
  return (
    <AppShell
      appName="Kibitz ID"
      subdomain="id.kibitz.local"
      badge="Invite-Only Identity · Double-Blind Linking"
      subtitle="Shared cross-subdomain authentication, invite redemption, school/program ACLs, and double-blind coach-student linking."
    >
      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-xs">
        <h2 className="text-base font-semibold text-slate-900">Identity Service Shell</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-600">
          <li>Public open registration is disabled; accounts require a valid invite code.</li>
          <li>Coach-student linking is strictly double-blind via POST /links/intent.</li>
          <li>Zero PII required: pseudonymous handles only.</li>
        </ul>
      </section>
    </AppShell>
  );
}
