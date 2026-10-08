import type { Boundary } from "./package-boundary-types.ts";
import { mergeFileImports } from "./package-boundary-imports.ts";

// Existing host adapter registrations and evidence: docs/package-boundary-adapter-registry.md.
const packageBoundaries: readonly Boundary[] = [
  {
    packageName: "capability-packs",
    allowedBareImports: [],
    allowedRuntimeDependencies: [],
  },
  {
    packageName: "artifacts",
    allowedBareImports: ["node:", "@crewon/application", "@crewon/domain"],
    allowedRuntimeDependencies: ["@crewon/application", "@crewon/domain"],
  },
  {
    packageName: "agent-kernel",
    allowedBareImports: [
      "@crewon/contracts",
      "@crewon/domain",
      "@crewon/tool-broker",
    ],
    // Durable accounting and continuation limits are core domain values.
    allowedRuntimeDependencies: [
      "@crewon/contracts",
      "@crewon/domain",
      "@crewon/tool-broker",
    ],
    allowedFileImports: {
      "model-call-observer.ts": ["node:crypto"],
      "model-usage-observer.ts": ["node:crypto"],
    },
  },
  {
    packageName: "agent-responses",
    allowedBareImports: [
      "node:http",
      "@crewon/agent-kernel",
      "@crewon/contracts",
      "ws",
    ],
    allowedRuntimeDependencies: [
      "@crewon/agent-kernel",
      "@crewon/contracts",
      "ws",
    ],
  },
  {
    packageName: "agent-version",
    allowedBareImports: ["@crewon/application", "@crewon/tool-broker"],
    // Build retention and recovery are explicit Node subpaths, not compiler dependencies.
    allowedFileImports: {
      "extension-build.ts": ["node:crypto", "node:fs", "node:path", "node:url"],
      "extension-build-archive.ts": [
        "node:crypto",
        "node:fs",
        "node:fs/promises",
        "node:path",
      ],
      "extension-recovery.ts": [
        "node:crypto",
        "node:fs",
        "node:fs/promises",
        "node:path",
        "@crewon/contracts",
        "@crewon/domain",
      ],
      "extension-recovery-inputs.ts": [
        "node:crypto",
        "node:fs",
        "node:path",
        "@crewon/contracts",
        "@crewon/domain",
      ],
      "extension-recovery-startup.ts": [
        "node:fs",
        "node:fs/promises",
        "node:path",
      ],
    },
    allowedRuntimeDependencies: [
      "@crewon/application",
      "@crewon/contracts",
      "@crewon/domain",
      "@crewon/tool-broker",
    ],
  },
  {
    packageName: "app-server-protocol",
    allowedBareImports: [],
    allowedRuntimeDependencies: [],
  },
  {
    packageName: "contracts",
    allowedBareImports: [],
    allowedRuntimeDependencies: [],
  },
  {
    packageName: "control-client",
    allowedBareImports: ["@crewon/contracts"],
    allowedRuntimeDependencies: ["@crewon/contracts"],
  },
  {
    packageName: "context",
    allowedBareImports: ["@crewon/domain"],
    allowedRuntimeDependencies: ["@crewon/domain"],
  },
  {
    packageName: "domain",
    allowedBareImports: [],
    allowedRuntimeDependencies: [],
  },
  {
    packageName: "eval-harness",
    allowedBareImports: ["node:fs"],
    allowedRuntimeDependencies: [],
  },
  {
    packageName: "device-dispatch",
    allowedBareImports: [
      "node:crypto",
      "node:https",
      "@crewon/contracts",
      "@crewon/tool-broker",
    ],
    allowedRuntimeDependencies: ["@crewon/contracts", "@crewon/tool-broker"],
  },
  {
    packageName: "mcp-runtime",
    // Stable remote mutation identity is computed at the transport adapter.
    allowedFileImports: {
      "crewon-remote-mutation-provider.ts": ["node:crypto"],
    },
    allowedBareImports: [
      "node:path",
      "@crewon/tool-broker",
      "@modelcontextprotocol/sdk",
    ],
    allowedRuntimeDependencies: [
      "@crewon/tool-broker",
      "@modelcontextprotocol/sdk",
    ],
  },
  {
    packageName: "application",
    allowedBareImports: ["@crewon/contracts", "@crewon/domain"],
    allowedRuntimeDependencies: ["@crewon/contracts", "@crewon/domain"],
  },
  {
    // The coordinator takes an explicit host port and has no Node or outward imports.
    packageName: "process-lifecycle",
    allowedBareImports: [],
    allowedRuntimeDependencies: [],
  },
  {
    // Published bundles contain their contract source; consumers need no private workspace packages.
    packageName: "plugin-sdk",
    allowedBareImports: [],
    allowedExactBareImports: ["@crewon/contracts/plugins"],
    allowedRuntimeDependencies: [],
  },
  {
    // Installation and loading stay in a private Node adapter, never in the public SDK or renderer.
    packageName: "plugin-host",
    allowedBareImports: ["node:"],
    allowedExactBareImports: [
      "@crewon/contracts/plugins",
      "@crewon/plugin-sdk/node",
      "@crewon/plugin-sdk/contracts",
    ],
    allowedFileImports: {
      "plugin-installation-local-host.ts": [
        "@crewon/application",
        "@crewon/domain",
      ],
      "plugin-installation-recovery.ts": [
        "@crewon/application",
        "@crewon/domain",
      ],
      "plugin-installation-recovery-support.ts": [
        "@crewon/application",
        "@crewon/domain",
      ],
      "plugin-ui-package-reader.ts": ["@crewon/application", "@crewon/domain"],
      "plugin-ui-package-reader-support.ts": [
        "@crewon/application",
        "@crewon/domain",
      ],
    },
    allowedRuntimeDependencies: [
      "@crewon/application",
      "@crewon/contracts",
      "@crewon/domain",
      "@crewon/plugin-sdk",
    ],
  },
  {
    packageName: "store",
    allowedBareImports: [
      "node:crypto",
      "node:sqlite",
      "@crewon/application",
      "@crewon/contracts",
      "@crewon/domain",
      "pg",
    ],
    allowedRuntimeDependencies: [
      "@crewon/application",
      "@crewon/contracts",
      "@crewon/domain",
      "pg",
    ],
    // Storage owns protocol validation, bounded disk probes and physical codecs.
    allowedFileImports: {
      "assistant-sample-continuation.ts": ["node:util"],
      "filesystem-storage-admission.ts": ["node:fs/promises", "node:path"],
      "extension-recovery-reader.ts": ["node:fs", "node:path"],
      "in-memory-thread-message-window.ts": ["node:buffer"],
      "model-accounting-reader.ts": ["node:timers/promises"],
      "sqlite-canonical-tool-output-codec.ts": ["node:zlib"],
      "sqlite-execution-receipt-codec.ts": ["node:zlib"],
      "sqlite-tool-result-codec.ts": ["node:zlib"],
    },
  },
  {
    packageName: "tool-broker",
    allowedBareImports: ["node:crypto", "@crewon/contracts"],
    allowedRuntimeDependencies: ["@crewon/contracts"],
  },
  {
    packageName: "test-contracts",
    allowedBareImports: ["node:", "@crewon/contracts"],
    allowedRuntimeDependencies: [],
  },
  {
    packageName: "media-runtime",
    allowedBareImports: [
      "@crewon/application",
      "@crewon/artifacts",
      "@crewon/domain",
      "@crewon/store",
    ],
    allowedFileImports: {
      "comfyui-material-upload.ts": ["node:crypto", "node:util"],
      "comfyui-project-reference-material-adapter.ts": ["node:util"],
      "desktop-native-network-dns.ts": ["node:dns/promises", "node:net"],
      "desktop-project-material-archive.ts": ["node:crypto", "node:path"],
      "desktop-project-result-archive.ts": ["node:crypto", "node:path"],
      "material-byte-snapshot.ts": ["node:util"],
      "pinned-node-http.ts": ["node:http", "node:https", "node:net"],
      "project-adopted-media-reference-reader.ts": ["node:crypto", "node:util"],
      "project-material-png.ts": ["node:zlib"],
      "project-material-preparation-support.ts": ["node:util"],
      "project-material-preparer.ts": ["node:crypto", "node:util"],
      "project-media-generation-commands.ts": ["node:crypto", "node:util"],
      "project-media-generation-task-preparer.ts": ["node:util"],
      "project-media-material-preparer.ts": ["node:util"],
      "project-media-material-runtime.ts": ["node:crypto", "node:util"],
      "project-media-result-publisher.ts": ["node:crypto", "node:util"],
      "project-reference-material-freezer-source.ts": [
        "node:crypto",
        "node:util",
      ],
      "project-reference-material-freezer.ts": ["node:crypto", "node:util"],
      "project-reference-material-reader.ts": ["node:crypto"],
      "project-source-import-validation.ts": ["node:util"],
      "provider-probe-egress.ts": ["node:dns/promises", "node:net"],
      "project-source-import.ts": ["node:crypto"],
      "project-source-html-parser.ts": ["parse5"],
      "project-source-upload-preparation-adapter.ts": [
        "node:crypto",
        "node:util",
      ],
    },
    allowedRuntimeDependencies: [
      "@crewon/application",
      "@crewon/artifacts",
      "@crewon/domain",
      "@crewon/store",
      "parse5",
    ],
  },
];

