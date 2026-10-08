import type { AppBoundary } from "./package-boundary-types.ts";
import { mergeFileImports } from "./package-boundary-imports.ts";

// Existing opt-in host compositions and media extraction: docs/package-boundary-adapter-registry.md.
const controlApiBaseBoundary = {
  // Native activation types and sandbox path normalization stay in adapters.
  allowedFileImports: {
    "main.ts": ["node:net", "@crewon/process-lifecycle"],
    // Diagnostic projections redact private peer tokens rather than logging their config.
    "extension-host-router.ts": ["node:util"],
    "extension-worker-environment.ts": ["node:util"],
    "paused-admission.ts": ["node:stream"],
    "pim-sandbox-client.ts": ["node:path"],
  },
  allowedBareImports: [
    "node:crypto",
    "node:http",
    "@crewon/agent-version",
    "@crewon/application",
    "@crewon/artifacts",
    "@crewon/contracts",
    "@crewon/domain",
    "@crewon/store",
    "fastify",
    "uuid",
  ],
  allowedRuntimeDependencies: [
    "@crewon/agent-version",
    "@crewon/application",
    "@crewon/artifacts",
    "@crewon/contracts",
    "@crewon/domain",
    "@crewon/process-lifecycle",
    "@crewon/store",
    "fastify",
    "uuid",
  ],
} as const;

const runtimeWorkerBaseBoundary = {
  allowedFileImports: {
    "runtime-process-shutdown.ts": ["@crewon/process-lifecycle"],
  },
  allowedBareImports: [
    "node:",
    "@crewon/agent-kernel",
    "@crewon/agent-responses",
    "@crewon/agent-version",
    "@crewon/application",
    "@crewon/artifacts",
    "@crewon/contracts",
    "@crewon/context",
    "@crewon/domain",
    "@crewon/device-dispatch",
    "@crewon/mcp-runtime",
    "@crewon/store",
    "@crewon/tool-broker",
    "uuid",
  ],
  allowedRuntimeDependencies: [
    "@crewon/agent-kernel",
    "@crewon/agent-responses",
    "@crewon/agent-version",
    "@crewon/application",
    "@crewon/artifacts",
    "@crewon/contracts",
    "@crewon/context",
    "@crewon/domain",
    "@crewon/device-dispatch",
    "@crewon/mcp-runtime",
    "@crewon/process-lifecycle",
    "@crewon/store",
    "@crewon/tool-broker",
    "uuid",
  ],
} as const;

export const deviceGatewayBoundary = {
  allowedFileImports: {
    "main.ts": ["@crewon/process-lifecycle"],
  },
  allowedBareImports: ["node:", "@crewon/contracts", "pg", "ws"],
  allowedRuntimeDependencies: [
    "@crewon/contracts",
    "@crewon/process-lifecycle",
    "pg",
    "ws",
  ],
} as const;

