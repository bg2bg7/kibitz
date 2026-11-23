import { SessionPayloadSchema, type SessionPayload, type UserRole } from "./types.js";

export const SESSION_COOKIE_NAME = "kibitz_session";
export const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
export const DEFAULT_DEV_JWT_SECRET = "dev-only-replace-me-with-at-least-32-random-bytes";

const KNOWN_SUITE_SUBDOMAINS = new Set([
  "www",
  "id",
  "lecture",
  "hall",
  "scribe",
  "arbiter",
  "seconds",
]);

const DEV_LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const DEV_ALLOWED_PORTS = new Set([
  "5170",
  "5171",
  "5172",
  "5173",
  "5174",
  "5175",
  "5176",
  "4001",
  "4002",
  "4003",
]);

export interface SessionJwtConfig {
  secret: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
  cookieDomain: string;
  secureCookie: boolean;
  allowedOrigins: readonly string[];
}

export interface SignSessionInput {
  sub: string;
  handle: string;
  role: UserRole;
  programIds?: string[];
}

export interface SessionVerificationResult {
  valid: boolean;
  payload: SessionPayload | null;
  reason?: "invalid_schema" | "expired" | "invalid_signature" | "invalid_claims";
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function encodeBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += BASE64_ALPHABET[(triple >> 18) & 0x3f];
    out += BASE64_ALPHABET[(triple >> 12) & 0x3f];
    if (i + 1 < bytes.length) {
      out += BASE64_ALPHABET[(triple >> 6) & 0x3f];
    }
    if (i + 2 < bytes.length) {
      out += BASE64_ALPHABET[triple & 0x3f];
    }
  }
  return out;
}

function decodeBase64Url(input: string): Uint8Array | null {
  if (!input || !/^[A-Za-z0-9_-]+$/.test(input)) {
    return null;
  }
  const remainder = input.length % 4;
  if (remainder === 1) {
    return null;
  }
  const outputLength = Math.floor((input.length * 3) / 4);
  const bytes = new Uint8Array(outputLength);
  let byteIdx = 0;

  for (let i = 0; i < input.length; i += 4) {
    const c0 = BASE64_ALPHABET.indexOf(input[i] ?? "");
    const c1 = BASE64_ALPHABET.indexOf(input[i + 1] ?? "");
    const c2 = i + 2 < input.length ? BASE64_ALPHABET.indexOf(input[i + 2] ?? "") : 0;
    const c3 = i + 3 < input.length ? BASE64_ALPHABET.indexOf(input[i + 3] ?? "") : 0;
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) {
      return null;
    }
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (byteIdx < outputLength) bytes[byteIdx++] = (triple >> 16) & 0xff;
    if (byteIdx < outputLength) bytes[byteIdx++] = (triple >> 8) & 0xff;
    if (byteIdx < outputLength) bytes[byteIdx++] = triple & 0xff;
  }

  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function importHmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  if (!secret || secret.length < 16) {
    throw new Error("AUTH_JWT_SECRET must be at least 16 characters long.");
  }
  return globalThis.crypto.subtle.importKey(
    "raw",
    toArrayBuffer(textEncoder.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/**
 * Validates the structure and expiry of a decoded cross-subdomain session payload.
 * Cryptographic signature verification (`verifySessionToken`) runs before calling this helper.
 */
export function validateSessionPayload(
  rawPayload: unknown,
  nowEpochSeconds: number = Math.floor(Date.now() / 1000),
): SessionVerificationResult {
  const parsed = SessionPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return { valid: false, payload: null, reason: "invalid_schema" };
  }
  if (parsed.data.exp <= nowEpochSeconds) {
    return { valid: false, payload: null, reason: "expired" };
  }
  return { valid: true, payload: parsed.data };
}

/**
 * Signs a cross-subdomain HS256 JWT for KibitzID sessions using Web Crypto.
 */
export async function signSessionToken(
  input: SignSessionInput,
  config: Pick<SessionJwtConfig, "secret" | "issuer" | "audience" | "ttlSeconds">,
  nowEpochSeconds: number = Math.floor(Date.now() / 1000),
): Promise<{ token: string; payload: SessionPayload }> {
  const payload: SessionPayload = SessionPayloadSchema.parse({
    sub: input.sub,
    handle: input.handle,
    role: input.role,
    programIds: input.programIds ?? [],
    iat: nowEpochSeconds,
    exp: nowEpochSeconds + config.ttlSeconds,
  });

  const headerB64 = encodeBase64Url(
    textEncoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const claimsB64 = encodeBase64Url(
    textEncoder.encode(
      JSON.stringify({
        ...payload,
        iss: config.issuer,
        aud: config.audience,
      }),
    ),
  );

  const signingInput = `${headerB64}.${claimsB64}`;
  const key = await importHmacKey(config.secret, "sign");
  const signatureBuffer = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    toArrayBuffer(textEncoder.encode(signingInput)),
  );
  const sigB64 = encodeBase64Url(new Uint8Array(signatureBuffer));

  return {
    token: `${signingInput}.${sigB64}`,
    payload,
  };
}

/**
 * Verifies an HS256 JWT signature (constant-time via Web Crypto), checks issuer/audience/expiry,
 * and validates the payload against `SessionPayloadSchema`.
 */
export async function verifySessionToken(
  token: string,
  config: Pick<SessionJwtConfig, "secret" | "issuer" | "audience">,
  nowEpochSeconds: number = Math.floor(Date.now() / 1000),
): Promise<SessionVerificationResult> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { valid: false, payload: null, reason: "invalid_signature" };
  }

  const [headerB64, claimsB64, sigB64] = parts;
  if (!headerB64 || !claimsB64 || !sigB64) {
    return { valid: false, payload: null, reason: "invalid_signature" };
  }

  const headerBytes = decodeBase64Url(headerB64);
  const claimsBytes = decodeBase64Url(claimsB64);
  const sigBytes = decodeBase64Url(sigB64);
  if (!headerBytes || !claimsBytes || !sigBytes) {
    return { valid: false, payload: null, reason: "invalid_signature" };
  }

  let headerJson: unknown;
  let claimsJson: unknown;
  try {
    headerJson = JSON.parse(textDecoder.decode(headerBytes));
    claimsJson = JSON.parse(textDecoder.decode(claimsBytes));
  } catch {
    return { valid: false, payload: null, reason: "invalid_schema" };
  }

  if (
    typeof headerJson !== "object" ||
    headerJson === null ||
    (headerJson as Record<string, unknown>)["alg"] !== "HS256"
  ) {
    return { valid: false, payload: null, reason: "invalid_signature" };
  }

  const key = await importHmacKey(config.secret, "verify");
  const verified = await globalThis.crypto.subtle.verify(
    "HMAC",
    key,
    toArrayBuffer(sigBytes),
    toArrayBuffer(textEncoder.encode(`${headerB64}.${claimsB64}`)),
  );
  if (!verified) {
    return { valid: false, payload: null, reason: "invalid_signature" };
  }

  if (typeof claimsJson !== "object" || claimsJson === null) {
    return { valid: false, payload: null, reason: "invalid_schema" };
  }

  const record = claimsJson as Record<string, unknown>;
  if (record["iss"] !== config.issuer || record["aud"] !== config.audience) {
    return { valid: false, payload: null, reason: "invalid_claims" };
  }

  return validateSessionPayload(record, nowEpochSeconds);
}

