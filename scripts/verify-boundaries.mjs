#!/usr/bin/env node
/**
 * Automated Architectural Boundary & Zero-PII Firewall Verification Script.
 *
 * 1. Audits package.json dependency graphs across apps/* and packages/*.
 * 2. Runs ESLint programmatically against synthetic boundary violations to prove
 *    every guardrail in eslint.config.mjs actively fails lint.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

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
      name: "apps/kibitz importing sibling app apps/arbiter",
      filePath: path.join(REPO_ROOT, "apps/kibitz/src/server/__boundary_probe__.ts"),
      code: 'import something from "../../../arbiter/src/App";\nexport const s = something;\n',
      expectedRule: "no-restricted-imports",
    },
    {
      name: "apps/kibitz web client importing @suite/db",
      filePath: path.join(REPO_ROOT, "apps/kibitz/src/web/__boundary_probe__.ts"),
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

await auditPackageManifests();
await verifyEslintGuardrails();

if (errors.length > 0) {
  console.error("Boundary verification FAILED:");
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

console.log(
  "Boundary verification PASSED: Zero-PII firewall, pure package, and cross-app guardrails are active.",
);