const controlAdapterImports = {
  "creative-project-plugin-ui-composition.ts": ["@crewon/plugin-host"],
  "desktop-installed-plugin-activation-environment.ts": [
    "node:fs",
    "node:fs/promises",
    "node:path",
    "node:util",
  ],
  "desktop-installed-plugin-activation-owner.ts": ["@crewon/plugin-host"],
  "desktop-installed-plugin-task-environment.ts": [
    "node:fs",
    "node:fs/promises",
    "node:path",
    "node:util",
  ],
  "desktop-installed-plugin-task-runtime.ts": ["@crewon/plugin-host"],
  "desktop-native-plugin-authority-files.ts": [
    "node:fs",
    "node:path",
    "node:util",
  ],
  "desktop-native-plugin-control-environment.ts": [
    "node:fs",
    "node:path",
    "node:util",
  ],
  "desktop-native-plugin-task-runtime.ts": [
    "@crewon/media-runtime/desktop-project-material-archive",
    "@crewon/plugin-host",
  ],
  "desktop-native-project-media-generation-composition.ts": [
    "@crewon/media-runtime/comfyui-project-reference-material-adapter",
    "@crewon/media-runtime/desktop-adopted-media-reader",
    "@crewon/media-runtime/desktop-project-material-archive",
    "@crewon/media-runtime/project-media-material-runtime",
  ],
  "desktop-native-project-media-result-composition.ts": [
    "@crewon/media-runtime/desktop-project-material-archive",
    "@crewon/media-runtime/desktop-project-result-archive",
  ],
  "desktop-plugin-configuration.ts": [
    "node:fs",
    "node:fs/promises",
    "node:path",
  ],
  "desktop-plugin-installation-profile.ts": ["@crewon/plugin-host"],
  "desktop-plugin-installation-runtime.ts": ["@crewon/plugin-host"],
  "desktop-plugin-runtime-support.ts": ["@crewon/plugin-host", "node:path"],
  "desktop-plugin-runtime.ts": [
    "@crewon/media-runtime/desktop-project-material-archive",
    "@crewon/plugin-host",
  ],
  "desktop-plugin-source-registry.ts": [
    "@crewon/plugin-host",
    "node:fs/promises",
    "node:path",
  ],
  "desktop-plugin-ui-recovery.ts": ["@crewon/plugin-host"],
  "desktop-project-asset-plugin-runtime.ts": ["@crewon/plugin-host"],
  "desktop-project-asset-v2-plugin-runtime.ts": ["@crewon/plugin-host"],
  "desktop-project-conversation-runtime.ts": ["@crewon/plugin-host"],
  "desktop-project-history-plugin-runtime.ts": ["@crewon/plugin-host"],
  "desktop-project-foundation-plugin-runtime.ts": ["@crewon/plugin-host"],
  "desktop-project-media-generation-ui-composition.ts": ["@crewon/plugin-host"],
  "desktop-project-media-input-ui-composition.ts": ["@crewon/plugin-host"],
  "desktop-project-media-result-ui-composition.ts": ["@crewon/plugin-host"],
  "desktop-project-text-plugin-runtime.ts": ["@crewon/plugin-host"],
  "desktop-workspace-admission.ts": ["node:fs", "node:path"],
  "installed-plugin-configuration-environment.ts": [
    "node:fs",
    "node:fs/promises",
    "node:path",
    "node:util",
  ],
  "installed-plugin-configuration-metadata.ts": [
    "@crewon/plugin-host",
    "node:path",
  ],
  "installed-plugin-invocation-diagnostics.ts": ["node:async_hooks"],
  "installed-plugin-project-generation-owner.ts": ["@crewon/plugin-host"],
  "installed-plugin-project-generation-readiness.ts": ["@crewon/plugin-host"],
  "installed-plugin-project-generation-support.ts": [
    "@crewon/plugin-host",
    "node:fs/promises",
    "node:path",
  ],
  "installed-plugin-project-historical-query-owner.ts": ["@crewon/plugin-host"],
  "installed-plugin-project-query-owner.ts": ["@crewon/plugin-host"],
  "installed-plugin-request-owner.ts": ["node:async_hooks"],
  "installed-plugin-task-action-owner.ts": [
    "@crewon/plugin-host",
    "node:fs/promises",
    "node:path",
  ],
  "installed-plugin-task-composition.ts": ["@crewon/plugin-host"],
  "installed-plugin-task-environment.ts": [
    "node:fs",
    "node:fs/promises",
    "node:path",
    "node:util",
  ],
  "installed-plugin-task-runtime-core.ts": ["@crewon/plugin-host", "node:path"],
  "installed-project-media-generation-admissions.ts": [
    "@crewon/media-runtime",
    "@crewon/plugin-host",
    "node:path",
  ],
  "installed-project-media-generation-configuration.ts": [
    "@crewon/media-runtime",
  ],
  "installed-project-media-generation-runtime.ts": [
    "@crewon/media-runtime",
    "node:async_hooks",
    "node:util",
  ],
  "installed-project-media-input-configuration.ts": ["node:util"],
  "installed-project-media-input-runtime.ts": ["node:async_hooks", "node:util"],
  "installed-project-media-result-runtime.ts": [
    "@crewon/media-runtime/project-media-result-publisher",
    "node:async_hooks",
  ],
  "main.ts": ["@crewon/media-runtime/desktop-project-material-archive"],
  "plugin-ui-recovery-composition.ts": [
    "@crewon/plugin-host",
    "node:async_hooks",
  ],
  "production-composition.ts": ["@crewon/plugin-host"],
  "production-plugin-installation-environment.ts": ["node:path", "node:util"],
  "production-plugin-installation-profile.ts": ["@crewon/plugin-host"],
  "production-plugin-installation-runtime-support.ts": [
    "@crewon/plugin-host",
    "node:path",
  ],
  "production-plugin-installation-runtime.ts": ["@crewon/plugin-host"],
  "production-plugin-source-registry.ts": [
    "@crewon/plugin-host",
    "node:fs/promises",
    "node:path",
  ],
  "production-plugin-ui-composition.ts": ["@crewon/plugin-host"],
  "production-plugin-ui-environment.ts": ["node:path", "node:util"],
  "production-project-asset-plugin-runtime.ts": ["@crewon/plugin-host"],
  "production-project-conversation-runtime.ts": ["@crewon/plugin-host"],
  "production-project-foundation-plugin-runtime.ts": ["@crewon/plugin-host"],
  "production-project-generation-read-plugin-runtime.ts": [
    "@crewon/plugin-host",
  ],
  "production-project-generation-selection-plugin-runtime.ts": [
    "@crewon/plugin-host",
  ],
  "production-project-history-plugin-composition.ts": ["@crewon/plugin-host"],
  "production-project-private-file.ts": [
    "node:fs",
    "node:fs/promises",
    "node:path",
  ],
  "production-project-source-upload-plugin-runtime.ts": ["@crewon/plugin-host"],
  "production-project-text-plugin-runtime.ts": ["@crewon/plugin-host"],
  "project-asset-plugin-ui-composition.ts": ["@crewon/plugin-host"],
  "project-asset-stage-control-owner.ts": ["@crewon/plugin-host", "node:path"],
  "project-asset-v2-plugin-ui-composition.ts": ["@crewon/plugin-host"],
  "project-conversation-control-owner.ts": ["@crewon/plugin-host", "node:path"],
  "project-foundation-composition.ts": ["@crewon/media-runtime"],
  "project-foundation-plugin-ui-composition.ts": ["@crewon/plugin-host"],
  "project-generation-read-plugin-ui-composition.ts": ["@crewon/plugin-host"],
  "project-generation-selection-plugin-ui-owner.ts": ["@crewon/plugin-host"],
  "project-history-plugin-runtime.ts": ["@crewon/plugin-host"],
  "project-media-generation-plugin-ui-owner.ts": ["@crewon/plugin-host"],
  "project-media-input-plugin-ui-owner.ts": ["@crewon/plugin-host"],
  "project-media-input-stage-control-owner.ts": [
    "@crewon/plugin-host",
    "node:path",
  ],
  "project-media-result-plugin-ui-owner.ts": ["@crewon/plugin-host"],
  "project-source-upload-plugin-ui-composition.ts": ["@crewon/plugin-host"],
  "project-text-plugin-ui-composition.ts": ["@crewon/plugin-host"],
  "standalone-composition.ts": [
    "@crewon/media-runtime/desktop-project-material-archive",
  ],
} as const;

