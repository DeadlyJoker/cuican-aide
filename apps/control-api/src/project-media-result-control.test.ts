import assert from "node:assert/strict";
import test from "node:test";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { mediaResultControlFixture as fixture } from "./project-media-result-control.test-support.ts";
import {
  isInstalledProjectMediaResultRuntime,
  InstalledProjectMediaResultRuntime,
} from "./installed-project-media-result-runtime.ts";
const signal = () => new AbortController().signal;
for (const backend of ["sqlite", "postgres"] as const) {
  for (const kind of ["T10", "D18"] as const)
    test(
      `${backend} ${kind}: genuine owner publishes original output, serves verified PNG and cold reads without generation authority`,
      assetTestOptions(backend),
      async (t) => {
        const f = await fixture(t, backend, kind),
          before = await f.referenceSource();
        assert.equal(isInstalledProjectMediaResultRuntime(f.owner), true);
        assert.equal(
          isInstalledProjectMediaResultRuntime(
            Object.create(InstalledProjectMediaResultRuntime.prototype),
          ),
          false,
        );
        assert.deepEqual(
          await f.client.projectMediaResults.getCandidate(f.query),
          { candidate: null },
        );
        assert.equal(
          (
            await f.app.inject({
              method: "GET",
              url: f.path + "/content",
              headers: f.headers,
            })
          ).statusCode,
          404,
        );
        const saved = await f.client.projectMediaResults.publish(f.query);
        assert.equal(saved.disposition, "created");
        assert.equal(saved.candidate.runId, f.accepted.binding.runId);
        assert.equal(
          saved.candidate.inputRevision,
          f.task.reference.inputRevision,
        );
        assert.deepEqual(
          await f.client.projectMediaResults.readContent(saved.candidate),
          new Uint8Array(f.state.bytes),
        );
        assert.deepEqual(
          (await f.client.projectMediaResults.getCandidate(f.query)).candidate,
          saved.candidate,
        );
        const replay = await f.client.projectMediaResults.publish(f.query);
        assert.equal(replay.disposition, "replayed");
        assert.deepEqual(replay.candidate, saved.candidate);
        const content = await f.app.inject({
          method: "GET",
          url: f.path + "/content",
          headers: f.headers,
        });
        assert.equal(content.headers["cache-control"], "no-store");
        assert.equal(content.headers["x-content-type-options"], "nosniff");
        assert.equal(f.controlState.gets, 1);
        assert.equal(f.controls.posts, 1);
        assert.equal(await f.count(), 1);
        await f.close();
        const cold = await f.cold(),
          reopened = await f.openControl(cold.parent, ["read"]);
        f.controlState.network = false;
        const q = {
          projectId: f.query.projectId,
          afterCandidateId: null,
          limit: 16,
        };
        assert.deepEqual(
          (await reopened.client.projectMediaResults.listCandidates(q))
            .candidates,
          [saved.candidate],
        );
        assert.deepEqual(
          await reopened.client.projectMediaResults.readContent(
            saved.candidate,
          ),
          new Uint8Array(f.state.bytes),
        );
        await assert.rejects(
          reopened.client.projectMediaResults.publish(f.query),
        );
        assert.equal(f.controlState.gets, 1);
        assert.deepEqual(await f.referenceSource(), before);
        const child = cold.ext.projectMediaResults();
        await child.enableResultReads();
        assert.equal(child.version, undefined);
        assert.ok(await child.loadCandidate(f.request, f.authority()));
        await assert.rejects(
          child.qualifyPublication(f.request, f.authority("publish")),
          /unavailable/u,
        );
      },
    );
  test(
    `${backend}: original session, CSRF, profile and independent output/read grants protect all result routes`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const post = (
        headers = f.headers,
        payload: Record<string, unknown> = {},
      ) => f.app.inject({ method: "POST", url: f.path, headers, payload });
      assert.equal(
        (await post({ ...f.headers, authorization: "" })).statusCode,
        401,
      );
      assert.equal(
        (await post({ ...f.headers, "x-csrf-token": "" })).statusCode,
        403,
      );
      assert.equal(
        (await post({ ...f.headers, origin: "https://foreign.test" }))
          .statusCode,
        403,
      );
      assert.equal(
        (await post(f.headers, { url: "https://foreign.test" })).statusCode,
        400,
      );
      for (const suffix of [
        "?limit=0",
        "?limit=17",
        "?actor=other",
        "?limit=1&limit=2",
      ])
        assert.equal(
          (
            await f.app.inject({
              method: "GET",
              url: f.root + suffix,
              headers: f.headers,
            })
          ).statusCode,
          400,
        );
      for (const path of [f.root, f.path, f.path + "/content"])
        assert.equal(
          (
            await f.app.inject({
              method: "HEAD",
              url: path,
              headers: f.headers,
            })
          ).statusCode,
          404,
        );
      f.controlState.network = false;
      assert.equal((await post()).statusCode, 403);
      assert.equal(f.controlState.dns, 0);
      f.controlState.network = true;
      const profile = f.controlState.profileId;
      f.controlState.profileId = "other-profile";
      assert.equal((await post()).statusCode, 403);
      f.controlState.profileId = profile;
      for (const actor of [
        { ...f.actor, tenantId: "foreign" },
        { ...f.actor, spaceId: "foreign" },
        { ...f.actor, principalId: "foreign" },
      ])
        await assert.rejects(
          f.owner.read(f.controlRequest, actor, f.query, signal()),
        );
      const saved = await f.client.projectMediaResults.publish(f.query);
      f.controlState.allowed = false;
      await assert.rejects(
        f.client.projectMediaResults.readContent(saved.candidate),
      );
      assert.equal((await post()).statusCode, 403);
      assert.equal(f.controlState.gets, 1);
      assert.equal(await f.count(), 1);
    },
  );
  test(
    `${backend}: closing result owner joins its physical supplier read and leaves original Core usable`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((r) => (entered = r)),
        held = new Promise<void>((r) => (release = r));
      f.controlState.onGet = async () => {
        entered();
        await held;
      };
      const request = { ...f.controlRequest, method: "POST" };
      const pending = f.owner.publish(request, f.actor, f.query, signal());
      const rejected = assert.rejects(pending);
      await started;
      let closed = false;
      const closing = f.owner.close().then(() => (closed = true));
      await new Promise((r) => setImmediate(r));
      assert.equal(closed, false);
      release();
      await rejected;
      await closing;
      assert.equal(await f.count(), 0);
      await f.requests.run(
        {
          request: f.controlRequest,
          actor: f.actor,
          preparation: "configuration",
        },
        async () => {
          assert.deepEqual(f.requests.currentActor(), f.actor);
        },
      );
    },
  );
}
