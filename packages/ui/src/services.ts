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
    status: "available",
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
    status: "available",
    privacyBadge: "Invite-Only · Double-Blind",
    envVar: "VITE_ID_URL",
  },
] as const;

export type SuiteApiServiceId = "id" | "lecture" | "hall";

const API_SERVICE_CONFIG: Record<SuiteApiServiceId, { port: number; envVar: string }> = {
  id: { port: 4001, envVar: "VITE_ID_API_URL" },
  lecture: { port: 4002, envVar: "VITE_LECTURE_API_URL" },
  hall: { port: 4003, envVar: "VITE_HALL_API_URL" },
};

const KNOWN_SUBDOMAINS = new Set(["www", ...SUITE_SERVICES.map((service) => service.subdomain)]);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const ALLOWED_DEV_PORTS = new Set([
  String(KIBITZ_HOME_PORT),
  ...SUITE_SERVICES.map((service) => String(service.devPort)),
]);

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

function resolveCurrentLocation(options: ResolveServiceUrlOptions) {
  return (
    options.location ??
    (typeof window !== "undefined"
      ? { protocol: window.location.protocol, hostname: window.location.hostname }
      : undefined)
  );
}

/**
 * Resolves the URL for a Kibitz suite web service across local dev ports, production subdomains,
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

  const loc = resolveCurrentLocation(options);

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

/**
 * Resolves the backend API base URL for hybrid services (`id`, `lecture`, `hall`).
 * Uses `VITE_*_API_URL` overrides first, localhost dev ports (`4001`–`4003`) locally,
 * and `<service>.<rootDomain>` in production.
 */
export function resolveApiUrl(
  serviceId: SuiteApiServiceId,
  options: ResolveServiceUrlOptions = {},
): string {
  const cfg = API_SERVICE_CONFIG[serviceId];
  const override = options.env?.[cfg.envVar]?.trim();
  if (override) {
    return override.replace(/\/+$/, "");
  }

  const loc = resolveCurrentLocation(options);

  if (!loc || LOCAL_HOSTS.has(loc.hostname)) {
    const host = loc?.hostname ?? "localhost";
    const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    return `http://${formattedHost}:${cfg.port}`;
  }

  const protocol = loc.protocol === "http:" ? "http:" : "https:";
  const rootDomain = extractRootDomain(loc.hostname);
  return `${protocol}//${serviceId}.${rootDomain}`;
}

/**
 * Validates that a `returnTo` redirect URL points strictly to a Kibitz suite origin,
 * preventing open redirects after login/registration.
 */
export function isAllowedSuiteUrl(
  rawUrl: string | null | undefined,
  options: ResolveServiceUrlOptions = {},
): boolean {
  if (!rawUrl) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  if (parsed.username || parsed.password) {
    return false;
  }

  const targetHost = parsed.hostname.toLowerCase();
  const loc = resolveCurrentLocation(options);

  if (!loc || LOCAL_HOSTS.has(loc.hostname)) {
    return LOCAL_HOSTS.has(targetHost) && ALLOWED_DEV_PORTS.has(parsed.port);
  }

  if (parsed.protocol !== "https:") {
    return false;
  }

  const rootDomain = extractRootDomain(loc.hostname).toLowerCase();
  if (targetHost === rootDomain) {
    return true;
  }

  if (targetHost.endsWith(`.${rootDomain}`)) {
    const sub = targetHost.slice(0, -(rootDomain.length + 1));
    return KNOWN_SUBDOMAINS.has(sub);
  }

  return false;
}
