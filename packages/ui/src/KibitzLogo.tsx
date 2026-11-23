import type { CSSProperties } from "react";

export interface KibitzLogoProps {
  size?: "sm" | "md" | "lg";
  showWordmark?: boolean;
  subtitle?: string;
  style?: CSSProperties;
}

const ICON_SIZES: Record<NonNullable<KibitzLogoProps["size"]>, number> = {
  sm: 28,
  md: 36,
  lg: 44,
};

const WORDMARK_SIZES: Record<NonNullable<KibitzLogoProps["size"]>, string> = {
  sm: "1rem",
  md: "1.2rem",
  lg: "1.5rem",
};

/**
 * Shared Kibitz brand emblem (inline SVG knight + board corner mark) and wordmark.
 */
export function KibitzLogo({ size = "md", showWordmark = true, subtitle, style }: KibitzLogoProps) {
  const iconPx = ICON_SIZES[size];

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: size === "sm" ? "0.5rem" : "0.65rem",
        textDecoration: "none",
        ...style,
      }}
    >
      <svg
        width={iconPx}
        height={iconPx}
        viewBox="0 0 40 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        style={{ flexShrink: 0, display: "block" }}
      >
        <rect width="40" height="40" rx="10" fill="#0F172A" />
        <rect x="4" y="4" width="16" height="16" rx="6" fill="#1E293B" />
        <rect x="20" y="20" width="16" height="16" rx="6" fill="#1E293B" />
        <path
          d="M14.2 29.5H26.4V26.9H14.2V29.5ZM15.5 25.3H25.2C25.5 21.8 25.1 18.2 23.8 15.2C22.8 12.9 21 11.4 18.7 10.7L18.1 9.2L16.3 10.6C14.7 11.2 13.4 12.3 12.6 13.7L11.6 15.6C11.3 16.2 11.5 16.9 12.1 17.2L13.5 17.9C14.2 18.2 15 18.1 15.5 17.6L17.1 16.2C17.4 16 17.8 16.2 17.7 16.6C17.3 18.5 16.3 20.1 14.9 21.5C14.3 22.1 14.1 22.9 14.3 23.7L14.6 24.7C14.7 25.1 15.1 25.3 15.5 25.3Z"
          fill="#FBBF24"
        />
        <circle cx="15.8" cy="13.8" r="1.1" fill="#0F172A" />
      </svg>
      {showWordmark ? (
        <span style={{ display: "inline-flex", flexDirection: "column", lineHeight: 1.1 }}>
          <span
            style={{
              fontSize: WORDMARK_SIZES[size],
              fontWeight: 700,
              letterSpacing: "-0.025em",
              color: "#0F172A",
            }}
          >
            Kibitz
          </span>
          {subtitle ? (
            <span
              style={{
                fontSize: "0.72rem",
                fontWeight: 500,
                color: "#64748B",
                marginTop: "0.1rem",
              }}
            >
              {subtitle}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
