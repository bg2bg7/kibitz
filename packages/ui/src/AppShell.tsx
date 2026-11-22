import type { ReactNode } from "react";

export interface AppShellProps {
  appName: string;
  subdomain: string;
  badge?: string;
  subtitle?: string;
  children: ReactNode;
}

/**
 * Shared layout shell providing consistent header, privacy badge, and responsive container across subdomains.
 */
export function AppShell({ appName, subdomain, badge, subtitle, children }: AppShellProps) {
  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: "#f8fafc",
        color: "#0f172a",
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <header
        style={{
          borderBottom: "1px solid #e2e8f0",
          backgroundColor: "#ffffff",
          padding: "0.9rem 1.5rem",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem" }}>
          <strong style={{ fontSize: "1.1rem" }}>{appName}</strong>
          <code
            style={{
              fontSize: "0.8rem",
              color: "#475569",
              backgroundColor: "#f1f5f9",
              padding: "0.15rem 0.45rem",
              borderRadius: "4px",
            }}
          >
            {subdomain}
          </code>
        </div>
        {badge ? (
          <span
            style={{
              fontSize: "0.75rem",
              fontWeight: 600,
              padding: "0.2rem 0.6rem",
              borderRadius: "9999px",
              backgroundColor: "#e0f2fe",
              color: "#0369a1",
            }}
          >
            {badge}
          </span>
        ) : null}
      </header>

      <main style={{ maxWidth: "64rem", margin: "0 auto", padding: "1.5rem" }}>
        {subtitle ? (
          <p style={{ marginTop: 0, marginBottom: "1.25rem", color: "#475569" }}>{subtitle}</p>
        ) : null}
        {children}
      </main>
    </div>
  );
}
