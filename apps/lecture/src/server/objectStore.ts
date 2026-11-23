import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface PgnaObjectStore {
  readonly kind: "s3" | "disk" | "memory";
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

/**
 * Deterministic in-memory object store for unit tests and ephemeral dev runs.
 */
export class InMemoryPgnaObjectStore implements PgnaObjectStore {
  readonly kind = "memory" as const;
  private readonly objects = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array, _contentType: string): Promise<void> {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    this.objects.set(key, copy);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const existing = this.objects.get(key);
    if (!existing) return null;
    const copy = new Uint8Array(existing.byteLength);
    copy.set(existing);
    return copy;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

/**
 * Local-filesystem fallback object store for development when Docker S3/RustFS is not running.
 */
export class LocalDiskPgnaObjectStore implements PgnaObjectStore {
  readonly kind = "disk" as const;

  constructor(private readonly rootDir: string) {}

  private resolveSafePath(key: string): string {
    const normalized = key.replace(/^\/+/, "");
    if (!normalized || normalized.includes("..") || normalized.includes("\\")) {
      throw new Error(`Invalid object key: "${key}"`);
    }
    const full = path.resolve(this.rootDir, normalized);
    const root = path.resolve(this.rootDir);
    if (!full.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Object key escapes storage directory: "${key}"`);
    }
    return full;
  }

  async put(key: string, bytes: Uint8Array, _contentType: string): Promise<void> {
    const target = this.resolveSafePath(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const target = this.resolveSafePath(key);
    try {
      const buf = await readFile(target);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const target = this.resolveSafePath(key);
    await rm(target, { force: true });
  }
}

export interface S3StoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  fetchImpl?: typeof fetch;
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function encodeRfc3986Path(rawPath: string): string {
  return rawPath
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

/**
 * Zero-dependency S3-compatible object store using AWS Signature Version 4.
 * Compatible with RustFS (Docker dev), Cloudflare R2, MinIO, and AWS S3.
 */
export class S3PgnaObjectStore implements PgnaObjectStore {
  readonly kind = "s3" as const;
  private readonly endpointUrl: URL;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly config: S3StoreConfig) {
    this.endpointUrl = new URL(config.endpoint);
    this.fetchFn = config.fetchImpl ?? globalThis.fetch;
  }

  private buildObjectUrl(key: string): URL {
    const cleanKey = key.replace(/^\/+/, "");
    const url = new URL(this.endpointUrl.toString());
    const basePath = url.pathname.replace(/\/+$/, "");

    if (this.config.forcePathStyle) {
      url.pathname = `${basePath}/${encodeRfc3986Path(this.config.bucket)}/${encodeRfc3986Path(cleanKey)}`;
    } else {
      url.hostname = `${this.config.bucket}.${url.hostname}`;
      url.pathname = `${basePath}/${encodeRfc3986Path(cleanKey)}`;
    }
    url.search = "";
    return url;
  }

  private signRequest(
    method: "GET" | "PUT" | "DELETE",
    url: URL,
    payloadHash: string,
    extraHeaders: Record<string, string> = {},
  ): Record<string, string> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);

    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };

    for (const [k, v] of Object.entries(extraHeaders)) {
      headers[k.toLowerCase()] = v.trim();
    }

    const sortedKeys = Object.keys(headers).sort();
    const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}\n`).join("");
    const signedHeaders = sortedKeys.join(";");

    const canonicalRequest = [
      method,
      url.pathname,
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const credentialScope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join("\n");

    const kDate = hmacSha256(`AWS4${this.config.secretAccessKey}`, dateStamp);
    const kRegion = hmacSha256(kDate, this.config.region);
    const kService = hmacSha256(kRegion, "s3");
    const kSigning = hmacSha256(kService, "aws4_request");
    const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

    const authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const outHeaders: Record<string, string> = {
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      Authorization: authorization,
    };
    for (const [k, v] of Object.entries(extraHeaders)) {
      outHeaders[k] = v;
    }
    return outHeaders;
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const url = this.buildObjectUrl(key);
    const payloadHash = sha256Hex(bytes);
    const headers = this.signRequest("PUT", url, payloadHash, {
      "Content-Type": contentType,
    });
    const bodyCopy = new Uint8Array(bytes.byteLength);
    bodyCopy.set(bytes);
    const res = await this.fetchFn(url, {
      method: "PUT",
      headers,
      body: bodyCopy,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`S3 PUT "${key}" failed (HTTP ${res.status}): ${detail}`);
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const url = this.buildObjectUrl(key);
    const payloadHash = sha256Hex("");
    const headers = this.signRequest("GET", url, payloadHash);
    const res = await this.fetchFn(url, {
      method: "GET",
      headers,
    });
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`S3 GET "${key}" failed (HTTP ${res.status}): ${detail}`);
    }
    const arrayBuf = await res.arrayBuffer();
    return new Uint8Array(arrayBuf);
  }

  async delete(key: string): Promise<void> {
    const url = this.buildObjectUrl(key);
    const payloadHash = sha256Hex("");
    const headers = this.signRequest("DELETE", url, payloadHash);
    const res = await this.fetchFn(url, {
      method: "DELETE",
      headers,
    });
    if (res.status === 404) {
      return;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`S3 DELETE "${key}" failed (HTTP ${res.status}): ${detail}`);
    }
  }
}

/**
 * Resolves S3 object store config from environment variables when configured.
 */
export function resolveS3ConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): S3StoreConfig | null {
  const endpoint = env["S3_ENDPOINT"]?.trim();
  const bucket = env["S3_BUCKET"]?.trim();
  const accessKeyId = env["S3_ACCESS_KEY_ID"]?.trim();
  const secretAccessKey = env["S3_SECRET_ACCESS_KEY"]?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    return null;
  }
  return {
    endpoint,
    region: env["S3_REGION"]?.trim() || "us-east-1",
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: env["S3_FORCE_PATH_STYLE"] !== "false",
  };
}
