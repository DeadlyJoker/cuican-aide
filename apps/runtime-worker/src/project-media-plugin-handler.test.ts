import assert from "node:assert/strict";
import test from "node:test";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import {
  mediaPluginFixture as fixture,
  mediaOutput,
} from "./project-media-plugin-handler.test-support.ts";
import { providerId } from "./project-media-execution.test-support.ts";
for (const backend of ["sqlite", "postgres"] as const) {
  for (const kind of ["T10", "D18"] as const)
    test(
      `${backend} installed Short21 ${kind}: actual handler submits and observes its declared output node`,
      assetTestOptions(backend),
      async (t) => {
        const f = await fixture(t, backend, kind),
          opened = await f.open();
        assert.equal(f.context.identity.version, "21.0.0");
        assert.equal(f.context.identity.packageDigest, f.pkg.packageDigest);
        const first = mediaOutput(
          await f.invoke(opened, f.makeCommand(opened.runtime)),
        );
        assert.equal(first.status, "submitted");
        assert.equal(first.projectId, f.query.projectId);
        assert.equal(first.workflowId, f.task.reference.workflowId);
        assert.equal(
          (await f.operations.loadProjectMediaOperation(f.scope))?.operation
            .providerOperationId,
          providerId,
        );
        assert.equal(f.controls.posts, 1);
        const node = kind === "T10" ? "129" : "17";
        f.controls.transport = async (request) => {
          assert.equal(request.method, "GET");
          assert.equal(
            request.target.endpoint.pathname,
            `/history/${providerId}`,
          );
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: Buffer.from(
              JSON.stringify({
                [providerId]: {
                  status: { status_str: "success", completed: true },
                  outputs: {
                    "29": {
                      images: [
                        {
                          filename: "wrong-node.png",
                          subfolder: "",
                          type: "output",
                        },
                      ],
                    },
                    [node]: {
                      images: [
                        {
                          filename: `${kind}-actual-node.png`,
                          subfolder: "fixture-output",
                          type: "output",
                        },
                      ],
                    },
                  },
                },
              }),
            ),
          };
        };
        const materials = [
          f.state.uploads,
          f.state.sourceGets,
          f.state.targetGets,
        ];
        const output = mediaOutput(
          await f.invoke(
            opened,
            f.makeCommand(opened.runtime, "media_observe"),
          ),
        );
        assert.equal(output.status, "succeeded");
        assert.equal(output.images[0].filename, `${kind}-actual-node.png`);
        assert.equal(output.imageCount, 1);
        assert.equal(output.hasMoreImages, false);
        assert.equal(
          (await f.operations.loadProjectMediaOperation(f.scope))?.operation
            .status,
          "succeeded",
        );
        await opened.close();
        await f.assets.setLocked(f.actor, {
          projectId: f.query.projectId,
          assetId: f.query.assetId,
          expectedAssetRevision: 4,
          locked: true,
          idempotencyKey: "handler-cold-source-change",
        });
        const cold = await f.open(await f.coldBoundary()),
          dns = f.controls.dns;
        const restored = mediaOutput(
          await f.invoke(cold, f.makeCommand(cold.runtime)),
        );
        assert.equal(restored.operationId, first.operationId);
        assert.equal(restored.status, "succeeded");
        assert.deepEqual(restored.images, output.images);
        assert.equal(f.controls.posts, 1);
        assert.equal(f.controls.dns, dns);
        assert.deepEqual(
          [f.state.uploads, f.state.sourceGets, f.state.targetGets],
          materials,
        );
        assert.deepEqual(await f.counts(), { slots: 1, operations: 1 });
        await cold.close();
      },
    );
  test(
    `${backend} installed Short21: full original evidence survives bounded model projection`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        opened = await f.open();
      await f.invoke(opened, f.makeCommand(opened.runtime));
      const images = Array.from({ length: 3 }, (_, i) => ({
        filename: "a".repeat(246) + i + ".png",
        subfolder: "景".repeat(300),
        type: "output",
      }));
      f.controls.transport = async () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(
          JSON.stringify({
            [providerId]: {
              status: { status_str: "success", completed: true },
              outputs: { "129": { images } },
            },
          }),
        ),
      });
      const result = await f.invoke(
        opened,
        f.makeCommand(opened.runtime, "media_observe"),
      );
      const projected = mediaOutput(result);
      assert.equal(projected.status, "succeeded");
      assert.equal(projected.imageCount, 3);
      assert.equal(projected.hasMoreImages, true);
      assert.ok(projected.images.length > 0 && projected.images.length < 3);
      if (result.status !== "completed")
        throw new Error("expected media result");
      assert.ok(
        Buffer.byteLength(JSON.parse(result.result.output).resultJson) <= 9999,
      );
      const original = (await f.operations.loadProjectMediaOperation(f.scope))!
        .operation;
      assert.deepEqual(
        JSON.parse(original.resultJson!).images.map(
          ({ url: _url, ...image }: Record<string, unknown>) => image,
        ),
        images,
      );
      await opened.close();
      const cold = await f.open(await f.coldBoundary());
      const restored = mediaOutput(
        await f.invoke(cold, f.makeCommand(cold.runtime)),
      );
      assert.deepEqual(restored, projected);
      assert.equal(f.controls.posts, 1);
      await cold.close();
    },
  );
  test(
    `${backend} installed Short21: observation with no reservation does not prepare or submit`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        opened = await f.open(),
        counts = [f.state.uploads, f.state.sourceGets, f.state.targetGets];
      f.controls.submit = false;
      assert.equal(
        (await f.invoke(opened, f.makeCommand(opened.runtime, "media_observe")))
          .status,
        "unknownOutcome",
      );
      assert.deepEqual(
        [f.state.uploads, f.state.sourceGets, f.state.targetGets],
        counts,
      );
      assert.equal(f.controls.posts, 0);
      assert.equal(f.controls.gets, 0);
      assert.deepEqual(await f.counts(), { slots: 0, operations: 0 });
      await opened.close();
    },
  );
  test(
    `${backend} installed Short21: model paths/prompts and other stage or legacy tools are denied`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        opened = await f.open(),
        counts = [f.state.uploads, f.state.sourceGets, f.state.targetGets];
      for (const input of [
        { prompt: "model replacement" },
        { operationId: providerId },
        { workflowId: "krea2-reference-four-view" },
        { images: { character: { filename: "invented.png" } } },
      ])
        await assert.rejects(
          f.invoke(
            opened,
            f.makeCommand(opened.runtime, "media_submit", input),
          ),
          /short_drama_media_model_input_forbidden/u,
        );
      for (const [name, input] of [
        ["submit", { prompt: "legacy bypass" }],
        ["project_context_read", {}],
        ["asset_context_read", {}],
      ] as const)
        await assert.rejects(
          f.invoke(opened, f.makeCommand(opened.runtime, name, input)),
          /short_drama_media_stage_operation_denied/u,
        );
      assert.deepEqual(
        [f.state.uploads, f.state.sourceGets, f.state.targetGets],
        counts,
      );
      assert.equal(f.controls.posts, 0);
      assert.deepEqual(await f.counts(), { slots: 0, operations: 0 });
      await opened.close();
    },
  );
  test(
    `${backend} installed Short21: lost response, warm reconciliation and cold different-key recovery never resubmit`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        opened = await f.open(),
        original = f.makeCommand(opened.runtime);
      f.controls.transport = async () => {
        throw new Error("named_handler_acceptance_response_lost");
      };
      const first = await f.invoke(opened, original);
      assert.equal(first.status, "unknownOutcome");
      assert.equal(f.controls.posts, 1);
      await assert.rejects(
        f.invoke(opened, original),
        /short_drama_media_reconciliation_required/u,
      );
      f.controls.transport = async () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(
          JSON.stringify({ queue_running: [], queue_pending: [] }),
        ),
      });
      const warm = await f.invoke(opened, original, "reconcile");
      assert.equal(warm.status, "unknownOutcome");
      assert.equal(warm.providerReceiptId, first.providerReceiptId);
      const materials = [
        f.state.uploads,
        f.state.sourceGets,
        f.state.targetGets,
      ];
      await opened.close();
      const cold = await f.open(await f.coldBoundary()),
        recovered = await f.invoke(cold, f.makeCommand(cold.runtime));
      assert.equal(recovered.status, "unknownOutcome");
      assert.equal(recovered.providerReceiptId, first.providerReceiptId);
      assert.equal(f.controls.posts, 1);
      assert.deepEqual(await f.counts(), { slots: 1, operations: 1 });
      assert.deepEqual(
        [f.state.uploads, f.state.sourceGets, f.state.targetGets],
        materials,
      );
      await cold.close();
    },
  );
  test(
    `${backend} installed Short21: acceptance persists after late cancel/revocation`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        opened = await f.open(),
        controller = new AbortController();
      f.controls.transport = async () => {
        f.controls.submit = false;
        f.controls.observe = false;
        f.controls.ioAuthorized = false;
        controller.abort(new Error("named_handler_late_cancel"));
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ prompt_id: providerId })),
        };
      };
      const output = mediaOutput(
        await f.invoke(
          opened,
          f.makeCommand(opened.runtime),
          "execute",
          controller.signal,
        ),
      );
      assert.equal(output.status, "submitted");
      assert.equal(
        (await f.operations.loadProjectMediaOperation(f.scope))?.operation
          .providerOperationId,
        providerId,
      );
      assert.equal(f.controls.posts, 1);
      await opened.close();
    },
  );
  test(
    `${backend} installed Short21: cancel never touches supplier or materials`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        opened = await f.open(),
        counts = [f.state.uploads, f.state.sourceGets, f.state.targetGets];
      assert.equal(
        (await f.invoke(opened, f.makeCommand(opened.runtime), "cancel"))
          .status,
        "unknownOutcome",
      );
      assert.equal(
        (
          await f.invoke(
            opened,
            f.makeCommand(opened.runtime, "media_observe"),
            "cancel",
          )
        ).status,
        "canceled",
      );
      assert.deepEqual(
        [f.state.uploads, f.state.sourceGets, f.state.targetGets],
        counts,
      );
      assert.equal(f.controls.posts, 0);
      assert.equal(f.controls.gets, 0);
      assert.deepEqual(await f.counts(), { slots: 0, operations: 0 });
      await opened.close();
    },
  );
}