/**
 * Extracts the session JWT from a `Cookie` header.
 */
export function parseSessionCookie(
  cookieHeader: string | null | undefined,
  cookieName: string = SESSION_COOKIE_NAME,
): string | null {
  if (!cookieHeader) {
    return null;
  }
  const pairs = cookieHeader.split(";");
  for (const rawPair of pairs) {
    const eqIndex = rawPair.indexOf("=");
    if (eqIndex < 0) continue;
    const key = rawPair.slice(0, eqIndex).trim();
    if (key === cookieName) {
      const value = rawPair.slice(eqIndex + 1).trim();
      return value ? decodeURIComponent(value) : null;
    }
  }
  return null;
}

/**
 * Extracts a JWT from an `Authorization: Bearer <token>` header.
 */
export function extractBearerToken(authorizationHeader: string | null | undefined): string | null {
  if (!authorizationHeader) {
    return null;
  }
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorizationHeader.trim());
  return match?.[1] ?? null;
}

/**
 * Extracts a Kibitz session token from either `Authorization: Bearer` or the `kibitz_session` cookie.
 */
export function extractSessionToken(headers: {
  authorization?: string | null;
  cookie?: string | null;
}): string | null {
  return extractBearerToken(headers.authorization) ?? parseSessionCookie(headers.cookie);
}

function normalizeCookieDomain(domain: string): string | null {
  const trimmed = domain.trim().replace(/^\.+/, "").toLowerCase();
  if (!trimmed || DEV_LOCAL_HOSTS.has(trimmed) || /^\d+\.\d+\.\d+\.\d+$/.test(trimmed)) {
    return null;
  }
  return `.${trimmed}`;
}

/**
 * Builds the `Set-Cookie` header value for a cross-service `kibitz_session` cookie.
 * Omits `Domain` on localhost so browsers share the host-only cookie across all local ports.
 */
