import assert from "node:assert/strict";
import test from "node:test";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import {
  mediaExecutionFixture as fixture,
  reviewedMediaGraphs,
  providerId,
} from "./project-media-execution.test-support.ts";
import { materialPng } from "./project-material-png.test-support.ts";
import { ProjectMediaExecutionBoundary } from "./project-media-execution-boundary.ts";
import {
  captureProjectMediaExecutionReview,
  expectedProjectMediaSubmission,
  mediaExecutionDigest,
} from "./project-media-execution-review.ts";
import { InstalledPluginRunContext } from "./plugins/installed-plugin-run-context.ts";
import {
  installedPluginMediaHostService,
  createInstalledPluginMediaBoundary,
} from "./plugins/installed-plugin-media-execution.ts";
import { installedPluginExternalOperationId } from "./plugins/installed-plugin-execution-io-config.ts";
import { authorizeInstalledPluginRuntimeTool } from "./plugins/installed-plugin-runtime-tool-authorization.ts";
import { createInstalledPluginExecutionIoOwner } from "./plugins/installed-plugin-execution-io-owner.ts";
import { deferred, tick } from "./plugin-tool-runtime-adapter.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  for (const kind of ["T10", "D18"] as const)
    test(
      `${backend} ${kind}: confirmed input renders actual frozen adapter and sends one original operation`,
      assetTestOptions(backend),
      async (t) => {
        const f = await fixture(t, backend, kind),
          io = f.owner(),
          command = f.makeCommand();
        await f.invoke(io, command, async (checked) => {
          const { input, operationId, request } = await f.render(io, checked);
          assert.deepEqual(
            request,
            expectedProjectMediaSubmission(
              f.reviews.find(
                (r) => r.workflow.workflowId === input.workflow.workflowId,
              )!,
              input,
              operationId,
            ),
          );
          const saved = await io.services.externalOperations!.reserve({
            command: checked,
            operationId,
            request,
          });
          assert.equal(saved.disposition, "created");
          assert.ok(saved.dispatchRef);
          const response = await io.services.jsonHttp!.request({
            command: checked,
            operationId,
            ...request,
            dispatchRef: saved.dispatchRef,
          });
          assert.equal(
            (response as { prompt_id: string }).prompt_id,
            providerId,
          );
          const advanced = await io.services.externalOperations!.advance({
            command: checked,
            operationId,
            expectedRevision: saved.operation.revision,
            providerOperationId: providerId,
            status: "running",
            resultJson: null,
          });
          assert.equal(advanced.operation.status, "running");
          const state = await f.operations.loadProjectMediaOperation(f.scope);
          assert.equal(state?.operation.operationId, operationId);
          assert.equal(state?.link.executionId, f.task.reference.executionId);
          assert.equal(state?.operation.executionId, command.executionId);
          assert.equal(
            state?.operation.requestDigest,
            mediaExecutionDigest(request),
          );
          assert.deepEqual(
            JSON.parse(Buffer.from(f.controls.requests[0]!.body!).toString()),
            request.body,
          );
        });
        assert.equal(f.controls.posts, 1);
        assert.equal(f.controls.dns, 1);
        assert.deepEqual(await f.counts(), { slots: 1, operations: 1 });
        const materials = [
          f.state.uploads,
          f.state.sourceGets,
          f.state.targetGets,
        ];
        await f.invoke(io, f.makeCommand(), async (checked) => {
          const input = await io.readProjectMediaInput({ command: checked });
          assert.equal(input.kind, "existing");
          if (input.kind !== "existing") throw new Error("expected_existing");
          assert.equal(input.operation.executionId, command.executionId);
          assert.equal(Object.hasOwn(input, "prompt"), false);
          assert.equal(
            (
              await io.services.externalOperations!.load({
                command: checked,
                operationId: input.operation.operationId,
              })
            )?.providerOperationId,
            providerId,
          );
          await io.services.jsonHttp!.request({
            command: checked,
            operationId: input.operation.operationId,
            method: "GET",
            path: `/history/${providerId}`,
          });
        });
        assert.equal(f.controls.posts, 1);
        assert.equal(f.controls.gets, 1);
        assert.deepEqual(
          [f.state.uploads, f.state.sourceGets, f.state.targetGets],
          materials,
        );
      },
    );

  test(
    `${backend}: prompt, reference path, model, seed and extra graph inputs cannot replace the confirmed submission`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        io = f.owner();
      await f.invoke(io, f.makeCommand(), async (checked) => {
        const { operationId, request } = await f.render(io, checked);
        const graph = (
          request.body as {
            prompt: Record<string, { inputs: Record<string, unknown> }>;
          }
        ).prompt;
        const fixed = Object.keys(graph).find(
          (id) => id !== "143" && id !== "146" && id !== "129",
        )!;
        const key = Object.keys(graph[fixed]!.inputs)[0]!;
        for (const mutate of [
          (g: typeof graph) => {
            g["143"]!.inputs.prompt = "unconfirmed text";
          },
          (g: typeof graph) => {
            g["146"]!.inputs.image = "some-other-file.png [output]";
          },
          (g: typeof graph) => {
            g[fixed]!.inputs[key] = "changed fixed selector or edge";
          },
          (g: typeof graph) => {
            g[fixed]!.inputs.seed = 999;
          },
          (g: typeof graph) => {
            g["99999"] = { inputs: {} } as never;
          },
        ]) {
          const changed = structuredClone(request);
          mutate((changed.body as { prompt: typeof graph }).prompt);
          await assert.rejects(
            io.services.externalOperations!.reserve({
              command: checked,
              operationId,
              request: changed,
            }),
            /project_media_execution_submission_mismatch/u,
          );
        }
        const wrongId = structuredClone(request);
        (wrongId.body as { client_id: string }).client_id = providerId;
        await assert.rejects(
          io.services.externalOperations!.reserve({
            command: checked,
            operationId,
            request: wrongId,
          }),
          /project_media_execution_submission_mismatch/u,
        );
      });
      assert.deepEqual(await f.counts(), { slots: 0, operations: 0 });
      assert.equal(f.controls.posts, 0);
      assert.equal(f.controls.dns, 0);
    },
  );

  test(
    `${backend}: byte change before reservation prevents both original claim and POST`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        io = f.owner();
      await f.invoke(io, f.makeCommand(), async (checked) => {
        const { operationId, request } = await f.render(io, checked);
        for (const key of f.state.files.keys())
          f.state.files.set(key, materialPng(5, 2));
        await assert.rejects(
          io.services.externalOperations!.reserve({
            command: checked,
            operationId,
            request,
          }),
          /project_media_generation_materials_unavailable/u,
        );
      });
      assert.deepEqual(await f.counts(), { slots: 0, operations: 0 });
      assert.equal(f.controls.posts, 0);
    },
  );

  for (const revoke of ["bytes", "pdp", "worker"] as const)
    test(
      `${backend}: ${revoke} changes after DNS block the physical send and never renew dispatch`,
      assetTestOptions(backend),
      async (t) => {
        const f = await fixture(t, backend),
          io = f.owner();
        let operationId = "";
        const controller = new AbortController();
        f.controls.afterDns = async () => {
          if (revoke === "bytes")
            for (const key of f.state.files.keys())
              f.state.files.set(key, materialPng(5, 2));
          if (revoke === "pdp") f.controls.submit = false;
          if (revoke === "worker")
            controller.abort(new Error("named_media_worker_cancelled"));
        };
        await f.invoke(
          io,
          f.makeCommand(),
          async (checked) => {
            const rendered = await f.render(io, checked);
            operationId = rendered.operationId;
            const saved = await io.services.externalOperations!.reserve({
              command: checked,
              operationId,
              request: rendered.request,
            });
            assert.ok(saved.dispatchRef);
            const request = {
              command: checked,
              operationId,
              ...rendered.request,
              dispatchRef: saved.dispatchRef,
            };
            await assert.rejects(io.services.jsonHttp!.request(request));
            assert.throws(() => io.services.jsonHttp!.request(request));
          },
          controller.signal,
        );
        f.controls.afterDns = undefined;
        assert.equal(f.controls.posts, 0);
        assert.equal(f.controls.dns, 1);
        assert.equal(
          (await f.operations.loadProjectMediaOperation(f.scope))?.operation
            .status,
          "submitting",
        );
        const counts = [
          f.state.sourceGets,
          f.state.uploads,
          f.state.targetGets,
        ];
        await f.invoke(io, f.makeCommand("observe"), async (checked) => {
          const input = await io.readProjectMediaInput({ command: checked });
          assert.equal(input.kind, "existing");
          if (input.kind !== "existing") throw new Error("expected_existing");
          assert.equal(input.operation.operationId, operationId);
          await io.services.jsonHttp!.request({
            command: checked,
            operationId,
            method: "GET",
            path: `/history/${operationId}`,
          });
        });
        assert.deepEqual(
          [f.state.sourceGets, f.state.uploads, f.state.targetGets],
          counts,
        );
        assert.equal(f.controls.posts, 0);
        assert.equal(f.controls.gets, 1);
      },
    );

  test(
    `${backend}: unknown supplier acceptance retains the original and a new Tool key cannot claim another operation`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        io = f.owner(),
        original = f.makeCommand();
      let oldId = "";
      f.controls.transport = async () => {
        throw new Error("named_media_response_lost_after_send");
      };
      await f.invoke(io, original, async (checked) => {
        const { operationId, request } = await f.render(io, checked);
        oldId = operationId;
        const saved = await io.services.externalOperations!.reserve({
          command: checked,
          operationId,
          request,
        });
        assert.ok(saved.dispatchRef);
        await assert.rejects(
          io.services.jsonHttp!.request({
            command: checked,
            operationId,
            ...request,
            dispatchRef: saved.dispatchRef,
          }),
          /named_media_response_lost_after_send/u,
        );
        const replay = await io.services.externalOperations!.reserve({
          command: checked,
          operationId,
          request,
        });
        assert.equal(replay.disposition, "existing");
        assert.equal(replay.dispatchRef, null);
      });
      f.controls.transport = undefined;
      await io.close();
      const restored = f.owner(await f.coldBoundary());
      await f.invoke(restored, f.makeCommand(), async (checked) => {
        const input = await restored.readProjectMediaInput({
          command: checked,
        });
        assert.equal(input.kind, "existing");
        if (input.kind !== "existing") throw new Error("expected_existing");
        assert.equal(input.operation.operationId, oldId);
        assert.equal(input.operation.providerOperationId, null);
        const operationId = installedPluginExternalOperationId(
          f.context,
          checked,
        );
        const media = await f.reader.load(f.snapshot, {
          purpose: "submit",
          ...f.signal(),
        });
        assert.ok(media);
        const prepared = await f.reader.prepareSubmit(media, f.signal());
        const request = expectedProjectMediaSubmission(
          f.reviews[0]!,
          prepared,
          operationId,
        );
        await assert.rejects(
          restored.services.externalOperations!.reserve({
            command: checked,
            operationId,
            request,
          }),
          /project_media_operation_occupied/u,
        );
        await restored.services.jsonHttp!.request({
          command: checked,
          operationId: oldId,
          method: "GET",
          path: `/history/${oldId}`,
        });
      });
      assert.deepEqual(await f.counts(), { slots: 1, operations: 1 });
      assert.equal(f.controls.posts, 1);
      assert.equal(f.controls.gets, 1);
    },
  );

  test(
    `${backend}: actually received response may persist after late revocation without permitting new IO`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        io = f.owner(),
        abort = new AbortController();
      f.controls.transport = async () => {
        f.controls.submit = false;
        f.controls.observe = false;
        f.controls.ioAuthorized = false;
        abort.abort(new Error("named_media_late_cancel"));
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ prompt_id: providerId })),
        };
      };
      await f.invoke(
        io,
        f.makeCommand(),
        async (checked) => {
          const { operationId, request } = await f.render(io, checked);
          const saved = await io.services.externalOperations!.reserve({
            command: checked,
            operationId,
            request,
          });
          assert.ok(saved.dispatchRef);
          await io.services.jsonHttp!.request({
            command: checked,
            operationId,
            ...request,
            dispatchRef: saved.dispatchRef,
          });
          const next = await io.services.externalOperations!.advance({
            command: checked,
            operationId,
            expectedRevision: 1,
            providerOperationId: providerId,
            status: "running",
            resultJson: null,
          });
          assert.equal(next.operation.providerOperationId, providerId);
          assert.throws(() =>
            io.services.externalOperations!.load({
              command: checked,
              operationId,
            }),
          );
        },
        abort.signal,
      );
      assert.equal(f.controls.posts, 1);
      assert.equal(
        (await f.operations.loadProjectMediaOperation(f.scope))?.operation
          .providerOperationId,
        providerId,
      );
    },
  );

  test(
    `${backend}: setup bridge and copied commands cannot read inputs; genuine active image capability can`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        io = f.owner(),
        original = f.makeCommand();
      let live = true;
      const service = installedPluginMediaHostService({
        context: f.context,
        io: () => io,
        assertActive: () => {
          if (!live) throw new Error("named_bridge_retired");
        },
      });
      const bridge = service.value as {
        readInput: typeof io.readProjectMediaInput;
        readOperation: typeof io.readProjectMediaOperation;
      };
      assert.throws(
        () => bridge.readInput({ command: original }),
        /plugin_execution_io_invocation_invalid/u,
      );
      assert.throws(
        () => bridge.readOperation({ command: original }),
        /plugin_execution_io_invocation_invalid/u,
      );
      await f.invoke(io, original, async (checked) => {
        assert.throws(
          () => bridge.readInput({ command: structuredClone(checked) }),
          /plugin_execution_io_invocation_invalid/u,
        );
        assert.throws(
          () => bridge.readOperation({ command: structuredClone(checked) }),
          /plugin_execution_io_invocation_invalid/u,
        );
        assert.equal(await bridge.readOperation({ command: checked }), null);
        assert.equal(
          (await bridge.readInput({ command: checked })).kind,
          "new",
        );
        live = false;
        assert.throws(
          () => bridge.readInput({ command: checked }),
          /named_bridge_retired/u,
        );
        assert.throws(
          () => bridge.readOperation({ command: checked }),
          /named_bridge_retired/u,
        );
      });
      await f.invoke(
        io,
        f.makeCommand("submit", "workspace.write"),
        async (checked) => {
          await assert.rejects(
            io.readProjectMediaInput({ command: checked }),
            /plugin_execution_io_media_capability_denied/u,
          );
        },
      );
      assert.equal(f.controls.posts, 0);
      assert.deepEqual(await f.counts(), { slots: 0, operations: 0 });
    },
  );

  test(
    `${backend}: genuine but different installed reader, copied snapshot and absent media composition fail closed`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const dependencies = {
        installed: f.installed,
        snapshot: f.snapshot,
        media: f.reader,
        operations: f.operations,
        reviews: f.reviews,
      };
      assert.throws(
        () =>
          new ProjectMediaExecutionBoundary({
            ...dependencies,
            snapshot: { ...f.snapshot },
          }),
        /installed_plugin_context_snapshot_invalid/u,
      );
      const other = new InstalledPluginRunContext({
        extensions: f.ext,
        runs: f.parent,
        installations: f.parent.pluginInstallationStore(),
        authorization: { authorize: async () => f.decision(true) },
        resolveActor: async () => f.actor,
      });
      const snapshot = await other.load({
        locator: {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          runId: f.accepted.binding.runId,
        },
        expectedTarget: f.accepted.binding.target,
        purpose: "submit",
        ...f.signal(),
      });
      assert.ok(snapshot);
      assert.throws(
        () =>
          new ProjectMediaExecutionBoundary({
            ...dependencies,
            installed: other,
            snapshot,
          }),
        /project_media_generation_dependency_invalid/u,
      );
      const admission = f.installed.verifiedTaskAdmission(f.snapshot);
      assert.throws(
        () =>
          createInstalledPluginMediaBoundary({
            dependencies: undefined,
            installed: f.installed,
            snapshot: f.snapshot,
            admission,
          }),
        /project_media_execution_unavailable/u,
      );
      assert.equal(
        createInstalledPluginMediaBoundary({
          dependencies: undefined,
          installed: f.installed,
          snapshot: f.snapshot,
          admission: { ...admission, action: "generate" },
        }),
        null,
      );
    },
  );

  test(
    `${backend}: IO close aborts and joins ongoing material preflight`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        io = f.owner(),
        entered = deferred(),
        release = deferred();
      f.state.onGet = async () => {
        entered.resolve();
        await release.promise;
      };
      const invocation = f.invoke(io, f.makeCommand(), async (checked) => {
        await io.readProjectMediaInput({ command: checked });
      });
      const rejected = assert.rejects(
        invocation,
        /plugin_execution_io_closed/u,
      );
      await entered.promise;
      let closed = false;
      const closing = io.close().then(() => {
        closed = true;
      });
      await tick();
      assert.equal(closed, false);
      release.resolve();
      await rejected;
      await closing;
      assert.equal(closed, true);
      assert.equal(f.controls.posts, 0);
      assert.deepEqual(await f.counts(), { slots: 0, operations: 0 });
    },
  );

  test(
    `${backend}: only image generation replay is classified as observation by the original runtime policy`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        io = f.owner();
      await f.invoke(io, f.makeCommand(), async (checked) => {
        const { operationId, request } = await f.render(io, checked);
        await io.services.externalOperations!.reserve({
          command: checked,
          operationId,
          request,
        });
      });
      const purposes: string[] = [];
      const check = async (capability: string) => {
        const command = f.makeCommand("submit", capability);
        const declared = {
          operationId: "submit",
          capability,
          effect: "mutation",
          recovery: "reconcilable",
          execution: "serial",
          description: "named declared policy",
          inputSchema: { type: "object" },
        };
        await authorizeInstalledPluginRuntimeTool({
          operation: { command, method: "execute", signal: f.signal().signal },
          context: f.context,
          tools: [declared] as never,
          approvalRequirement: "none",
          operations: f.boundary.operations,
          media: f.boundary,
          authorize: async (purpose) => {
            purposes.push(purpose);
          },
        });
      };
      await check("extension.image.generate");
      await check("workspace.write");
      assert.deepEqual(purposes, ["observe", "submit"]);
    },
  );
  test(
    `${backend}: original resolver IO composition requires a current network grant and rechecks it after DNS`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const base = {
        context: f.context,
        approvalRequirement: "none" as const,
        media: f.boundary,
        purpose: "submit" as const,
        ...f.signal(),
        authorize: async () => {},
        assertOpen: (signal: AbortSignal) => signal.throwIfAborted(),
      };
      await assert.rejects(
        createInstalledPluginExecutionIoOwner({ ...base, config: undefined }),
        /installed_plugin_media_io_unavailable/u,
      );
      assert.equal(
        await createInstalledPluginExecutionIoOwner({
          ...base,
          config: undefined,
          media: null,
        }),
        null,
      );
      let allowed = true,
        sends = 0;
      const config = {
        operations: f.operations,
        resolveNetwork: async () =>
          allowed
            ? {
                baseUrlParameter: "baseUrl",
                paths: [{ method: "POST" as const, path: "/prompt" }],
              }
            : null,
        dns: {
          resolveAll: async () => {
            allowed = false;
            return [{ address: "8.8.8.8", family: 4 as const }];
          },
        },
        transport: {
          request: async () => {
            sends++;
            throw new Error("unexpected_physical_send");
          },
        },
      };
      const io = await createInstalledPluginExecutionIoOwner({
        ...base,
        config,
      });
      assert.ok(io);
      t.after(() => io.close());
      await f.invoke(io, f.makeCommand(), async (checked) => {
        const { operationId, request } = await f.render(io, checked);
        const saved = await io.services.externalOperations!.reserve({
          command: checked,
          operationId,
          request,
        });
        assert.ok(saved.dispatchRef);
        await assert.rejects(
          io.services.jsonHttp!.request({
            command: checked,
            operationId,
            ...request,
            dispatchRef: saved.dispatchRef,
          }),
          /installed_plugin_runtime_network_denied/u,
        );
      });
      assert.equal(sends, 0);
      assert.deepEqual(await f.counts(), { slots: 1, operations: 1 });
      await assert.rejects(
        createInstalledPluginExecutionIoOwner({ ...base, config }),
        /installed_plugin_media_io_unavailable/u,
      );
    },
  );
}

