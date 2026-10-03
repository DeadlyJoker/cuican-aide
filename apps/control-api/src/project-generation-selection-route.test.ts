import assert from "node:assert/strict";
import test from "node:test";
import { conceptSelectionHttpFixture } from "./project-generation-selection-route.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend} exact image selection HTTP saves original raw image and durable replay does not claim current pointer`,
    options,
    async (t) => {
      const f = await conceptSelectionHttpFixture(t, backend);
      const before = await f.counts();
      const credits = await f.credits.getAccount(f.creditScope);
      const get = () =>
        f.app.inject({ url: f.selectionUrl, headers: f.selectionHeaders() });
      const put = (key: string, body = f.selectionBody()) =>
        f.app.inject({
          method: "PUT",
          url: f.selectionUrl,
          headers: f.selectionHeaders(key),
          payload: body,
        });
      assert.deepEqual((await get()).json(), {
        selectionRevision: 0,
        current: null,
      });
      const first = await put("select-first");
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.json().disposition, "committed");
      assert.equal(first.json().selectionRevision, 1);
      assert.equal(first.json().selection.filename, "first.png");
      assert.equal(
        Object.hasOwn(first.json().selection, "requiresConfirmation"),
        false,
      );
      const second = await put("select-second", f.selectionBody(1, 1));
      assert.equal(second.statusCode, 200, second.body);
      assert.equal(second.json().selectionRevision, 2);
      const replay = await put("select-first");
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.json().disposition, "replayed");
      assert.equal(replay.json().selectionRevision, 1);
      assert.deepEqual(replay.json().selection, first.json().selection);
      const current = await get();
      assert.equal(current.statusCode, 200, current.body);
      assert.equal(current.json().selectionRevision, 2);
      assert.equal(current.json().current.filename, "second.png");
      assert.equal(current.json().current.requiresConfirmation, false);
      const stored = await f.selections.loadCurrentConceptSelection({
        owner: {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          principalId: f.actor.principalId,
        },
        projectId: f.reference.projectId,
        assetId: f.reference.assetId,
      });
      assert.equal(
        stored.current!.resultLink.image.providerReferenceJson,
        '{"filename":"second.png","subfolder":"","type":"output"}',
      );
      for (const secret of [
        "providerReferenceJson",
        "bindingDigest",
        "sourceRunId",
        "quotedCredits",
        "principalId",
        "packageDigest",
      ])
        assert.equal(current.body.includes(secret), false, secret);
      assert.deepEqual(await f.counts(), before);
      assert.deepEqual(await f.credits.getAccount(f.creditScope), credits);
      assert.equal(f.policy.hostCalls, 0);
    },
  );
  test(
    `${backend} selection HTTP fails closed on source mismatch, CAS, identity, CSRF and original read permissions`,
    options,
    async (t) => {
      const f = await conceptSelectionHttpFixture(t, backend);
      const put = (
        body: Record<string, unknown> = f.selectionBody(),
        headers: Record<string, string> = f.selectionHeaders("invalid-choice"),
        url = f.selectionUrl,
      ) => f.app.inject({ method: "PUT", url, headers, payload: body });
      const before = await f.counts();
      for (const patch of [
        { reference: { ...f.reference, assetId: "other" } },
        { resultIndex: 16 },
        { resultIndex: -1 },
        { expectedOperationRevision: 0 },
        { expectedSelectionRevision: -1 },
        { url: f.generation.images[0]!.url },
        { payerId: "other" },
      ])
        assert.equal(
          (await put({ ...f.selectionBody(), ...patch })).statusCode,
          400,
        );
      assert.equal(
        (
          await put(f.selectionBody(), {
            ...f.selectionHeaders("csrf"),
            "x-csrf-token": "wrong",
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (await put(f.selectionBody(), f.selectionHeaders())).statusCode,
        400,
      );
      assert.equal(
        (
          await put({
            ...f.selectionBody(),
            expectedOperationRevision: f.generation.operation.revision + 1,
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await put(
            f.selectionBody(),
            f.selectionHeaders("query"),
            `${f.selectionUrl}?x=1&x=2`,
          )
        ).statusCode,
        400,
      );
      for (const action of ["extension:query", "run:read"]) {
        f.policy.deniedTask = action;
        assert.equal(
          (
            await put(
              f.selectionBody(),
              f.selectionHeaders(action.replace(":", "-")),
            )
          ).statusCode,
          403,
        );
      }
      f.policy.deniedTask = "";
      f.policy.deniedProject = true;
      assert.equal((await put()).statusCode, 403);
      f.policy.deniedProject = false;
      f.selectionState.denyIdentity = true;
      assert.equal((await put()).statusCode, 401);
      f.selectionState.denyIdentity = false;
      assert.deepEqual(await f.counts(), before);
      assert.deepEqual(
        (
          await f.app.inject({
            url: f.selectionUrl,
            headers: f.selectionHeaders(),
          })
        ).json(),
        { selectionRevision: 0, current: null },
      );
      for (const method of ["POST", "DELETE", "HEAD"] as const)
        assert.equal(
          (
            await f.app.inject({
              method,
              url: f.selectionUrl,
              headers: f.selectionHeaders(),
            })
          ).statusCode,
          404,
        );
    },
  );
  test(
    `${backend} archived selection remains readable while fresh writes are refused and exact old receipt remains replayable`,
    options,
    async (t) => {
      const f = await conceptSelectionHttpFixture(t, backend);
      const write = () =>
        f.app.inject({
          method: "PUT",
          url: f.selectionUrl,
          headers: f.selectionHeaders("archive-selected"),
          payload: f.selectionBody(),
        });
      const original = await write();
      assert.equal(original.statusCode, 200, original.body);
      await f.projects.setProjectState(f.actor, {
        projectId: f.reference.projectId,
        expectedProjectRevision: f.reference.expectedProjectRevision,
        state: "archived",
        idempotencyKey: "archive-selection",
      });
      const current = await f.app.inject({
        url: f.selectionUrl,
        headers: f.selectionHeaders(),
      });
      assert.equal(current.statusCode, 200, current.body);
      assert.equal(current.json().current.filename, "first.png");
      const replay = await write();
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.json().disposition, "replayed");
      const project = await f.projects.getProject(f.actor, {
        projectId: f.reference.projectId,
      });
      const fresh = await f.app.inject({
        method: "PUT",
        url: f.selectionUrl,
        headers: f.selectionHeaders("archive-fresh"),
        payload: {
          ...f.selectionBody(1, 1),
          reference: {
            ...f.reference,
            expectedProjectRevision: project.revision,
          },
        },
      });
      assert.equal(fresh.statusCode, 409, fresh.body);
    },
  );
}