const workerAdapterImports = {
  "comfyui-material-upload.ts": [
    "@crewon/media-runtime/comfyui-material-upload",
  ],
  "comfyui-project-reference-material-adapter.ts": [
    "@crewon/media-runtime/comfyui-project-reference-material-adapter",
  ],
  "material-byte-snapshot.ts": ["@crewon/media-runtime/material-byte-snapshot"],
  "network-egress.ts": ["@crewon/media-runtime/network-egress"],
  "pinned-node-http.ts": ["@crewon/media-runtime/pinned-node-http"],
  "plugins/installed-plugin-business-registration.ts": ["@crewon/plugin-host"],
  "plugins/installed-plugin-execution-io-config.ts": [
    "@crewon/plugin-sdk/node",
  ],
  "plugins/installed-plugin-execution-io-owner.ts": ["@crewon/plugin-sdk/node"],
  "plugins/installed-plugin-execution-readiness-types.ts": [
    "@crewon/plugin-sdk/node",
  ],
  "plugins/installed-plugin-extension-host.ts": ["@crewon/plugin-host"],
  "plugins/installed-plugin-media-execution.ts": [
    "@crewon/plugin-host",
    "@crewon/plugin-sdk/node",
  ],
  "plugins/installed-plugin-native-authority.ts": ["@crewon/plugin-sdk/node"],
  "plugins/installed-plugin-native-candidate-state.ts": ["@crewon/plugin-host"],
  "plugins/installed-plugin-native-worker-composition.ts": [
    "@crewon/media-runtime/desktop-project-material-archive",
    "@crewon/plugin-sdk/node",
  ],
  "plugins/installed-plugin-project-services.ts": ["@crewon/plugin-host"],
  "plugins/installed-plugin-project-foundation-tools.ts": [
    "@crewon/plugin-host",
    "@crewon/plugin-sdk/node",
  ],
  "plugins/installed-plugin-runtime-project-services.ts": [
    "@crewon/plugin-host",
  ],
  "plugins/installed-plugin-project-tools.ts": [
    "@crewon/plugin-host",
    "@crewon/plugin-sdk/node",
  ],
  "plugins/installed-plugin-query-host.ts": ["@crewon/plugin-host"],
  "plugins/installed-plugin-readiness-core.ts": ["@crewon/plugin-host"],
  "plugins/installed-plugin-run-context.ts": ["@crewon/plugin-sdk/node"],
  "plugins/installed-plugin-runtime-resident.ts": ["@crewon/plugin-host"],
  "plugins/installed-plugin-runtime-resolver-package.ts": [
    "@crewon/plugin-host",
  ],
  "plugins/installed-plugin-runtime-resolver.ts": [
    "@crewon/plugin-host",
    "@crewon/plugin-sdk/node",
  ],
  "plugins/installed-plugin-runtime-tool-authorization.ts": [
    "@crewon/plugin-sdk/node",
  ],
  "plugins/installed-plugin-worker-authority.ts": ["@crewon/plugin-sdk/node"],
  "plugins/native-project-media-reviews.ts": [
    "@crewon/plugin-host",
    "@crewon/plugin-host/package-snapshot",
  ],
  "plugins/native-project-media-runtime.ts": [
    "@crewon/media-runtime/comfyui-project-reference-material-adapter",
    "@crewon/media-runtime/desktop-adopted-media-reader",
    "@crewon/media-runtime/desktop-project-material-archive",
    "@crewon/media-runtime/project-media-material-runtime",
  ],
  "plugins/native-project-planning-runtime.ts": ["@crewon/plugin-host"],
  "plugins/plugin-execution-io-network.ts": ["@crewon/plugin-sdk/contracts"],
  "plugins/plugin-execution-io.ts": ["@crewon/plugin-sdk/node"],
  "plugins/plugin-tool-runtime-adapter-data.ts": ["@crewon/plugin-sdk/node"],
  "plugins/plugin-tool-runtime-adapter.ts": ["@crewon/plugin-sdk/node"],
  "plugins/project-asset-tools-service-owner.ts": ["@crewon/plugin-host"],
  "plugins/project-media-input-read-scope.ts": ["@crewon/plugin-sdk/node"],
  "plugins/project-media-input-tools-service-owner.ts": ["@crewon/plugin-host"],
  "plugins/project-foundation-runtime-scope.ts": ["@crewon/plugin-sdk/node"],
  "plugins/project-foundation-tools-service-owner.ts": [
    "@crewon/plugin-host",
    "@crewon/plugin-sdk/node",
  ],
  "plugins/project-tools-service-owner.ts": [
    "@crewon/plugin-host",
    "@crewon/plugin-sdk/node",
  ],
  "project-material-png.ts": ["@crewon/media-runtime/project-material-png"],
  "project-material-preparation-support.ts": [
    "@crewon/media-runtime/project-material-preparation-support",
  ],
  "project-material-preparer.ts": [
    "@crewon/media-runtime/project-material-preparer",
  ],
  "project-media-execution-boundary.ts": ["@crewon/plugin-sdk/node"],
  "project-media-execution-review.ts": [
    "@crewon/plugin-sdk/contracts",
    "@crewon/plugin-sdk/node",
  ],
  "project-media-generation-task-preparer.ts": [
    "@crewon/media-runtime/project-media-generation-task-preparer",
  ],
  "project-media-material-preparer.ts": [
    "@crewon/media-runtime/project-media-material-preparer",
  ],
  "project-media-result-publisher.ts": [
    "@crewon/media-runtime/project-media-result-publisher",
  ],
  "project-reference-material-freezer.ts": [
    "@crewon/media-runtime/project-reference-material-freezer",
  ],
  "project-reference-material-reader.ts": [
    "@crewon/media-runtime/project-reference-material-reader",
  ],
  "provider-probe-egress.ts": ["@crewon/media-runtime/provider-probe-egress"],
} as const;

export const controlApiBoundary = {
  ...controlApiBaseBoundary,
  allowedFileImports: mergeFileImports(
    controlApiBaseBoundary.allowedFileImports,
    controlAdapterImports,
  ),
  allowedRuntimeDependencies: [
    ...controlApiBaseBoundary.allowedRuntimeDependencies,
    "@crewon/media-runtime",
    "@crewon/plugin-host",
  ],
} as const satisfies AppBoundary;

export const runtimeWorkerBoundary = {
  ...runtimeWorkerBaseBoundary,
  allowedFileImports: mergeFileImports(
    runtimeWorkerBaseBoundary.allowedFileImports,
    workerAdapterImports,
  ),
  allowedRuntimeDependencies: [
    ...runtimeWorkerBaseBoundary.allowedRuntimeDependencies,
    "@crewon/media-runtime",
    "@crewon/plugin-host",
  ],
} as const satisfies AppBoundary;
