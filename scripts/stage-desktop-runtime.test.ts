import assert from "node:assert/strict";
import test from "node:test";

import { assertNode24, runtimeBundleSpecs } from "./stage-desktop-runtime.ts";

test("desktop staging contains only the active TypeScript runtime bundles", () => {
  const specs = runtimeBundleSpecs("/repo", "/runtime");

  assert.deepEqual(
    specs.map(({ entry, output }) => ({ entry, output })),
    [
      {
        entry: "/repo/apps/control-api/src/main.ts",
        output: "/runtime/control-api.mjs",
      },
      {
        entry: "/repo/apps/runtime-worker/src/main.ts",
        output: "/runtime/runtime-worker.mjs",
      },
      {
        entry: "/repo/apps/runtime-worker/src/release-main.ts",
        output: "/runtime/runtime-release.mjs",
      },
      {
        entry: "/repo/apps/runtime-worker/src/provider-model-catalog-main.ts",
        output: "/runtime/provider-model-catalog.mjs",
      },
      {
        entry:
          "/repo/apps/control-api/src/provider-settings-native-coordinator.ts",
        output: "/runtime/provider-settings-coordinator.mjs",
      },
      {
        entry: "/repo/apps/device-gateway/src/main.ts",
        output: "/runtime/device-gateway.mjs",
      },
      {
        entry: "/repo/scripts/local-workspace-checks-mcp.mjs",
        output: "/runtime/local-workspace-checks-mcp.mjs",
      },
    ],
  );
});

test("desktop staging accepts only Node 24", () => {
  assert.doesNotThrow(() => assertNode24("v24.10.0"));
  assert.throws(() => assertNode24("v22.22.0"), /requires Node 24/u);
  assert.throws(() => assertNode24("v25.0.0"), /requires Node 24/u);
});
