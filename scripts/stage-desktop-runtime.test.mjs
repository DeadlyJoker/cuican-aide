import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertNoRemovedRuntimeMarkers,
  assertNode24Version,
  assertReleaseNodeMetadata,
} from "./stage-desktop-runtime.mjs";

test("accepts only the Node 24 runtime ABI", () => {
  assert.doesNotThrow(() => assertNode24Version("v24.18.1\n"));
  assert.throws(
    () => assertNode24Version("v22.22.0\n"),
    /must be a Node 24 executable/u,
  );
});

test("rejects removed runtime compatibility markers", () => {
  assert.doesNotThrow(() =>
    assertNoRemovedRuntimeMarkers("standard Responses runtime"),
  );
  for (const marker of [
    "CREWON_MODEL_ADAPTER",
    "CREWON_FAKE_",
    "DeterministicFakeModelTransport",
    "deterministic-fake",
    "CREWON_DEVICE_TOOL_CONFIG_PATH",
    "crewon.device-tool-runtime.v0",
    "deviceToolConfigPath",
    "crewon.device-command.v0",
    "crewon.device-workspace-list-command.v0",
    "Ed25519Device",
    "HttpsDeviceDispatchClient",
    "responsesLite",
    "responses-lite",
    "AppServerClient",
    "127.0.0.1:6176",
    "restart-app-server",
    "crewon-app-server",
    "crewon-device-runtime",
    "device-gateway",
  ]) {
    assert.throws(
      () => assertNoRemovedRuntimeMarkers(`bundle:${marker}`),
      new RegExp(marker, "u"),
    );
  }
});

test("release staging binds the distributable runtime to target and digest", () => {
  const digest = "a".repeat(64);
  const input = {
    actualSha256: digest,
    declaredSha256: digest,
    declaredTarget: "aarch64-apple-darwin",
    distributable: "1",
    target: "aarch64-apple-darwin",
  };
  assert.doesNotThrow(() => assertReleaseNodeMetadata(input));
  assert.throws(
    () =>
      assertReleaseNodeMetadata({
        ...input,
        declaredTarget: "x86_64-pc-windows-msvc",
      }),
    /must exactly match/u,
  );
  assert.throws(
    () =>
      assertReleaseNodeMetadata({ ...input, declaredSha256: "b".repeat(64) }),
    /does not match/u,
  );
  assert.throws(
    () => assertReleaseNodeMetadata({ ...input, distributable: undefined }),
    /CREWON_NODE_DISTRIBUTABLE=1/u,
  );
});

test("desktop bundle contains only the Tauri shell and TypeScript runtime", () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const config = JSON.parse(
    readFileSync(
      join(root, "apps/crewon-ui/src-tauri/tauri.conf.json"),
      "utf8",
    ),
  );
  assert.deepEqual(config.bundle.externalBin, [
    "binaries/crewon-process-guardian",
    "binaries/crewon-node",
  ]);
  assert.deepEqual(config.bundle.resources, [
    "binaries/runtime/control-api.mjs",
    "binaries/runtime/provider-settings-coordinator.mjs",
    "binaries/runtime/runtime-release.mjs",
    "binaries/runtime/runtime-worker.mjs",
  ]);
  const manifest = JSON.stringify(config.bundle);
  for (const removedRuntime of [
    "crewon-app-server",
    "crewon-device-runtime",
    "device-gateway",
  ]) {
    assert.equal(manifest.includes(removedRuntime), false);
  }
});
