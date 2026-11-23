import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

const ALL_APP_NAMES = ["kibitz", "id", "lecture", "scribe", "arbiter", "hall", "seconds"];

const DOM_GLOBALS = [
  { name: "window", message: "Pure isomorphic package must not access DOM global 'window'." },
  { name: "document", message: "Pure isomorphic package must not access DOM global 'document'." },
  { name: "navigator", message: "Pure isomorphic package must not access DOM global 'navigator'." },
  {
    name: "localStorage",
    message: "Pure isomorphic package must not access browser global 'localStorage'.",
  },
  {
    name: "sessionStorage",
    message: "Pure isomorphic package must not access browser global 'sessionStorage'.",
  },
  {
    name: "HTMLElement",
    message: "Pure isomorphic package must not reference DOM type/global 'HTMLElement'.",
  },
  { name: "Audio", message: "Pure isomorphic package must not access browser global 'Audio'." },
];

const ANALYTICS_PATTERNS = [
  "*analytics*",
  "*telemetry*",
  "*posthog*",
  "*sentry*",
  "@sentry/*",
  "*mixpanel*",
  "*amplitude*",
  "*segment*",
  "*plausible*",
];

function crossAppPatternsFor(appName) {
  const otherApps = ALL_APP_NAMES.filter((name) => name !== appName);
  return {
    group: otherApps.flatMap((other) => [
      `@suite/${other}`,
      `@suite/${other}/*`,
      `**/apps/${other}/**`,
      `../${other}`,
      `../${other}/**`,
      `../../${other}`,
      `../../${other}/**`,
      `../../../${other}`,
      `../../../${other}/**`,
      `../../apps/${other}`,
      `../../apps/${other}/**`,
    ]),
    message: `Cross-app imports are forbidden (apps/${appName} cannot import from sibling apps). Move shared code into packages/*.`,
  };
}

const ZERO_PII_PATTERNS = [
  {
    group: ["@suite/auth-core", "@suite/auth-core/*"],
    message:
      "ZERO-PII FIREWALL VIOLATION: apps/arbiter and apps/seconds MUST NEVER import @suite/auth-core.",
  },
  {
    group: ["@suite/db", "@suite/db/*"],
    message:
      "ZERO-PII FIREWALL VIOLATION: apps/arbiter and apps/seconds MUST NEVER import @suite/db.",
  },
  {
    group: ANALYTICS_PATTERNS,
    message:
      "ZERO-PII FIREWALL VIOLATION: apps/arbiter and apps/seconds MUST NEVER bundle analytics or telemetry.",
  },
];

