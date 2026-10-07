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
export function assetControllerFixture({ briefDigest = digest } = {}) {
  const calls = [],
    receipts = new Map(),
    revisions = new Map(),
    references = new Map(),
    acknowledged = new Map();
  let record = null,
    asset = null,
    nextLoss = null,
    gate = null,
    physical = false;
  let failCurrent = false,
    failRecovery = false,
    acknowledges = 0,
    intentCounter = 0;
  const view = () =>
    asset && {
      asset: copy(asset),
      selectedContentRevision:
        revisions.get(asset.selectedContentRevision) ?? null,
      selectedReferenceRevision:
        references.get(asset.selectedReferenceRevision) ?? null,
      dependencyState: asset.selectedContentRevision ? "current" : "unselected",
      staleReasons: [],
      referenceState: asset.selectedReferenceRevision
        ? "current"
        : "unselected",
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
    async getReferenceRevision(input) {
      calls.push(["getReferenceRevision", copy(input)]);
      return {
        referenceRevision: copy(references.get(input.referenceRevision)),
      };
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
      return {
        references: [...references.values()].map(copy),
        nextReferenceRevision: null,
      };
    },
  };
  for (const method of [
    "saveCandidate",
    "selectRevision",
    "setLocked",
    "saveReferenceCandidate",
    "selectReference",
    "adoptMediaReference",
  ]) {
    client[method] = async (input) => {
      calls.push([method, copy(input)]);
      const original = {
        action: `crewon.project-assets.v2.${method}`,
        input: copy(input),
      };
      record ??= {
        intentId: `asset-intent-${++intentCounter}`,
        revision: 1,
        phase: "pending",
        request: original,
        requestDigest: digest,
        confirmed: null,
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
      let revision = null,
        reference = null;
      if (method === "saveCandidate") {
        const n = revisions.size + 1;
        revision = {
          projectId: input.projectId,
          assetId: "asset-a",
          kind: input.request.kind,
          contentRevision: n,
          brief: {
            briefRevision: input.request.briefRevision,
            contentDigest: briefDigest,
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
      if (method === "selectRevision")
        revision = revisions.get(input.request.contentRevision);
      if (method === "saveReferenceCandidate") {
        const n = references.size + 1,
          original = revisions.get(input.request.assetContentRevision);
        reference = {
          projectId: input.projectId,
          assetId: asset.assetId,
          referenceRevision: n,
          assetContentRevision: original.contentRevision,
          assetContentDigest: original.contentDigest,
          source: {
            kind: "concept-selection",
            conceptAssetId: input.request.conceptAssetId,
            conceptAssetRevision: 1,
            selectionRevision: input.request.selectionRevision,
            conceptSelectionDigest: digest,
            resultLinkDigest: digest,
            generationLinkDigest: digest,
            sourceRunId: "original-image-run",
            sourceBindingDigest: digest,
            pluginId: "crewon.short-drama",
            pluginVersion: "19.0.0",
            packageDigest: digest,
            configurationRevision: 1,
            configurationDigest: digest,
            operationId: "11111111-1111-4111-8111-111111111111",
            operationRevision: 2,
            operationDigest: digest,
            rawResultDigest: digest,
            resultIndex: 0,
          },
          createdAt: at,
          contentDigest: digest,
        };
        references.set(n, reference);
        asset.latestReferenceRevision = n;
      }
      if (method === "selectReference") {
        reference = references.get(input.request.referenceRevision);
        asset.selectedReferenceRevision = reference.referenceRevision;
      }
      if (method === "adoptMediaReference") {
        const n = references.size + 1,
          original = revisions.get(input.assetContentRevision);
        reference = {
          projectId: input.projectId,
          assetId: asset.assetId,
          referenceRevision: n,
          assetContentRevision: original.contentRevision,
          assetContentDigest: original.contentDigest,
          source: {
            kind: "media-result",
            candidateId: input.candidateId,
            candidateDigest: input.candidateDigest,
            sourceRunId: input.runId,
            resultIndex: input.resultIndex,
            mediaInputId: "input-a",
            inputRevision: 1,
            workflowId: "krea2-reference-four-view",
            observedAt: at,
            generatedFor: {
              assetId: asset.assetId,
              contentRevision: original.contentRevision,
              contentDigest: original.contentDigest,
              referenceRevision: 1,
              referenceDigest: digest,
            },
          },
          createdAt: at,
          contentDigest: digest,
        };
        references.set(n, reference);
        asset.latestReferenceRevision = n;
        asset.selectedReferenceRevision = n;
      }
      const kind = {
        saveCandidate: "save-content",
        selectRevision: "select-content",
        setLocked: "set-lock",
        saveReferenceCandidate: "save-reference",
        selectReference: "select-reference",
      }[method];
      const result = {
        ...(method === "adoptMediaReference"
          ? {}
          : { kind, contentRevision: revision }),
        disposition: "committed",
        asset: copy(asset),
        referenceRevision: copy(reference),
      };
      receipts.set(input.idempotencyKey, copy(result));
      record = {
        ...record,
        phase: "accepted",
        revision: 2,
        confirmed: {
          assetId: asset.assetId,
          assetRevision: asset.revision,
          contentRevision: revision?.contentRevision ?? null,
          referenceRevision: reference?.referenceRevision ?? null,
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
    async cancelPending(input) {
      calls.push(["cancelPending", copy(input)]);
      assert.equal(input.intentId, record.intentId);
      if (record.phase === "pending") {
        assert.equal(input.expectedRevision, record.revision);
        record = {
          ...record,
          revision: record.revision + 1,
          phase: "cancelled",
        };
      }
      return { intent: copy(record) };
    },
    async getPending(input) {
      calls.push(["getPending", copy(input)]);
      if (failRecovery) throw Error("journal unavailable");
      return { intent: copy(record) };
    },
    async acknowledge(input) {
      calls.push(["acknowledge", copy(input)]);
      if (acknowledged.has(input.intentId)) {
        assert.equal(
          input.expectedRevision,
          acknowledged.get(input.intentId).revision - 1,
        );
        return { ...acknowledged.get(input.intentId), disposition: "replayed" };
      }
      assert.ok(["accepted", "cancelled"].includes(record.phase));
      assert.equal(input.intentId, record.intentId);
      assert.equal(input.expectedRevision, record.revision);
      record = null;
      acknowledges++;
      const result = {
        disposition: "acknowledged",
        intentId: input.intentId,
        revision: input.expectedRevision + 1,
      };
      acknowledged.set(input.intentId, result);
      return result;
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
    references,
    mutateRecord(change) {
      record = change(copy(record));
    },
    editAsset(change) {
      asset = change(copy(asset));
    },
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
