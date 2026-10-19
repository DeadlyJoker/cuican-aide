import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mediaExecutionFixture } from "./project-media-execution.test-support.ts";
import { ProjectMediaExecutionBoundary } from "./project-media-execution-boundary.ts";
import type { ProjectMediaExecutionReview } from "./project-media-execution-review.ts";
import { captureInstalledPluginMediaExecution } from "./plugins/installed-plugin-media-execution.ts";
import { captureInstalledPluginProjectMediaConfig } from "./plugins/installed-plugin-project-media-composition.ts";

// Real frozen workflow graphs and original admitted SQLite Run. Additional
// publication identities are named deployment metadata, not Native approvals.
function history(
  current: readonly ProjectMediaExecutionReview[],
  packageCount: number,
): readonly ProjectMediaExecutionReview[] {
  const digest = (name: string) =>
    `sha256:${createHash("sha256").update(name).digest("hex")}`;
  return [
    ...Array.from({ length: packageCount - 1 }, (_, index) =>
      current.map((review) => ({
        ...review,
        targetIdentity: {
          ...review.targetIdentity,
          version: `40.${index}.0`,
          packageDigest: digest(`history-package-${index}`),
          manifestDigest: digest(`history-manifest-${index}`),
          implementationDigest: digest(`history-node-${index}`),
        },
      })),
    ).flat(),
    ...current,
  ];
}

for (const packageCount of [17, 32])
  test(`${packageCount} immutable publications retain both execution workflows across composition and dispatch`, async (t) => {
    const f = await mediaExecutionFixture(t, "sqlite");
    const reviews = history(f.reviews, packageCount);
    const configured = captureInstalledPluginProjectMediaConfig({
      version: "crewon.project-media-worker.v1",
      metadataAuthorization: f.mediaAuthorization,
      authorization: f.authorization,
      createMaterials: async () => ({
        materials: f.materials,
        close: async () => {},
      }),
      reviews,
    });
    assert.equal(configured.reviews.length, packageCount * 2);
    const dependencies = captureInstalledPluginMediaExecution({
      contexts: f.reader,
      operations: f.operations,
      reviews: configured.reviews,
    });
    const boundary = new ProjectMediaExecutionBoundary({
      installed: f.installed,
      snapshot: f.snapshot,
      media: dependencies.contexts,
      operations: dependencies.operations,
      reviews: dependencies.reviews,
    });
    const io = f.owner(boundary);

    // Historical declarations cannot replace the current submit authorization.
    f.controls.submit = false;
    await assert.rejects(
      f.invoke(io, f.makeCommand(), async (command) => {
        await io.readProjectMediaInput({ command });
      }),
      /denied/u,
    );
    assert.equal(f.controls.posts, 0);
    assert.equal(f.controls.dns, 0);
    assert.deepEqual(await f.counts(), { slots: 0, operations: 0 });

    f.controls.submit = true;
    await f.invoke(io, f.makeCommand(), async (command) => {
      const { input, operationId, request } = await f.render(io, command);
      assert.equal(input.workflow.workflowId, "krea2-reference-four-view");
      const reserved = await io.services.externalOperations!.reserve({
        command,
        operationId,
        request,
      });
      assert.equal(reserved.disposition, "created");
      assert.ok(reserved.dispatchRef);
      await io.services.jsonHttp!.request({
        command,
        operationId,
        ...request,
        dispatchRef: reserved.dispatchRef,
      });
    });
    assert.equal(f.controls.posts, 1);
    assert.equal(f.controls.dns, 1);
    assert.deepEqual(await f.counts(), { slots: 1, operations: 1 });
  });

test("65 reviews and malformed historical graph pins fail before original operation reservation or network", async (t) => {
  const f = await mediaExecutionFixture(t, "sqlite");
  const valid = history(f.reviews, 32);
  const corrupt = valid.map((review, index) =>
    index === 0
      ? {
          ...review,
          workflow: {
            ...review.workflow,
            workflowDigest: `sha256:${"0".repeat(64)}`,
          },
        }
      : review,
  );
  for (const reviews of [
    [...valid, f.reviews[0]!],
    corrupt,
    new Proxy(valid, {}),
  ]) {
    assert.throws(() =>
      captureInstalledPluginProjectMediaConfig({
        version: "crewon.project-media-worker.v1",
        metadataAuthorization: f.mediaAuthorization,
        authorization: f.authorization,
        createMaterials: async () => ({
          materials: f.materials,
          close: async () => {},
        }),
        reviews,
      }),
    );
    assert.throws(() =>
      captureInstalledPluginMediaExecution({
        contexts: f.reader,
        operations: f.operations,
        reviews,
      }),
    );
    assert.throws(
      () =>
        new ProjectMediaExecutionBoundary({
          installed: f.installed,
          snapshot: f.snapshot,
          media: f.reader,
          operations: f.operations,
          reviews,
        }),
    );
  }
  assert.equal(f.controls.posts, 0);
  assert.equal(f.controls.dns, 0);
  assert.deepEqual(await f.counts(), { slots: 0, operations: 0 });
});
