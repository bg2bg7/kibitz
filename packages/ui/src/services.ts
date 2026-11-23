export type SuiteServiceId =
  "kibitz" | "scribe" | "lecture" | "hall" | "arbiter" | "seconds" | "id";

export type SuiteSubServiceId = Exclude<SuiteServiceId, "kibitz">;

export type ServiceStatus = "available" | "coming-soon";

export interface SuiteServiceInfo {
  id: SuiteSubServiceId;
  name: string;
  tagline: string;
  description: string;
  subdomain: string;
  devPort: number;
  apiPort?: number;
  status: ServiceStatus;
  privacyBadge: string;
  envVar: string;
}

export const KIBITZ_HOME_PORT = 5170;
export const KIBITZ_HOME_ENV_VAR = "VITE_KIBITZ_HOME_URL";

/**
 * Canonical catalog of services in the Kibitz Chess Suite.
 * Zero network or auth dependencies — safe for Zero-PII offline PWAs.
 */
export const SUITE_SERVICES: readonly SuiteServiceInfo[] = [
  {
    id: "scribe",
    name: "Scribe",
    tagline: "PGNA v1.0 Authoring Studio",
    description:
      "Compose narrated chess lessons, branching variations, board arrows, and synced audio timelines right in your browser.",
    subdomain: "scribe",
    devPort: 5174,
    status: "available",
    privacyBadge: "Client-First SPA",
    envVar: "VITE_SCRIBE_URL",
  },
  {
    id: "lecture",
    name: "Lecture",
    tagline: "PGNA Lecture Library & Primers",
    description:
      "Browse public opening primers and coach-assigned narrated workbooks with emoji-only student feedback.",
    subdomain: "lecture",
    devPort: 5172,
    apiPort: 4002,
    status: "coming-soon",
    privacyBadge: "Emoji-Only Feedback",
    envVar: "VITE_LECTURE_URL",
  },
  {
    id: "hall",
    name: "Hall",
    tagline: "Scheduled Club Tournaments",
    description:
      "Distraction-free live boards exclusively for arbiter-paired club rounds. No open lobby, no matchmaking, no chat.",
    subdomain: "hall",
    devPort: 5173,
    apiPort: 4003,
    status: "coming-soon",
    privacyBadge: "No Chat · Scheduled Only",
    envVar: "VITE_HALL_URL",
  },
  {
    id: "arbiter",
    name: "Arbiter",
    tagline: "Offline Club & Tournament Manager",
    description:
      "Manage rosters, Swiss pairings, and club standings on-device with IndexedDB storage and JSON backups.",
    subdomain: "arbiter",
    devPort: 5175,
    status: "coming-soon",
    privacyBadge: "100% Offline · Zero-PII",
    envVar: "VITE_ARBITER_URL",
  },
  {
    id: "seconds",
    name: "Seconds",
    tagline: "Parent & Classroom Utility Kit",
    description:
      "Scoresheet-to-PGN helper, rating calculator, printable puzzle worksheets, and high-contrast classroom projector mode.",
    subdomain: "seconds",
    devPort: 5176,
    status: "coming-soon",
    privacyBadge: "100% Offline · Zero-PII",
    envVar: "VITE_SECONDS_URL",
  },
  {
    id: "id",
    name: "Kibitz ID",
    tagline: "Invite-Only Identity & Linking",
    description:
      "Pseudonymous cross-subdomain accounts, invite redemption, and double-blind coach-student linking with zero PII.",
    subdomain: "id",
    devPort: 5171,
    apiPort: 4001,
    status: "coming-soon",
    privacyBadge: "Invite-Only · Double-Blind",
    envVar: "VITE_ID_URL",
  },
] as const;

const KNOWN_SUBDOMAINS = new Set(["www", ...SUITE_SERVICES.map((service) => service.subdomain)]);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface ResolveServiceUrlOptions {
  env?: Record<string, string | undefined>;
  location?: { protocol: string; hostname: string };
}

function getEnvVarName(serviceId: SuiteServiceId): string {
  if (serviceId === "kibitz") {
    return KIBITZ_HOME_ENV_VAR;
  }
  return SUITE_SERVICES.find((s) => s.id === serviceId)?.envVar ?? "";
}

function getDevPort(serviceId: SuiteServiceId): number {
  if (serviceId === "kibitz") {
    return KIBITZ_HOME_PORT;
  }
  return SUITE_SERVICES.find((s) => s.id === serviceId)?.devPort ?? KIBITZ_HOME_PORT;
}

function extractRootDomain(hostname: string): string {
  const parts = hostname.split(".");
  if (parts.length >= 3 && parts[0] && KNOWN_SUBDOMAINS.has(parts[0].toLowerCase())) {
    return parts.slice(1).join(".");
  }
  return hostname;
}

/**
 * Resolves the URL for a Kibitz suite service across local dev ports, production subdomains,
 * and explicit `VITE_*_URL` environment overrides. SSR-safe.
 */
export function resolveServiceUrl(
  serviceId: SuiteServiceId,
  options: ResolveServiceUrlOptions = {},
): string {
  const envKey = getEnvVarName(serviceId);
  const override = envKey ? options.env?.[envKey]?.trim() : undefined;
  if (override) {
    return override.replace(/\/+$/, "");
  }

  const loc =
    options.location ??
    (typeof window !== "undefined"
      ? { protocol: window.location.protocol, hostname: window.location.hostname }
      : undefined);

  if (!loc || LOCAL_HOSTS.has(loc.hostname)) {
    const host = loc?.hostname ?? "localhost";
    const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    return `http://${formattedHost}:${getDevPort(serviceId)}`;
  }

  const protocol = loc.protocol === "http:" ? "http:" : "https:";
  const rootDomain = extractRootDomain(loc.hostname);

  if (serviceId === "kibitz") {
    return `${protocol}//${rootDomain}`;
  }

  return `${protocol}//${serviceId}.${rootDomain}`;
}