const NO_DB_IN_WEB_PATTERN = {
  group: ["@suite/db", "@suite/db/*"],
  message: "Frontend web bundles (src/web/**) must never import @suite/db directly.",
};

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-server/**",
      "**/dist-web/**",
      "**/dev-dist/**",
      "**/.turbo/**",
      "**/coverage/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    name: "kibitz/base-ts",
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
    },
  },

  {
    name: "kibitz/node-scripts-and-servers",
    files: [
      "scripts/**/*.{js,mjs,ts}",
      "eslint.config.mjs",
      "apps/*/src/server/**/*.{ts,mts}",
      "packages/db/**/*.{ts,mts}",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  {
    name: "kibitz/react-frontend",
    files: [
      "apps/kibitz/src/**/*.{ts,tsx}",
      "apps/arbiter/src/**/*.{ts,tsx}",
      "apps/seconds/src/**/*.{ts,tsx}",
      "apps/scribe/src/**/*.{ts,tsx}",
      "apps/*/src/web/**/*.{ts,tsx}",
      "packages/board-ui/src/**/*.{ts,tsx}",
      "packages/ui/src/**/*.{ts,tsx}",
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },

  // ---------------------------------------------------------------------------
  // HARD ARCHITECTURAL BOUNDARY 0: Static Suite Homepage (apps/kibitz)
  // Must remain lightweight, auth-free, DB-free, telemetry-free, and isolated.
  // ---------------------------------------------------------------------------
  {
    name: "kibitz/boundary-homepage-kibitz",
    files: ["apps/kibitz/**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@suite/auth-core", "@suite/auth-core/*"],
              message:
                "apps/kibitz homepage must remain auth-free and never import @suite/auth-core.",
            },
            {
              group: ["@suite/db", "@suite/db/*"],
              message: "apps/kibitz homepage is a static SPA and must never import @suite/db.",
            },
            {
              group: ANALYTICS_PATTERNS,
              message: "apps/kibitz homepage must never bundle analytics or telemetry.",
            },
            crossAppPatternsFor("kibitz"),
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // HARD ARCHITECTURAL BOUNDARY 1: Zero-PII Offline Firewall (arbiter, seconds)
  // Composes Zero-PII + cross-app import bans cleanly in one rule block per app.
  // ---------------------------------------------------------------------------
  ...["arbiter", "seconds"].map((appName) => ({
    name: `kibitz/boundary-zero-pii-${appName}`,
    files: [`apps/${appName}/**/*.{ts,tsx,js,jsx,mjs,cjs}`],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [...ZERO_PII_PATTERNS, crossAppPatternsFor(appName)],
        },
      ],
    },
  })),

  // ---------------------------------------------------------------------------
  // HARD ARCHITECTURAL BOUNDARY 2: Client-First Scribe Isolation
  // Only apps/scribe/src/publish/** may import @suite/auth-core; never @suite/db.
  // ---------------------------------------------------------------------------
  {
    name: "kibitz/boundary-scribe-local-first",
    files: ["apps/scribe/**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    ignores: ["apps/scribe/src/publish/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@suite/auth-core", "@suite/auth-core/*"],
              message:
                "Scribe local authoring must remain backend/auth-free. Only apps/scribe/src/publish/** may import @suite/auth-core.",
            },
            {
              group: ["@suite/db", "@suite/db/*"],
              message: "apps/scribe is a client SPA and must never import @suite/db.",
            },
            crossAppPatternsFor("scribe"),
          ],
        },
      ],
    },
  },
  {
    name: "kibitz/boundary-scribe-publish",
    files: ["apps/scribe/src/publish/**/*.{ts,tsx,js,jsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@suite/db", "@suite/db/*"],
              message: "apps/scribe/src/publish must call HTTP APIs and never import @suite/db.",
            },
            crossAppPatternsFor("scribe"),
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // HARD ARCHITECTURAL BOUNDARY 3: Hybrid Services (id, lecture, hall)
  // Server code: no cross-app imports. Web code: no cross-app imports & no @suite/db.
  // ---------------------------------------------------------------------------
  ...["id", "lecture", "hall"].flatMap((appName) => [
    {
      name: `kibitz/boundary-hybrid-server-${appName}`,
      files: [`apps/${appName}/**/*.{ts,tsx,js,jsx,mjs,cjs}`],
      ignores: [`apps/${appName}/src/web/**`],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [crossAppPatternsFor(appName)],
          },
        ],
      },
    },
    {
      name: `kibitz/boundary-hybrid-web-${appName}`,
      files: [`apps/${appName}/src/web/**/*.{ts,tsx,js,jsx}`],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [NO_DB_IN_WEB_PATTERN, crossAppPatternsFor(appName)],
          },
        ],
      },
    },
  ]),

  // ---------------------------------------------------------------------------
  // HARD ARCHITECTURAL BOUNDARY 4: Pure Isomorphic Packages (chess-core, pgna)
  // Zero React, zero DOM globals, zero @suite/db, zero @suite/auth-core.
  // ---------------------------------------------------------------------------
  {
    name: "kibitz/boundary-pure-isomorphic-packages",
    files: [
      "packages/chess-core/**/*.{ts,tsx,js,jsx,mjs,cjs}",
      "packages/pgna/**/*.{ts,tsx,js,jsx,mjs,cjs}",
    ],
    rules: {
      "no-restricted-globals": ["error", ...DOM_GLOBALS],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["react", "react/*", "react-dom", "react-dom/*"],
              message:
                "PURE PACKAGE VIOLATION: @suite/chess-core and @suite/pgna must have zero React dependencies.",
            },
            {
              group: ["@suite/db", "@suite/db/*"],
              message:
                "PURE PACKAGE VIOLATION: @suite/chess-core and @suite/pgna must never import @suite/db.",
            },
            {
              group: ["@suite/auth-core", "@suite/auth-core/*"],
              message:
                "PURE PACKAGE VIOLATION: @suite/chess-core and @suite/pgna must never import @suite/auth-core.",
            },
            {
              group: ["@suite/ui", "@suite/ui/*", "@suite/board-ui", "@suite/board-ui/*"],
              message:
                "PURE PACKAGE VIOLATION: @suite/chess-core and @suite/pgna must never import UI packages.",
            },
          ],
        },
      ],
    },
  },
);
