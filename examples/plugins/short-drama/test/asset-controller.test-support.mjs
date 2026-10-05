import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { build } from "esbuild";
import { deferred } from "./persistent-ui.test-support.mjs";

const { outputFiles } = await build({
  entryPoints: [
    new URL("../src/workbench/ProjectAssetController.ts", import.meta.url)
      .pathname,
  ],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node24",
});
const { ProjectAssetController } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`
);
const copy = (value) => structuredClone(value);
const digest = `sha256:${"a".repeat(64)}`;
const at = "2026-10-06T00:00:00.000Z";
const details = (revision = 2, briefRevision = 1) => ({
  project: {
    projectId: "project-a",
    revision,
    latestBriefRevision: briefRevision,
    state: "active",
  },
  brief: { projectId: "project-a", briefRevision, contentDigest: digest },
});
const content = {
  name: "女主 · 修复师",
  setting: "  保留空格\n根据旧信寻找真相。",
  visualPrompt: "黑色短发，棕色围裙。",
};
const settle = async () => {
  await setImmediate();
  await setImmediate();
};

/** Public controller-port fixture only; genuine source qualification and SQL are covered by host tests. */
export function assetControllerFixture() {
  const calls = [],
    receipts = new Map(),
    revisions = new Map();
  let record = null,
    asset = null,
    nextLoss = null,
    gate = null,
    physical = false;
  let failCurrent = false,
    failRecovery = false,
    acknowledges = 0;
  const view = () =>
    asset && {
      asset: copy(asset),
      selectedContentRevision:
        revisions.get(asset.selectedContentRevision) ?? null,
      selectedReferenceRevision: null,
      dependencyState: asset.selectedContentRevision ? "current" : "unselected",
      staleReasons: [],
      referenceState: "unselected",
    };
  const client = {
    async listAssets(input) {
      calls.push(["listAssets", copy(input)]);
      return { assets: asset ? [copy(asset)] : [], nextAssetId: null };
    },
    async getAsset(input) {
      calls.push(["getAsset", copy(input)]);
      if (failCurrent) throw Error("read unavailable");
      return { view: view() };
    },
    async getRevision(input) {
      calls.push(["getRevision", copy(input)]);
      return { contentRevision: copy(revisions.get(input.contentRevision)) };
    },
    async listRevisions(input) {
      calls.push(["listRevisions", copy(input)]);
      return {
        revisions: [...revisions.values()].map(copy),
        nextContentRevision: null,
      };
    },
    async listReferences(input) {
      calls.push(["listReferences", copy(input)]);
      return { references: [], nextReferenceRevision: null };
    },
  };
  for (const method of [
    "saveCandidate",
    "selectRevision",
    "setLocked",
    "saveReferenceCandidate",
    "selectReference",
  ]) {
    client[method] = async (input) => {
      calls.push([method, copy(input)]);
      const original = {
        action: `crewon.project-assets.v1.${method}`,
        input: copy(input),
      };
      record ??= {
        intentId: "asset-intent-1",
        revision: 1,
        phase: "pending",
        request: original,
        requestDigest: digest,
        confirmed: null,
        refusalCode: null,
      };
      assert.deepEqual(
        record.request,
        original,
        "the durable slot retains the original body and key",
      );
      if (gate) {
        const hold = gate;
        gate = null;
        await hold;
      }
      if (nextLoss === "before") {
        nextLoss = null;
        throw Error("lost before dispatch");
      }
      if (receipts.has(input.idempotencyKey))
        return {
          ...copy(receipts.get(input.idempotencyKey)),
          disposition: "replayed",
        };
      let revision = null;
      if (method === "saveCandidate") {
        const n = revisions.size + 1;
        revision = {
          projectId: input.projectId,
          assetId: "asset-a",
          kind: input.request.kind,
          contentRevision: n,
          brief: {
            briefRevision: input.request.briefRevision,
            contentDigest: digest,
          },
          script: null,
          content: copy(input.request.content),
          contentDigest: digest,
          createdAt: at,
        };
        revisions.set(n, revision);
        asset = {
          projectId: input.projectId,
          assetId: "asset-a",
          kind: input.request.kind,
          revision: (asset?.revision ?? 0) + 1,
          latestContentRevision: n,
          selectedContentRevision: asset?.selectedContentRevision ?? null,
          latestReferenceRevision: 0,
          selectedReferenceRevision: null,
          locked: asset?.locked ?? false,
          createdAt: at,
          updatedAt: at,
        };
      } else {
        asset = {
          ...asset,
          revision: asset.revision + 1,
          ...(method === "selectRevision"
            ? { selectedContentRevision: input.request.contentRevision }
            : {}),
          ...(method === "setLocked" ? { locked: input.request.locked } : {}),
        };
      }
      const kind = {
        saveCandidate: "save-content",
        selectRevision: "select-content",
        setLocked: "set-lock",
        saveReferenceCandidate: "save-reference",
        selectReference: "select-reference",
      }[method];
      const result = {
        kind,
        disposition: "committed",
        asset: copy(asset),
        contentRevision: revision,
        referenceRevision: null,
      };
      receipts.set(input.idempotencyKey, copy(result));
      record = {
        ...record,
        phase: "accepted",
        revision: 2,
        confirmed: {
          kind,
          assetId: asset.assetId,
          assetRevision: asset.revision,
          contentRevision: revision?.contentRevision ?? null,
          referenceRevision: null,
          requestDigest: digest,
          resultDigest: digest,
        },
      };
      if (nextLoss === "after") {
        nextLoss = null;
        throw Error("COMMIT response lost");
      }
      return result;
    };
  }
  const recovery = {
    async getPending(input) {
      calls.push(["getPending", copy(input)]);
      if (failRecovery) throw Error("journal unavailable");
      return { intent: copy(record) };
    },
    async acknowledge(input) {
      calls.push(["acknowledge", copy(input)]);
      assert.equal(record.phase, "accepted");
      assert.equal(input.expectedRevision, record.revision);
      record = null;
      acknowledges++;
      return {
        disposition: "acknowledged",
        intentId: input.intentId,
        revision: input.expectedRevision + 1,
      };
    },
  };
  const create = () =>
    new ProjectAssetController({
      client,
      recovery,
      texts: {
        async listArtifacts() {
          return { artifacts: [], nextArtifactId: null };
        },
        async getArtifact() {
          throw Error("no script");
        },
        async getRevision() {
          throw Error("no script");
        },
      },
      physicalWritesPending: () => physical,
    });
  return {
    create,
    client,
    recovery,
    calls,
    revisions,
    receipts,
    get record() {
      return record;
    },
    get asset() {
      return asset;
    },
    get acknowledges() {
      return acknowledges;
    },
    loss(value) {
      nextLoss = value;
    },
    hold(promise) {
      gate = promise;
    },
    physical(value) {
      physical = value;
    },
    failCurrent(value) {
      failCurrent = value;
    },
    failRecovery(value) {
      failRecovery = value;
    },
  };
}
async function open(f) {
  const c = f.create();
  c.setProject(details());
  c.setReady(true);
  c.activate();
  await settle();
  return c;
}
function draft(c, kind = "character") {
  c.newAsset(kind);
  c.setDraft(content);
}
async function acknowledge(c) {
  await c.restoreRecovery();
  await c.acknowledgeRecovery();
}

export { copy, content, details, open, draft, acknowledge, settle };
