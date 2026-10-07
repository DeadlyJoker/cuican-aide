import assert from "node:assert/strict";
import test from "node:test";
import { parseProjectMediaGenerationRecoveryResponse } from "@crewon/contracts/project-media-generation-recovery";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { InstalledProjectMediaGenerationRuntime } from "./installed-project-media-generation-runtime.ts";
import { mediaGenerationUiFixture } from "./project-media-generation-plugin-ui.test-support.ts";
import {
  barrier,
  mediaGenerationRuntimeFixture,
} from "./project-media-generation-runtime.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: HTTP and page share the exact staged command and accepted journal receipt`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationUiFixture(t, backend, { recovery: true });
      const url = `/api/v1/creative-projects/${f.command.projectId}/threads/${f.command.threadId}/media-generation-recovery`;
      const recover = () =>
        f.app.inject({ method: "GET", url, headers: f.headers });
      const empty = await recover();
      assert.equal(empty.statusCode, 200, empty.body);
      assert.deepEqual(empty.json(), { intent: null });
      const before = await f.countRuns();
      await f.stage();
      const staged = await recover();
      assert.equal(staged.statusCode, 200, staged.body);
      assert.deepEqual(staged.json(), await f.recover());
      assert.deepEqual(staged.json().intent.request.input, f.command);
      assert.equal(staged.json().intent.phase, "prepared");
      assert.equal(f.state.uploads, 0);
      assert.deepEqual(await f.countRuns(), before);
      const accepted = await f.post();
      assert.equal(accepted.statusCode, 200, accepted.body);
      const fromPage = parseProjectMediaGenerationRecoveryResponse(
        await f.recover(),
      );
      const fromHttp = parseProjectMediaGenerationRecoveryResponse(
        (await recover()).json(),
      );
      assert.deepEqual(fromHttp, fromPage);
      assert.equal(fromHttp.intent?.phase, "accepted");
      assert.equal(fromHttp.intent?.dispatchAttemptCount, 1);
      assert.deepEqual(fromHttp.intent?.receipt, accepted.json());
      const io = [f.state.sourceGets, f.state.uploads, f.state.targetGets];
      const replay = await f.invoke();
      assert.equal(replay.runId, accepted.json().runId);
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual(
        [f.state.sourceGets, f.state.uploads, f.state.targetGets],
        io,
      );
      assert.equal(
        (await f.countRuns()).run_snapshots,
        before.run_snapshots! + 1,
      );
    },
  );
  for (const kind of ["T10", "D18"] as const) {
    test(
      `${backend} ${kind}: new runtime recovers an interrupted HTTP intent and retries only its original key`,
      assetTestOptions(backend),
      async (t) => {
        const f = await mediaGenerationRuntimeFixture(t, backend, kind);
        const entered = barrier(),
          release = barrier();
        f.state.onAuthorize = async (p) => {
          if (p.action === "projectMaterial:upload") {
            entered.resolve();
            await release.promise;
          }
        };
        const before = await f.countRuns();
        const controller = new AbortController();
        const interrupted = assert.rejects(
          f.owner.generate(f.request, f.actor, f.command, controller.signal),
        );
        await entered.promise;
        controller.abort();
        const closing = f.owner.close();
        release.resolve();
        await interrupted;
        await closing;
        assert.equal(f.state.uploads, 0);
        assert.deepEqual(await f.countRuns(), before);
        f.state.onAuthorize = undefined;
        const fresh = await InstalledProjectMediaGenerationRuntime.prepare({
          core: f.core,
          configuration: f.configuration,
        });
        t.after(() => fresh.close());
        const readRequest = { ...f.request, method: "GET" };
        const selectors = {
          projectId: f.command.projectId,
          threadId: f.command.threadId,
        };
        const recovery = await fresh.getRecovery(
          readRequest,
          f.actor,
          selectors,
        );
        assert.equal(recovery.intent?.phase, "dispatched");
        assert.equal(recovery.intent?.retryable, true);
        assert.equal(recovery.intent?.dispatchAttemptCount, 1);
        assert.deepEqual(recovery.intent?.request.input, f.command);
        const io = [f.state.sourceGets, f.state.uploads, f.state.targetGets];
        await assert.rejects(
          fresh.generate(f.request, f.actor, {
            ...f.command,
            executionId: "new-execution",
            idempotencyKey: "new-key",
          }),
          /project_media_generation_recovery_required/u,
        );
        assert.deepEqual(
          [f.state.sourceGets, f.state.uploads, f.state.targetGets],
          io,
        );
        assert.deepEqual(await f.countRuns(), before);
        // The read result carries no generation permission.
        f.generation.allowed = false;
        await assert.rejects(
          fresh.generate(f.request, f.actor, recovery.intent!.request.input),
        );
        assert.equal(f.state.uploads, 0);
        f.generation.allowed = true;
        const accepted = await fresh.generate(
          f.request,
          f.actor,
          recovery.intent!.request.input,
        );
        assert.equal(accepted.disposition, "committed");
        const observed = await fresh.getRecovery(
          readRequest,
          f.actor,
          selectors,
        );
        assert.equal(observed.intent?.phase, "accepted");
        assert.deepEqual(observed.intent?.receipt, accepted);
        assert.equal(
          (await f.countRuns()).run_snapshots,
          before.run_snapshots! + 1,
        );
        const after = [f.state.sourceGets, f.state.uploads, f.state.targetGets];
        await fresh.close();
        const next = await InstalledProjectMediaGenerationRuntime.prepare({
          core: f.core,
          configuration: f.configuration,
        });
        t.after(() => next.close());
        assert.deepEqual(
          await next.getRecovery(readRequest, f.actor, selectors),
          observed,
        );
        const replay = await next.generate(f.request, f.actor, f.command);
        assert.equal(replay.runId, accepted.runId);
        assert.equal(replay.disposition, "replayed");
        assert.deepEqual(
          [f.state.sourceGets, f.state.uploads, f.state.targetGets],
          after,
        );
        assert.equal(
          f.runtimeState.wakes,
          0,
          "direct owner recovery does not invent outbox work",
        );
      },
    );
  }
  test(
    `${backend}: HTTP recovery is bounded, authenticated and scoped to the live project conversation`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationRuntimeFixture(t, backend);
      const url = `/api/v1/creative-projects/${f.command.projectId}/threads/${f.command.threadId}/media-generation-recovery`;
      const get = (path = url, headers = f.headers) =>
        f.app.inject({ method: "GET", url: path, headers });
      const before = await f.countRuns();
      assert.equal(
        (await get(url, { ...f.headers, authorization: "Bearer invalid" }))
          .statusCode,
        401,
      );
      assert.equal((await get(url + "?profileId=foreign")).statusCode, 400);
      assert.equal(
        (await get(url.replace(f.command.projectId, "foreign-project")))
          .statusCode,
        403,
      );
      assert.equal(
        (await get(url.replace(f.command.threadId, "foreign-thread")))
          .statusCode,
        403,
      );
      f.controlState.profileId = "foreign-profile";
      assert.equal((await get()).statusCode, 403);
      f.controlState.profileId = f.pin.profileId;
      f.generation.allowed = false;
      const read = await get(url, { ...f.headers, "x-csrf-token": "" });
      assert.equal(read.statusCode, 200, read.body);
      assert.deepEqual(read.json(), { intent: null });
      await assert.rejects(
        f.owner.getRecovery(
          { ...f.request, method: "GET" },
          { ...f.actor, actorId: "foreign" },
          {
            projectId: f.command.projectId,
            threadId: f.command.threadId,
          },
        ),
      );
      await f.revoke();
      assert.equal((await get()).statusCode, 403);
      assert.deepEqual(
        [f.state.sourceGets, f.state.uploads, f.state.targetGets],
        [0, 0, 0],
      );
      assert.deepEqual(await f.countRuns(), before);
      assert.equal(f.runtimeState.wakes, 0);
    },
  );
  test(
    `${backend}: concurrent page and HTTP dispatches converge without a second preparation or Run`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationUiFixture(t, backend, { recovery: true });
      await f.stage();
      const before = await f.countRuns();
      const [page, http] = await Promise.all([f.invoke(), f.post()]);
      assert.equal(http.statusCode, 200, http.body);
      assert.equal(page.runId, http.json().runId);
      assert.equal(f.state.uploads, 1);
      assert.equal(
        (await f.countRuns()).run_snapshots,
        before.run_snapshots! + 1,
      );
      const recovered = parseProjectMediaGenerationRecoveryResponse(
        await f.recover(),
      );
      assert.equal(recovered.intent?.phase, "accepted");
      assert.equal(recovered.intent?.receipt?.runId, page.runId);
    },
  );
}