const approvedAdapterImports: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  "application": {
    "creative-project-run-commit-authority.ts": ["node:crypto"],
    "plugin-project-asset-v2-action-owner.ts": ["node:util"],
    "plugin-ui-invocation-authority.ts": ["node:crypto"],
    "project-asset-media-adoption-service.ts": ["node:util"],
    "project-asset-media-adoption.ts": ["node:util"],
    "project-asset-run-commit-authority.ts": ["node:crypto"],
    "project-asset-v2-application-service.ts": ["node:util"],
    "project-material-preparation-record.ts": ["node:crypto", "node:util"],
    "project-media-input-application-authority.ts": ["node:util"],
    "project-media-input-application-service.ts": ["node:util"],
    "project-media-input-record.ts": ["node:util"],
    "project-media-input-run-commit-authority.ts": ["node:crypto"],
    "project-media-reference-image-service.ts": ["node:util"],
    "project-media-result-record.ts": ["node:util"],
    "project-reference-material-freeze-record.ts": ["node:util"],
    "project-text-plan-authority.ts": ["node:crypto"],
  },
  "plugin-host": {
    "installed-plugin-business-registration.ts": [
      "@crewon/application",
      "@crewon/domain",
    ],
    "plugin-installation-package-support.ts": [
      "@crewon/application",
      "@crewon/domain",
    ],
    "plugin-project-foundation-host-service-availability.ts": [
      "@crewon/contracts/project-foundation",
      "@crewon/contracts/project-source-uploads",
    ],
    "plugin-project-generation-action-bridge-support.ts": [
      "@crewon/application",
      "@crewon/domain",
    ],
    "plugin-project-generation-action-bridge.ts": [
      "@crewon/application",
      "@crewon/domain",
    ],
    "plugin-project-generation-context-action-bridge-support.ts": [
      "@crewon/application",
      "@crewon/domain",
    ],
    "plugin-project-generation-context-action-bridge.ts": [
      "@crewon/application",
      "@crewon/domain",
    ],
    "plugin-project-generation-execution-bridge.ts": [
      "@crewon/application",
      "@crewon/domain",
    ],
    "plugin-project-generation-query-action-bridge-support.ts": [
      "@crewon/application",
      "@crewon/domain",
    ],
    "plugin-project-generation-query-action-bridge.ts": [
      "@crewon/application",
      "@crewon/domain",
    ],
    "plugin-project-generation-query-execution-bridge.ts": [
      "@crewon/application",
      "@crewon/domain",
    ],
    "plugin-project-generation-read-action-bridge-support.ts": [
      "@crewon/application",
      "@crewon/domain",
    ],
    "plugin-project-generation-read-action-bridge.ts": [
      "@crewon/application",
      "@crewon/contracts",
      "@crewon/domain",
    ],
    "plugin-project-historical-query-action-bridge-support.ts": [
      "@crewon/application",
      "@crewon/domain",
    ],
    "plugin-project-historical-query-action-bridge.ts": [
      "@crewon/application",
      "@crewon/domain",
    ],
    "plugin-project-historical-query-execution-bridge.ts": [
      "@crewon/application",
      "@crewon/domain",
    ],
    "plugin-project-media-generation-host-service-availability.ts": [
      "@crewon/contracts/project-media-generations",
    ],
    "plugin-project-media-input-host-service-availability.ts": [
      "@crewon/contracts/project-media-inputs-ui",
    ],
    "plugin-project-media-result-host-service-availability.ts": [
      "@crewon/contracts/project-media-results-ui",
    ],
    "plugin-project-text-plan-ui-service-availability.ts": [
      "@crewon/contracts/project-text-plans",
    ],
    "plugin-task-action-bridge-support.ts": [
      "@crewon/application",
      "@crewon/domain",
    ],
    "plugin-task-action-bridge.ts": ["@crewon/application", "@crewon/domain"],
    "plugin-ui-deferred-host-service-availability.ts": ["@crewon/application"],
    "plugin-ui-host-service-availability.ts": [
      "@crewon/application",
      "@crewon/contracts/project-texts-ui",
      "@crewon/domain",
    ],
  },
  "store": {
    "project-source-upload-store-support.ts": ["node:util"],
    "project-media-generation-turn.ts": ["node:util"],
    "project-text-store-support.ts": ["node:util"],
    "sqlite-plugin-installation-profile-lock.ts": ["node:fs", "node:path"],
  },
};

export const boundaries: readonly Boundary[] = packageBoundaries.map(
  (boundary) => ({
    ...boundary,
    allowedFileImports: mergeFileImports(
      boundary.allowedFileImports,
      approvedAdapterImports[boundary.packageName],
    ),
  }),
);
