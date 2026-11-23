#!/usr/bin/env node
/**
 * Automated Architectural Boundary & Zero-PII Firewall Verification Script.
 *
 * 1. Audits package.json dependency graphs across apps/* and packages/*.
 * 2. Runs ESLint programmatically against synthetic boundary violations to prove
 *    every guardrail in eslint.config.mjs actively fails lint.
 * 3. With `--check-dist`, audits built bundles (`dist/assets/*.js`, `dist/sw.js`,
 *    `dist/manifest.webmanifest`) for offline Zero-PII apps (`arbiter`, `seconds`).
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const REQUIRE_DIST = process.argv.includes("--check-dist");

const errors = [];

async function readPackageJson(relPath) {
  const fullPath = path.join(REPO_ROOT, relPath, "package.json");
  const raw = await readFile(fullPath, "utf8");
  return JSON.parse(raw);
}

function getAllDependencyNames(pkg) {
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ];
}

async function auditPackageManifests() {
  const rules = [
    {
      workspace: "apps/kibitz",
      forbidden: ["@suite/auth-core", "@suite/db"],
      reason: "Static homepage SPA must remain auth/DB-free",
    },
    {
      workspace: "apps/arbiter",
      forbidden: ["@suite/auth-core", "@suite/db"],
      reason: "Zero-PII Offline Firewall",
    },
    {
      workspace: "apps/seconds",
      forbidden: ["@suite/auth-core", "@suite/db"],
      reason: "Zero-PII Offline Firewall",
    },
    {
      workspace: "apps/scribe",
      forbidden: ["@suite/db"],
      reason: "Client-first SPA must not depend on @suite/db",
    },
    {
      workspace: "packages/chess-core",
      forbidden: [
        "react",
        "react-dom",
        "@suite/db",
        "@suite/auth-core",
        "@suite/ui",
        "@suite/board-ui",
      ],
      reason: "Pure isomorphic package (zero DOM/React/Auth/DB)",
    },
    {
      workspace: "packages/pgna",
      forbidden: [
        "react",
        "react-dom",
        "@suite/db",
        "@suite/auth-core",
        "@suite/ui",
        "@suite/board-ui",
      ],
      reason: "Pure isomorphic package (zero DOM/React/Auth/DB)",
    },
  ];

  for (const rule of rules) {
    const pkg = await readPackageJson(rule.workspace);
    const deps = getAllDependencyNames(pkg);
    for (const forbiddenDep of rule.forbidden) {
      if (deps.includes(forbiddenDep)) {
        errors.push(
          `[MANIFEST] ${rule.workspace}/package.json lists forbidden dependency "${forbiddenDep}" (${rule.reason}).`,
        );
      }
    }
  }
}

async function verifyEslintGuardrails() {
  const eslint = new ESLint({ cwd: REPO_ROOT });

  const expectedFailures = [
    {
      name: "apps/kibitz homepage importing @suite/db",
      filePath: path.join(REPO_ROOT, "apps/kibitz/src/__boundary_probe__.ts"),
      code: 'import { studies } from "@suite/db";\nexport const s = studies;\n',
      expectedRule: "no-restricted-imports",
    },
    {
      name: "apps/arbiter importing @suite/auth-core",
      filePath: path.join(REPO_ROOT, "apps/arbiter/src/__boundary_probe__.ts"),
      code: 'import type { SessionPayload } from "@suite/auth-core";\nexport type T = SessionPayload;\n',
      expectedRule: "no-restricted-imports",
    },
    {
      name: "apps/arbiter importing @suite/db",
      filePath: path.join(REPO_ROOT, "apps/arbiter/src/__boundary_probe__.ts"),
      code: 'import { users } from "@suite/db";\nexport const u = users;\n',
      expectedRule: "no-restricted-imports",
    },
    {
      name: "apps/seconds importing @suite/auth-core",
      filePath: path.join(REPO_ROOT, "apps/seconds/src/__boundary_probe__.ts"),
      code: 'import { computeEffectiveStudentAccess } from "@suite/auth-core";\nexport const f = computeEffectiveStudentAccess;\n',
      expectedRule: "no-restricted-imports",
    },
    {
      name: "apps/seconds importing @suite/db",
      filePath: path.join(REPO_ROOT, "apps/seconds/src/__boundary_probe__.ts"),
      code: 'import { createDbClient } from "@suite/db";\nexport const f = createDbClient;\n',
      expectedRule: "no-restricted-imports",
    },
    {
      name: "apps/scribe local code importing @suite/auth-core outside src/publish",
      filePath: path.join(REPO_ROOT, "apps/scribe/src/local/__boundary_probe__.ts"),
      code: 'import type { SessionPayload } from "@suite/auth-core";\nexport type T = SessionPayload;\n',
      expectedRule: "no-restricted-imports",
    },
    {
      name: "packages/chess-core importing react",
      filePath: path.join(REPO_ROOT, "packages/chess-core/src/__boundary_probe__.ts"),
      code: 'import React from "react";\nexport const r = React;\n',
      expectedRule: "no-restricted-imports",
    },
    {
      name: "packages/chess-core referencing DOM global window",
      filePath: path.join(REPO_ROOT, "packages/chess-core/src/__boundary_probe__.ts"),
      code: "export const w = window.location;\n",
      expectedRule: "no-restricted-globals",
    },
    {
      name: "packages/pgna importing @suite/auth-core",
      filePath: path.join(REPO_ROOT, "packages/pgna/src/__boundary_probe__.ts"),
      code: 'import type { UserRole } from "@suite/auth-core";\nexport type R = UserRole;\n',
      expectedRule: "no-restricted-imports",
    },
    {
      name: "packages/pgna referencing DOM global document",
      filePath: path.join(REPO_ROOT, "packages/pgna/src/__boundary_probe__.ts"),
      code: "export const d = document.title;\n",
      expectedRule: "no-restricted-globals",
    },
    {
      name: "apps/lecture importing sibling app apps/arbiter",
      filePath: path.join(REPO_ROOT, "apps/lecture/src/server/__boundary_probe__.ts"),
      code: 'import something from "../../../arbiter/src/App";\nexport const s = something;\n',
      expectedRule: "no-restricted-imports",
    },
    {
      name: "apps/lecture web client importing @suite/db",
      filePath: path.join(REPO_ROOT, "apps/lecture/src/web/__boundary_probe__.ts"),
      code: 'import { studies } from "@suite/db";\nexport const s = studies;\n',
      expectedRule: "no-restricted-imports",
    },
  ];

  for (const probe of expectedFailures) {
    const [result] = await eslint.lintText(probe.code, { filePath: probe.filePath });
    const matched = result?.messages.some(
      (msg) => msg.ruleId === probe.expectedRule && msg.severity === 2,
    );
    if (!matched) {
      errors.push(
        `[GUARDRAIL] Expected ESLint rule "${probe.expectedRule}" to reject: ${probe.name}`,
      );
    }
  }

  // Positive control: apps/scribe/src/publish/** IS permitted to import @suite/auth-core.
  const [scribePublishResult] = await eslint.lintText(
    'import type { SessionPayload } from "@suite/auth-core";\nexport type PublishSession = SessionPayload;\n',
    { filePath: path.join(REPO_ROOT, "apps/scribe/src/publish/__boundary_probe__.ts") },
  );
  if ((scribePublishResult?.errorCount ?? 0) > 0) {
    errors.push(
      `[GUARDRAIL] apps/scribe/src/publish/** should be allowed to import @suite/auth-core, but got errors: ${JSON.stringify(scribePublishResult?.messages)}`,
    );
  }
}

async function auditDeterministicDevPorts() {
  const expectedPorts = {
    kibitz: 5170,
    id: 5171,
    lecture: 5172,
    hall: 5173,
    scribe: 5174,
    arbiter: 5175,
    seconds: 5176,
  };

  for (const [appName, port] of Object.entries(expectedPorts)) {
    const vitePath = path.join(REPO_ROOT, "apps", appName, "vite.config.ts");
    const viteSrc = await readFile(vitePath, "utf8");
    const serverBlock = /server:\s*\{[^}]*\}/s.exec(viteSrc)?.[0] ?? "";
    if (!new RegExp(`port:\\s*${port}\\b`).test(serverBlock)) {
      errors.push(`[PORTS] apps/${appName}/vite.config.ts must configure server.port = ${port}.`);
    }
    if (!/strictPort:\s*true\b/.test(serverBlock)) {
      errors.push(
        `[PORTS] apps/${appName}/vite.config.ts must set server.strictPort = true so Vite never silently hops onto another app's port.`,
      );
    }

    const pkg = await readPackageJson(path.join("apps", appName));
    const webDevScript = pkg.scripts?.["dev:web"] ?? pkg.scripts?.["dev"] ?? "";
    if (!webDevScript.includes(`--port ${port}`) || !webDevScript.includes("--strictPort")) {
      errors.push(
        `[PORTS] apps/${appName}/package.json Vite dev script must include "--port ${port} --strictPort" (got: "${webDevScript}").`,
      );
    }
  }
}

async function auditOfflineBuiltBundles() {
  const offlineApps = ["arbiter", "seconds"];

  const forbiddenBundlePatterns = [
    {
      label: "navigator.sendBeacon exfiltration",
      pattern: /\bnavigator\s*\.\s*sendBeacon\b|\bsendBeacon\s*\(/,
    },
    {
      label: "WebSocket transport",
      pattern: /\bnew\s+WebSocket\b/,
    },
    {
      label: "EventSource transport",
      pattern: /\bnew\s+EventSource\b/,
    },
    {
      label: "XMLHttpRequest transport",
      pattern: /\bXMLHttpRequest\b/,
    },
    {
      label: "non-GET HTTP mutation method literal",
      pattern: /\bmethod\s*:\s*["'`]\s*(?:POST|PUT|PATCH|DELETE)\s*["'`]/i,
    },
    {
      label: "mutating fetch() call or fetch() request body",
      pattern:
        /\bfetch\s*\([^;{}]{0,300}\b(?:method\s*:\s*["'`]\s*(?!GET\b|HEAD\b)[A-Z]+\s*["'`]|body\s*:)/i,
    },
  ];

  const externalEndpointPattern = /https?:\/\//i;

  for (const appName of offlineApps) {
    const distDir = path.join(REPO_ROOT, "apps", appName, "dist");
    if (!existsSync(distDir)) {
      errors.push(
        `[DIST] apps/${appName}/dist does not exist. Run "pnpm build" before executing --check-dist.`,
      );
      continue;
    }

    // 1. Service Worker (dist/sw.js)
    const swPath = path.join(distDir, "sw.js");
    if (!existsSync(swPath)) {
      errors.push(`[DIST] apps/${appName}/dist/sw.js is missing (PWA service worker required).`);
    } else {
      const swContent = await readFile(swPath, "utf8");
      if (swContent.trim().length === 0) {
        errors.push(`[DIST] apps/${appName}/dist/sw.js is empty.`);
      }
      for (const rule of forbiddenBundlePatterns) {
        if (rule.pattern.test(swContent)) {
          errors.push(`[DIST] apps/${appName}/dist/sw.js matched forbidden pattern: ${rule.label}.`);
        }
      }
      if (externalEndpointPattern.test(swContent)) {
        errors.push(
          `[DIST] apps/${appName}/dist/sw.js contains an external http(s) URL (must precache local assets only).`,
        );
      }
    }

    // 2. Web App Manifest (dist/manifest.webmanifest)
    const manifestPath = path.join(distDir, "manifest.webmanifest");
    if (!existsSync(manifestPath)) {
      errors.push(
        `[DIST] apps/${appName}/dist/manifest.webmanifest is missing (PWA manifest required).`,
      );
    } else {
      const manifestRaw = await readFile(manifestPath, "utf8");
      try {
        const manifest = JSON.parse(manifestRaw);
        if (!manifest || typeof manifest !== "object" || typeof manifest.name !== "string") {
          errors.push(
            `[DIST] apps/${appName}/dist/manifest.webmanifest must be a valid JSON manifest with a "name".`,
          );
        }
      } catch (err) {
        errors.push(
          `[DIST] apps/${appName}/dist/manifest.webmanifest is invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (externalEndpointPattern.test(manifestRaw)) {
        errors.push(
          `[DIST] apps/${appName}/dist/manifest.webmanifest contains an external http(s) endpoint.`,
        );
      }
    }

    // 3. Built JS assets (dist/assets/*.js)
    const assetsDir = path.join(distDir, "assets");
    if (!existsSync(assetsDir)) {
      errors.push(`[DIST] apps/${appName}/dist/assets directory is missing.`);
      continue;
    }

    const assetEntries = await readdir(assetsDir);
    const jsAssets = assetEntries.filter((name) => name.endsWith(".js"));
    if (jsAssets.length === 0) {
      errors.push(`[DIST] apps/${appName}/dist/assets contains no built .js bundles.`);
      continue;
    }

    for (const jsFile of jsAssets) {
      const fullPath = path.join(assetsDir, jsFile);
      const bundleContent = await readFile(fullPath, "utf8");
      for (const rule of forbiddenBundlePatterns) {
        if (rule.pattern.test(bundleContent)) {
          errors.push(
            `[DIST] apps/${appName}/dist/assets/${jsFile} matched forbidden Zero-PII pattern: ${rule.label}.`,
          );
        }
      }
    }
  }
}

await auditPackageManifests();
await auditDeterministicDevPorts();
await verifyEslintGuardrails();
if (REQUIRE_DIST) {
  await auditOfflineBuiltBundles();
}

if (errors.length > 0) {
  console.error("Boundary verification FAILED:");
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

console.log(
  REQUIRE_DIST
    ? "Boundary verification PASSED: Zero-PII firewall, pure package, deterministic port, cross-app guardrails, and offline dist bundles are verified."
    : "Boundary verification PASSED: Zero-PII firewall, pure package, deterministic port, and cross-app guardrails are active.",
);