type MutableReview = {
  -readonly [K in keyof import("./project-media-execution-review.ts").ProjectMediaExecutionReview]: import("./project-media-execution-review.ts").ProjectMediaExecutionReview[K];
};
test("actual workflow review rejects digest, mutable-slot and output-node ambiguity", async (t) => {
  const f = await fixture(t, "sqlite");
  for (const mutate of [
    (r: MutableReview) => {
      r.workflow = {
        ...r.workflow,
        workflowDigest: `sha256:${"0".repeat(64)}`,
      };
    },
    (r: MutableReview) => {
      r.promptBinding = { nodeId: "146", input: "image" };
    },
    (r: MutableReview) => {
      r.imageBindings = [{ role: "character", nodeIds: ["146", "146"] }];
    },
    (r: MutableReview) => {
      const graph = r.template as Record<string, { class_type: string }>;
      graph["129"]!.class_type = "CLIPTextEncode";
      r.workflow = {
        ...r.workflow,
        workflowDigest: mediaExecutionDigest(graph),
      };
    },
  ]) {
    const review = structuredClone(f.reviews[0]!);
    mutate(review);
    assert.throws(
      () => captureProjectMediaExecutionReview(review),
      /project_media_execution_review_invalid/u,
    );
  }
  const captured = captureProjectMediaExecutionReview(f.reviews[0]);
  assert.equal(Object.isFrozen(captured.template), true);
  assert.equal(Object.isFrozen(f.boundary.operations), true);
  assert.equal(Object.isFrozen(f.boundary), true);
  assert.throws(() =>
    Object.defineProperty(f.boundary, "operations", { value: {} }),
  );
  const graphs = await reviewedMediaGraphs();
  assert.equal(graphs.graphs.length, 2);
});
