import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rename, writeFile } from "node:fs/promises";
import {
  PROJECT_ASSET_V2_ACTIONS as actions,
  parseProjectAssetV2Request,
  parseProjectAssetV2Response,
} from "@crewon/contracts/project-assets-v2";
import {
  PROJECT_ASSET_RECOVERY_V2_ACTIONS as recovery,
  parseProjectAssetRecoveryV2Request,
  parseProjectAssetRecoveryV2Response,
} from "@crewon/contracts/project-asset-recovery-v2";
import { desktopNativeMediaInputFixture as fixture } from "./desktop-native-project-media-input.test-support.ts";
import {
  activateNativeProjectUi,
  remountNativeProjectUi,
} from "./desktop-native-project-ui.test-support.ts";
const options = { skip: process.platform === "win32", timeout: 30_000 };
const config = {
  packageDirectory:
    "output/extensions/installable-plugins/short-drama-media-output-ui-20261007/short-drama/30.0.0",
  assetProtocol: "2" as const,
  assetV2: true,
  mediaGenerations: true,
  generationFlow: true,
  mediaResults: ["read", "publish"] as const,
};
type Native = Awaited<ReturnType<typeof fixture>>;
function client(
  f: Pick<Native, "runtime" | "request" | "actor">,
  mountRef: string,
) {
  const invoke = (q: { action: string; input: unknown }) =>
    f.runtime.ui.invokeAuthenticatedRequest!(
      f.request(),
      f.actor,
      { mountRef, action: q.action, input: q.input as never },
      new AbortController().signal,
    );
  return {
    assets: async (method: keyof typeof actions, input: unknown) => {
      const q = parseProjectAssetV2Request({ action: actions[method], input });
      return parseProjectAssetV2Response(q, await invoke(q));
    },
    recovery: async (method: keyof typeof recovery, input: unknown = {}) => {
      const q = parseProjectAssetRecoveryV2Request({
        action: recovery[method],
        input,
      });
      return parseProjectAssetRecoveryV2Response(q, await invoke(q));
    },
    invoke,
  };
}
const creation = (projectId: string, key = "native-v2-character") => ({
  projectId,
  assetId: null,
  request: {
    kind: "character",
    expectedAssetRevision: 0,
    briefRevision: 1,
    script: null,
    content: {
      name: "林予",
      setting: "旧城修复师",
      visualPrompt: "A cinematic portrait of a restorer.",
    },
  },
  idempotencyKey: key,
});
test(
  "Native installed V2 UI persists a write across full owner/SQLite reopen and ACKs without task dispatch",
  options,
  async (t) => {
    const f = await fixture(t, ["read", "write"], config);
    const { mount, selected } = await activateNativeProjectUi(f);
    let ui = client(f, mount.mountRef);
    const before = [...f.peer];
    assert.deepEqual(await ui.recovery("getPending"), { intent: null });
    const q = creation(f.query.projectId);
    const result = await ui.assets("saveCandidate", q);
    assert.ok("kind" in result);
    const pending = await ui.recovery("getPending");
    assert.ok("intent" in pending && pending.intent?.phase === "accepted");
    assert.equal(pending.intent.confirmed.assetId, result.asset.assetId);
    await f.app.close();
    await f.runtime.close();
    const cold = await f.reopen();
    const nextMount = await remountNativeProjectUi(
      { ...f, ...cold },
      selected.mutation.selection.revision,
    );
    ui = client({ ...f, ...cold }, nextMount.mountRef);
    assert.deepEqual(await ui.recovery("getPending"), pending);
    assert.deepEqual(await ui.assets("saveCandidate", q), {
      ...result,
      disposition: "replayed",
    });
    const ack = await ui.recovery("acknowledge", {
      intentId: pending.intent.intentId,
      expectedRevision: 2,
    });
    assert.ok("disposition" in ack && ack.disposition === "acknowledged");
    assert.deepEqual(await ui.recovery("getPending"), { intent: null });
    const listed = await ui.assets("listAssets", {
      projectId: f.query.projectId,
      afterAssetId: null,
      limit: 16,
    });
    assert.ok("assets" in listed);
    assert.equal(listed.assets.length, 1);
    const view = await ui.assets("getAsset", {
      projectId: f.query.projectId,
      assetId: result.asset.assetId,
    });
    assert.ok("view" in view);
    assert.equal(view.view?.asset.assetId, result.asset.assetId);
    assert.deepEqual(f.peer, before);
  },
);
test(
  "Native V2 UI rejects absent opt-in, foreign actors and withdrawn bootstrap ownership",
  options,
  async (t) => {
    const missing = await fixture(t, ["read", "write"], {
      ...config,
      assetV2: false,
    });
    const unavailable = await activateNativeProjectUi(missing);
    await assert.rejects(
      client(missing, unavailable.mount.mountRef).recovery("getPending"),
    );
    const f = await fixture(t, ["read", "write"], config);
    const { mount } = await activateNativeProjectUi(f);
    const ui = client(f, mount.mountRef),
      before = [...f.peer];
    const foreign = client(
      { ...f, actor: { ...f.actor, principalId: "foreign-principal" } },
      mount.mountRef,
    );
    await assert.rejects(foreign.recovery("getPending"));
    // Same bytes at a replacement inode must not keep the former Native grant live.
    const bytes = await readFile(f.bootstrapPath);
    await rename(f.bootstrapPath, f.bootstrapPath + ".previous");
    await writeFile(f.bootstrapPath, bytes, { mode: 0o600 });
    await assert.rejects(
      ui.assets("saveCandidate", creation(f.query.projectId)),
    );
    await assert.rejects(ui.recovery("getPending"));
    assert.deepEqual(f.peer, before);
  },
);
