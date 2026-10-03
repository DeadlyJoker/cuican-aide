import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CREATIVE_PROJECT_RESPONSE_BYTES } from "@crewon/contracts";
import { generationReadHttpFixture } from "./project-generation-read-route.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend} saved generation HTTP resolves only its owner's exact source and performs no paid or supplier work`,
    options,
    async (context) => {
      const f = await generationReadHttpFixture(context, backend);
      const noLink = await f.app.inject({ url: f.url, headers: f.headers() });
      assert.equal(noLink.statusCode, 200, noLink.body);
      assert.deepEqual(noLink.json(), { generation: null });
      const committed = await f.commitGeneration();
      const before = await f.counts();
      const credits = await f.credits.getAccount(f.creditScope);
      const response = await f.app.inject({ url: f.url, headers: f.headers() });
      assert.equal(response.statusCode, 200, response.body);
      const generation = response.json().generation;
      assert.equal(generation.projectId, f.reference.projectId);
      assert.equal(generation.assetId, f.reference.assetId);
      assert.equal(generation.assetRevision, 1);
      assert.equal(generation.briefRevision, 1);
      assert.equal(generation.task.runId, committed.binding.runId);
      assert.equal(generation.task.threadId, committed.binding.threadId);
      assert.equal(generation.task.pluginId, committed.binding.pluginId);
      assert.equal(generation.task.sourceRunId, null);
      assert.deepEqual(generation.task.operations, []);
      assert.ok(
        Buffer.byteLength(response.body) <= MAX_CREATIVE_PROJECT_RESPONSE_BYTES,
      );
      for (const name of [
        "principalId",
        "actorId",
        "bindingDigest",
        "inputDigest",
        "quotedCredits",
        "poolId",
        "resultJson",
        "parameters",
      ])
        assert.equal(response.body.includes(name), false, name);
      assert.deepEqual(await f.counts(), before);
      assert.deepEqual(await f.credits.getAccount(f.creditScope), credits);
      assert.equal(f.policy.hostCalls, 0);
      for (const account of [1, 2, 3])
        assert.equal(
          (await f.app.inject({ url: f.url, headers: f.headers(account) }))
            .statusCode,
          404,
        );
      assert.equal((await f.app.inject({ url: f.url })).statusCode, 401);
      assert.equal(
        (
          await f.app.inject({
            url: `${f.base}/2/generation`,
            headers: f.headers(),
          })
        ).statusCode,
        404,
      );
    },
  );

  test(
    `${backend} saved generation HTTP exposes persisted operation revision and original result indices through the frozen configuration`,
    options,
    async (context) => {
      const f = await generationReadHttpFixture(context, backend);
      const { committed, images, operation } =
        await f.commitGenerationWithResult();
      const before = await f.counts();
      const credits = await f.credits.getAccount(f.creditScope);
      const response = await f.app.inject({ url: f.url, headers: f.headers() });
      assert.equal(response.statusCode, 200, response.body);
      const projected = response.json().generation.task.operations[0];
      assert.equal(projected.sourceRunId, committed.binding.runId);
      assert.equal(projected.operationId, operation.operationId);
      assert.equal(projected.operationRevision, operation.revision);
      assert.deepEqual(
        projected.images,
        images.map((image, resultIndex) => ({
          url: image.url,
          filename: image.filename,
          resultIndex,
        })),
      );
      assert.deepEqual(await f.counts(), before);
      assert.deepEqual(await f.credits.getAccount(f.creditScope), credits);
      assert.equal(f.policy.hostCalls, 0);
    },
  );

  test(
    `${backend} saved generation HTTP keeps archived input history readable and enforces both current project and original Run permissions`,
    options,
    async (context) => {
      const f = await generationReadHttpFixture(context, backend);
      await f.commitGeneration();
      await f.projects.setProjectState(f.actor, {
        projectId: f.reference.projectId,
        expectedProjectRevision: f.reference.expectedProjectRevision,
        state: "archived",
        idempotencyKey: "archive-existing-generation",
      });
      const response = await f.app.inject({ url: f.url, headers: f.headers() });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().generation.assetRevision, 1);
      f.policy.deniedProject = true;
      assert.equal(
        (await f.app.inject({ url: f.url, headers: f.headers() })).statusCode,
        403,
      );
      f.policy.deniedProject = false;
      for (const action of ["extension:query", "run:read"]) {
        f.policy.deniedTask = action;
        const denied = await f.app.inject({ url: f.url, headers: f.headers() });
        assert.equal(denied.statusCode, 403, `${action}: ${denied.body}`);
      }
      f.policy.deniedTask = "";
      assert.equal(
        (await f.app.inject({ url: f.url, headers: f.headers() })).statusCode,
        200,
      );
      assert.equal(f.policy.hostCalls, 0);
    },
  );

  test(
    `${backend} saved generation HTTP rejects query selectors, duplicate keys, non-canonical revisions and write verbs`,
    options,
    async (context) => {
      const f = await generationReadHttpFixture(context, backend);
      for (const search of [
        "?pluginId=other",
        "?runId=other",
        "?resultIndex=0",
        "?limit=1&limit=1",
      ])
        assert.equal(
          (
            await f.app.inject({
              url: `${f.url}${search}`,
              headers: f.headers(),
            })
          ).statusCode,
          400,
        );
      for (const revision of ["0", "01", "1e0", "9007199254740992"])
        assert.equal(
          (
            await f.app.inject({
              url: `${f.base}/${revision}/generation`,
              headers: f.headers(),
            })
          ).statusCode,
          400,
        );
      for (const method of ["POST", "PUT", "HEAD"] as const)
        assert.equal(
          (await f.app.inject({ method, url: f.url, headers: f.headers() }))
            .statusCode,
          404,
        );
      assert.equal(
        (await f.app.inject({ url: `${f.url}/private`, headers: f.headers() }))
          .statusCode,
        404,
      );
      assert.equal(
        (await f.app.inject({ url: f.url, headers: f.headers() })).statusCode,
        200,
      );
    },
  );
}
