import assert from "node:assert/strict";
import test from "node:test";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { parseGenerateProjectMediaResponse } from "@crewon/contracts/project-media-generations";
import { InstalledProjectMediaGenerationRuntime } from "./installed-project-media-generation-runtime.ts";
import { registerProjectMediaGenerationRoutes } from "./project-media-generation-route.ts";
import {
  mediaGenerationRuntimeFixture,
  barrier,
} from "./project-media-generation-runtime.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  for (const kind of ["T10", "D18"] as const)
    test(
      `${backend} ${kind}: authenticated generation route returns original receipt and replay performs no material I/O`,
      assetTestOptions(backend),
      async (t) => {
        const f = await mediaGenerationRuntimeFixture(t, backend, kind);
        const before = await f.countRuns();
        const accepted = await f.post();
        assert.equal(accepted.statusCode, 200, accepted.body);
        const result = parseGenerateProjectMediaResponse(
          f.command,
          accepted.json(),
        );
        assert.equal(result.disposition, "committed");
        assert.equal(result.threadId, f.binding.threadId);
        assert.equal(f.runtimeState.wakes, 1);
        assert.equal(f.state.uploads, kind === "T10" ? 1 : 3);
        assert.ok(f.runtimeState.materialChecks > 0);
        assert.equal(
          (await f.countRuns()).run_snapshots,
          before.run_snapshots! + 1,
        );
        const io = [f.state.sourceGets, f.state.uploads, f.state.targetGets];
        const replay = await f.post();
        assert.equal(replay.statusCode, 200, replay.body);
        assert.deepEqual(replay.json(), { ...result, disposition: "replayed" });
        assert.deepEqual(
          [f.state.sourceGets, f.state.uploads, f.state.targetGets],
          io,
        );
        const conflict = await f.post({
          body: { ...f.body, executionId: "different" },
        });
        assert.equal(conflict.statusCode, 409, conflict.body);
        assert.deepEqual(
          [f.state.sourceGets, f.state.uploads, f.state.targetGets],
          io,
        );
        assert.equal(f.runtimeState.wakes, 2);
      },
    );
  test(
    `${backend}: generation HTTP refuses forged fields, query, identity and CSRF before material I/O`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationRuntimeFixture(t, backend);
      const before = await f.countRuns();
      for (const body of [
        { ...f.body, profileId: f.pin.profileId },
        { ...f.body, projectId: f.command.projectId },
        { ...f.body, authorization: {} },
      ])
        assert.equal((await f.post({ body })).statusCode, 400);
      assert.equal(
        (await f.post({ url: f.url + "?profileId=changed" })).statusCode,
        400,
      );
      const unauthorized = await f.post({
        headers: { ...f.headers, authorization: "Bearer invalid" },
      });
      assert.equal(unauthorized.statusCode, 401, unauthorized.body);
      const csrf = await f.post({
        headers: { ...f.headers, "x-csrf-token": "invalid" },
      });
      assert.equal(csrf.statusCode, 403, csrf.body);
      const oversized = await f.post({
        body: { ...f.body, executionId: "x".repeat(4096) },
      });
      assert.equal(oversized.statusCode, 400, oversized.body);
      assert.deepEqual(
        [f.state.sourceGets, f.state.uploads, f.state.targetGets],
        [0, 0, 0],
      );
      assert.deepEqual(await f.countRuns(), before);
    },
  );
  test(
    `${backend}: independent generation purpose and current owner/profile are required on every request`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationRuntimeFixture(t, backend);
      const before = await f.countRuns();
      f.generation.allowed = false;
      assert.equal((await f.post()).statusCode, 403);
      f.generation.allowed = true;
      f.controlState.profileId = "another-profile";
      assert.equal((await f.post()).statusCode, 403);
      f.controlState.profileId = f.pin.profileId;
      await assert.rejects(
        f.owner.generate(
          f.request,
          { ...f.actor, actorId: "other-actor" },
          f.command,
        ),
      );
      await assert.rejects(f.materialScope().assertCurrent(f.actor));
      assert.throws(() => f.materialScope().assertActive(f.actor));
      f.mediaPolicy.read = false;
      // The first denied command is terminal; exercise metadata policy with a new intent.
      assert.equal(
        (
          await f.post({
            headers: {
              ...f.headers,
              "idempotency-key": "metadata-read-denied",
            },
            body: { ...f.body, executionId: "metadata-read-denied-execution" },
          })
        ).statusCode,
        403,
      );
      assert.deepEqual(
        [f.state.sourceGets, f.state.uploads, f.state.targetGets],
        [0, 0, 0],
      );
      assert.deepEqual(await f.countRuns(), before);
    },
  );
  test(
    `${backend}: withdrawing a live binding inside material policy prevents upload and Run admission`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationRuntimeFixture(t, backend);
      const before = await f.countRuns();
      f.state.onAuthorize = async (p) => {
        if (p.action === "projectMaterial:upload") {
          f.state.onAuthorize = undefined;
          await f.revoke();
        }
      };
      const response = await f.post();
      assert.notEqual(response.statusCode, 200);
      assert.equal(f.state.uploads, 0);
      assert.deepEqual(await f.countRuns(), before);
      assert.equal(f.runtimeState.wakes, 0);
    },
  );
  test(
    `${backend}: runtime close joins physical material preparation and releases once without closing borrowed Core`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationRuntimeFixture(t, backend);
      const entered = barrier(),
        release = barrier();
      f.state.onAuthorize = async (p) => {
        if (p.action === "projectMaterial:upload") {
          entered.resolve();
          await release.promise;
        }
      };
      const pending = f.owner.generate(f.request, f.actor, f.command);
      const rejected = assert.rejects(pending);
      await entered.promise;
      let closed = false;
      const close = f.owner.close().then(() => {
        closed = true;
      });
      await new Promise<void>((r) => setImmediate(r));
      assert.equal(closed, false);
      assert.equal(f.runtimeState.closed, 0);
      assert.throws(() => f.owner.generate(f.request, f.actor, f.command));
      release.resolve();
      await rejected;
      await close;
      await f.owner.close();
      assert.equal(f.runtimeState.closed, 1);
      assert.equal(f.state.uploads, 0);
      assert.ok(
        await f.parent.loadThreadInSpace({
          ...f.actor,
          threadId: f.binding.threadId,
        }),
      );
      await f.run(async () => f.requests.assertCurrent());
    },
  );
  test(
    `${backend}: invalid factory startup closes owned resources and copied owner cannot register a route`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationRuntimeFixture(t, backend);
      let closed = 0;
      await assert.rejects(
        InstalledProjectMediaGenerationRuntime.prepare({
          core: f.core,
          configuration: {
            ...f.configuration,
            createMaterials: async () => ({
              materials: {} as never,
              close: async () => {
                closed++;
              },
            }),
          },
        }),
      );
      assert.equal(closed, 1);
      let called = 0;
      const config = { ...f.configuration };
      Object.defineProperty(config, "createMaterials", {
        get: () => {
          called++;
          return f.configuration.createMaterials;
        },
        enumerable: true,
      });
      await assert.rejects(
        InstalledProjectMediaGenerationRuntime.prepare({
          core: f.core,
          configuration: config,
        }),
      );
      assert.equal(called, 0);
      await assert.rejects(
        InstalledProjectMediaGenerationRuntime.prepare({
          core: { ...f.core },
          configuration: f.configuration,
        }),
      );
      assert.throws(() =>
        registerProjectMediaGenerationRoutes(f.app, {
          identity: f.identity,
          owner: { ...f.owner } as never,
          outboxWakeup: { wake: async () => {} },
        }),
      );
    },
  );
  test(
    `${backend}: concurrent authenticated requests isolate scope and converge on one original Run`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationRuntimeFixture(t, backend);
      const entered = barrier(),
        release = barrier();
      f.state.onAuthorize = async (p) => {
        if (p.action === "projectMaterial:upload") {
          entered.resolve();
          await release.promise;
        }
      };
      const first = f.post();
      // Light-my-request starts when its thenable is observed.
      const firstResult = Promise.resolve(first);
      await entered.promise;
      const second = Promise.resolve(f.post());
      try {
        const foreign = await f.post({
          url: "/api/v1/creative-projects/another-project/media-generations",
        });
        assert.equal(foreign.statusCode, 403, foreign.body);
      } finally {
        release.resolve();
      }
      const results = await Promise.all([firstResult, second]);
      for (const result of results)
        assert.equal(result.statusCode, 200, result.body);
      assert.deepEqual(results.map((r) => r.json().disposition).sort(), [
        "committed",
        "replayed",
      ]);
      assert.equal(results[0]!.json().runId, results[1]!.json().runId);
      assert.equal(f.state.uploads, 1);
    },
  );
  test(
    `${backend}: actual HTTP disconnect cancels preparation; retry remains possible on the same owner`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationRuntimeFixture(t, backend);
      const entered = barrier(),
        release = barrier(),
        cancelled = barrier();
      const before = await f.countRuns();
      f.app.addHook("onRequest", async (_request, reply) => {
        reply.raw.once("close", () => {
          if (!reply.raw.writableEnded) cancelled.resolve();
        });
      });
      f.state.onAuthorize = async (p) => {
        if (p.action === "projectMaterial:upload") {
          entered.resolve();
          await release.promise;
        }
      };
      const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
      const controller = new AbortController();
      const pending = fetch(address + f.url, {
        method: "POST",
        headers: { ...f.headers, "content-type": "application/json" },
        body: JSON.stringify(f.body),
        signal: controller.signal,
      });
      const rejected = assert.rejects(pending);
      await entered.promise;
      try {
        controller.abort();
        await rejected;
        await cancelled.promise;
        assert.equal(f.state.uploads, 0);
        assert.deepEqual(await f.countRuns(), before);
      } finally {
        release.resolve();
      }
      f.state.onAuthorize = undefined;
      const retry = await f.post();
      assert.equal(retry.statusCode, 200, retry.body);
      assert.equal(retry.json().disposition, "committed");
      assert.equal(f.state.uploads, 1);
    },
  );
}
