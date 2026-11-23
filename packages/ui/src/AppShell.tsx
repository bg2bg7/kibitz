import type { ReactNode } from "react";
import { KibitzLogo } from "./KibitzLogo.js";

export interface AppShellProps {
  appName: string;
  subdomain: string;
  badge?: string;
  subtitle?: string;
  homeHref?: string;
  headerRight?: ReactNode;
  children: ReactNode;
}

/**
 * Shared layout shell providing consistent header, Kibitz home link, privacy badge, and responsive container across subdomains.
 */
export function AppShell({
  appName,
  subdomain,
  badge,
  subtitle,
  homeHref,
  headerRight,
  children,
}: AppShellProps) {
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
          padding: "0.85rem 1.5rem",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem",
        }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.75rem" }}>
          {homeHref ? (
            <>
              <a
                href={homeHref}
                aria-label="Back to Kibitz homepage"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  textDecoration: "none",
                  color: "#0f172a",
                }}
              >
                <KibitzLogo size="sm" />
              </a>
              <span
                aria-hidden="true"
                style={{
                  color: "#cbd5e1",
                  fontWeight: 300,
                  userSelect: "none",
                }}
              >
                /
              </span>
            </>
          ) : null}
          <div style={{ display: "flex", alignItems: "baseline", gap: "0.65rem" }}>
            <strong style={{ fontSize: "1.05rem", letterSpacing: "-0.015em" }}>{appName}</strong>
            <code
              style={{
                fontSize: "0.78rem",
                color: "#475569",
                backgroundColor: "#f1f5f9",
                padding: "0.15rem 0.45rem",
                borderRadius: "4px",
              }}
            >
              {subdomain}
            </code>
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.75rem" }}>
          {badge ? (
            <span
              style={{
                fontSize: "0.75rem",
                fontWeight: 600,
                padding: "0.2rem 0.65rem",
                borderRadius: "9999px",
                backgroundColor: "#f1f5f9",
                color: "#334155",
                border: "1px solid #e2e8f0",
              }}
            >
              {badge}
            </span>
          ) : null}
          {headerRight}
          {homeHref ? (
            <a
              href={homeHref}
              style={{
                fontSize: "0.8rem",
                fontWeight: 500,
                color: "#475569",
                textDecoration: "none",
              }}
            >
              ← All Services
            </a>
          ) : null}
        </div>
      </header>

      <main style={{ maxWidth: "64rem", margin: "0 auto", padding: "2rem 1.5rem" }}>
        {subtitle ? (
          <p style={{ marginTop: 0, marginBottom: "1.5rem", color: "#475569", lineHeight: 1.6 }}>
            {subtitle}
          </p>
        ) : null}
        {children}
      </main>
    </div>
  );
}