export function buildSessionCookieHeader(
  token: string,
  config: Pick<SessionJwtConfig, "cookieDomain" | "secureCookie" | "ttlSeconds">,
): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(config.ttlSeconds))}`,
  ];
  const domainAttr = normalizeCookieDomain(config.cookieDomain);
  if (domainAttr) {
    attributes.push(`Domain=${domainAttr}`);
  }
  if (config.secureCookie) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

/**
 * Builds the `Set-Cookie` header that clears the cross-service `kibitz_session` cookie.
 */
export function buildClearSessionCookieHeader(
  config: Pick<SessionJwtConfig, "cookieDomain" | "secureCookie">,
): string {
  const attributes = [`${SESSION_COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  const domainAttr = normalizeCookieDomain(config.cookieDomain);
  if (domainAttr) {
    attributes.push(`Domain=${domainAttr}`);
  }
  if (config.secureCookie) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

const PLACEHOLDER_SECRET_MARKERS = [
  "dev-only",
  "replace-me",
  "change-me",
  "changeme",
  "placeholder",
  "your-secret",
  "example-secret",
] as const;

/**
 * Returns true if a JWT signing secret matches the bundled development default or
 * contains obvious example/placeholder markers that must not be used in production.
 */
export function isPlaceholderJwtSecret(secret: string): boolean {
  const normalized = secret.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized === DEFAULT_DEV_JWT_SECRET.toLowerCase()) {
    return true;
  }
  return PLACEHOLDER_SECRET_MARKERS.some((marker) => normalized.includes(marker));
}

/**
 * Resolves cross-subdomain JWT & cookie settings from environment variables.
 * Fails fast in production if `AUTH_JWT_SECRET` is missing, weak (< 32 UTF-8 bytes),
 * or matches a placeholder/example secret.
 */
export function resolveAuthConfig(env: Record<string, string | undefined> = {}): SessionJwtConfig {
  const isProd = env["NODE_ENV"] === "production";
  const secret = env["AUTH_JWT_SECRET"]?.trim() || (isProd ? "" : DEFAULT_DEV_JWT_SECRET);

  if (isProd) {
    if (textEncoder.encode(secret).byteLength < 32) {
      throw new Error("AUTH_JWT_SECRET must be set and at least 32 UTF-8 bytes long in production.");
    }
    if (isPlaceholderJwtSecret(secret)) {
      throw new Error(
        "AUTH_JWT_SECRET must not use the default or a placeholder/example secret in production. Generate a unique secret (e.g., `openssl rand -base64 48`).",
      );
    }
  }

  const parsedTtl = Number(env["AUTH_SESSION_TTL_SECONDS"] ?? DEFAULT_SESSION_TTL_SECONDS);
  const ttlSeconds =
    Number.isFinite(parsedTtl) && parsedTtl > 0
      ? Math.floor(parsedTtl)
      : DEFAULT_SESSION_TTL_SECONDS;

  const allowedOrigins = (env["AUTH_ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  return {
    secret,
    issuer: env["AUTH_JWT_ISSUER"]?.trim() || "id.kibitz.local",
    audience: env["AUTH_JWT_AUDIENCE"]?.trim() || "kibitz-suite",
    ttlSeconds,
    cookieDomain: env["AUTH_COOKIE_DOMAIN"]?.trim() || "localhost",
    secureCookie: isProd || env["AUTH_COOKIE_SECURE"] === "true",
    allowedOrigins,
  };
}

/**
 * Returns true if the given HTTP `Origin` belongs to the Kibitz suite (dev ports, configured
 * root/subdomain hosts, or explicit `AUTH_ALLOWED_ORIGINS`).
 */
export function isAllowedSuiteOrigin(
  origin: string | null | undefined,
  config: Pick<SessionJwtConfig, "cookieDomain" | "allowedOrigins">,
): boolean {
  if (!origin) {
    return false;
  }

  const normalized = origin.trim().replace(/\/+$/, "");
  if (config.allowedOrigins.includes(normalized)) {
    return true;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return false;
  }

  if (parsed.origin !== normalized) {
    return false;
  }

  const host = parsed.hostname.toLowerCase();

  if (DEV_LOCAL_HOSTS.has(host)) {
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      DEV_ALLOWED_PORTS.has(parsed.port)
    );
  }

  const rootDomain = config.cookieDomain.trim().replace(/^\.+/, "").toLowerCase();
  if (!rootDomain || DEV_LOCAL_HOSTS.has(rootDomain)) {
    return false;
  }

  if (parsed.protocol !== "https:") {
    return false;
  }

  if (host === rootDomain) {
    return true;
  }

  if (host.endsWith(`.${rootDomain}`)) {
    const sub = host.slice(0, -(rootDomain.length + 1));
    return KNOWN_SUITE_SUBDOMAINS.has(sub);
  }

  return false;
}
