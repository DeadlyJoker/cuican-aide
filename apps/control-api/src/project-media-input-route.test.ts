import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { mediaInputControlFixture } from "./project-media-input.test-support.ts";
import { InstalledProjectMediaInputRuntime } from "./installed-project-media-input-runtime.ts";
import { captureInstalledProjectMediaInputConfiguration } from "./installed-project-media-input-configuration.ts";
import { createInstalledPluginTaskRuntimeCore } from "./installed-plugin-task-runtime-core.ts";
import { SqliteRunStore } from "@crewon/store";
import { parseSaveMediaInputResponse } from "@crewon/contracts/project-media-inputs";
import { ControlApiClient } from "@crewon/control-client";
import { ApplicationError } from "@crewon/application";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: shared HTTP saves T10/D18 exact inputs, replays and reads old revisions without media execution`,
    options,
    async (t) => {
      const f = await mediaInputControlFixture(t, backend);
      const receipts = await Promise.all([f.save(), f.save(), f.save()]);
      for (const r of receipts) assert.equal(r.statusCode, 200, r.body);
      assert.equal(
        receipts.filter((r) => r.json().disposition === "committed").length,
        1,
      );
      const old = parseSaveMediaInputResponse(
        f.command(),
        receipts[0]!.json(),
      ).input;
      assert.ok(
        receipts.every((r) => r.json().input.mediaInputId === old.mediaInputId),
      );
      const edited = {
        ...f.command(),
        mediaInputId: old.mediaInputId,
        expectedInputRevision: 1,
        prompt: "只改变构图，保留原选定人物。",
        idempotencyKey: "edit-confirmed-input",
      };
      const next = await f.save(f.app, edited);
      assert.equal(next.statusCode, 200, next.body);
      assert.equal(next.json().input.inputRevision, 2);
      const d18 = await f.save(f.app, f.command("D18"));
      assert.equal(d18.statusCode, 200, d18.body);
      assert.deepEqual(Object.keys(d18.json().input.references), [
        "scene",
        "characterOne",
        "characterTwo",
      ]);
      const latest = await f.app.inject({
        method: "GET",
        url: `${f.root}/${old.mediaInputId}`,
        headers: f.headers(),
      });
      assert.equal(latest.statusCode, 200, latest.body);
      assert.equal(latest.json().state.input.prompt, edited.prompt);
      const original = await f.app.inject({
        method: "GET",
        url: `${f.root}/${old.mediaInputId}?inputRevision=1`,
        headers: f.headers(),
      });
      assert.equal(original.statusCode, 200, original.body);
      assert.deepEqual(original.json().state.input, old);
      assert.equal(original.json().state.latestInputRevision, 2);
      for (const r of [...receipts, next, d18, latest, original])
        for (const hidden of [
          "https://",
          "profileId",
          "filename",
          "operationId",
          "packageDigest",
          "credential",
          "preparation",
        ])
          assert.equal(r.body.includes(hidden), false, `${hidden}: ${r.body}`);
      assert.deepEqual(await f.countMedia(), {
        project_media_inputs: 2,
        project_media_input_revisions: 3,
        project_media_input_receipts: 3,
      });
      await f.noExecution();
    },
  );
  test(
    `${backend}: original identity, profile, purpose and selected-source withdrawal deny metadata before commit`,
    options,
    async (t) => {
      const f = await mediaInputControlFixture(t, backend),
        before = await f.countMedia();
      for (const headers of [
        { authorization: "" },
        { origin: "https://wrong-origin.test" },
        { "x-csrf-token": "wrong" },
      ])
        assert.ok(
          (await f.save(f.app, f.command(), headers)).statusCode >= 400,
        );
      f.mediaPolicy.write = false;
      assert.equal((await f.save()).statusCode, 403);
      f.mediaPolicy.write = true;
      f.controlState.beforeMetadata = async (req) => {
        if (req.action === "projectMediaInput:write")
          f.controlState.profileId = "changed-profile-during-authorize";
      };
      assert.equal((await f.save()).statusCode, 403);
      f.controlState.beforeMetadata = undefined;
      f.controlState.profileId = f.target.installation.profileId;
      f.state.installationAllowed = false;
      assert.equal((await f.save()).statusCode, 403);
      f.state.installationAllowed = true;
      f.state.configurationAllowed = false;
      assert.equal((await f.save()).statusCode, 403);
      f.state.configurationAllowed = true;
      const drift = f.command();
      const badReference = {
        ...drift,
        references: {
          character: {
            ...drift.references.character!,
            expectedAssetRevision: 5,
          },
        },
      };
      assert.equal((await f.save(f.app, badReference)).statusCode, 409);
      assert.deepEqual(await f.countMedia(), before);
      await f.noExecution();
    },
  );
  test(
    `${backend}: public metadata rejects host routing, cross owners, stale revisions and idempotency mutation`,
    options,
    async (t) => {
      const f = await mediaInputControlFixture(t, backend),
        saved = await f.save();
      assert.equal(saved.statusCode, 200, saved.body);
      const actual = saved.json().input,
        counts = await f.countMedia();
      const { projectId: _, idempotencyKey, ...body } = f.command();
      for (const extra of [
        { target: { profileId: "foreign" } },
        { projectId: "foreign" },
        { url: "https://example.test/view" },
        { idempotencyKey: "foreign" },
      ]) {
        const r = await f.app.inject({
          method: "POST",
          url: f.root,
          headers: f.headers(idempotencyKey),
          payload: { ...body, ...extra },
        });
        assert.equal(r.statusCode, 400, r.body);
      }
      assert.equal(
        (
          await f.save(f.app, {
            ...f.command(),
            prompt: "same key, different content",
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await f.save(f.app, {
            ...f.command(),
            mediaInputId: actual.mediaInputId,
            expectedInputRevision: 2,
            idempotencyKey: "stale-edit",
          })
        ).statusCode,
        409,
      );
      for (const account of [1, 2, 3]) {
        const r = await f.app.inject({
          method: "GET",
          url: `${f.root}/${actual.mediaInputId}`,
          headers: f.headers("read", account),
        });
        assert.ok(r.statusCode >= 400, r.body);
        assert.equal(r.body.includes(actual.prompt), false);
      }
      f.mediaPolicy.read = false;
      assert.equal(
        (
          await f.app.inject({
            method: "GET",
            url: `${f.root}/${actual.mediaInputId}`,
            headers: f.headers(),
          })
        ).statusCode,
        403,
      );
      f.mediaPolicy.read = true;
      for (const query of [
        "inputRevision=01",
        "inputRevision=1&inputRevision=2",
        "target=anything",
      ])
        assert.equal(
          (
            await f.app.inject({
              method: "GET",
              url: `${f.root}/${actual.mediaInputId}?${query}`,
              headers: f.headers(),
            })
          ).statusCode,
          400,
        );
      assert.deepEqual(await f.countMedia(), counts);
      await f.noExecution();
    },
  );
  test(
    `${backend}: closed/reopened original Core reads exact inputs and recovers saved response without new record`,
    options,
    async (t) => {
      const f = await mediaInputControlFixture(t, backend),
        saved = await f.save();
      assert.equal(saved.statusCode, 200, saved.body);
      const original = saved.json().input;
      await f.app.close();
      await f.core.close();
      await f.requests.close();
      const cold = await f.cold(),
        reopened = await f.open(cold.parent);
      const replay = await f.save(reopened.app);
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.json().disposition, "replayed");
      assert.deepEqual(replay.json().input, original);
      const read = await reopened.app.inject({
        method: "GET",
        url: `${f.root}/${original.mediaInputId}?inputRevision=1`,
        headers: f.headers(),
      });
      assert.equal(read.statusCode, 200, read.body);
      assert.deepEqual(read.json().state.input, original);
      const native = await cold.app.loadInput(f.actor, {
        projectId: f.query.projectId,
        mediaInputId: original.mediaInputId,
        inputRevision: 1,
      });
      assert.equal(native?.input.contentDigest, original.contentDigest);
      assert.equal(f.controlState.quotes, 0);
      assert.equal(f.state.sourceGets, 0);
      assert.equal(f.state.uploads, 0);
    },
  );
}

test("native media owner rejects copied Core, wrong parent, proxy/getter configuration and unapproved target", async (t) => {
  const f = await mediaInputControlFixture(t, "sqlite"),
    other = new SqliteRunStore(":memory:");
  t.after(() => other.close());
  await assert.rejects(
    InstalledProjectMediaInputRuntime.prepare({
      core: { ...f.core },
      store: f.parent,
      configuration: f.configuration,
    }),
  );
  await assert.rejects(
    InstalledProjectMediaInputRuntime.prepare({
      core: f.core,
      store: other,
      configuration: f.configuration,
    }),
  );
  await assert.rejects(
    InstalledProjectMediaInputRuntime.prepare({
      core: f.core,
      store: f.parent,
      configuration: {
        ...f.configuration,
        reviews: f.reviews.map((r) => ({
          ...r,
          targetIdentity: {
            ...r.targetIdentity,
            packageDigest: "sha256:" + "b".repeat(64),
          },
        })),
      },
    }),
  );
  assert.throws(() =>
    captureInstalledProjectMediaInputConfiguration(
      new Proxy(f.configuration, {}),
    ),
  );
  let gets = 0;
  const altered = { ...f.configuration };
  Object.defineProperty(altered, "reviews", {
    enumerable: true,
    get() {
      gets++;
      return f.reviews;
    },
  });
  assert.throws(() => captureInstalledProjectMediaInputConfiguration(altered));
  assert.equal(gets, 0);
  const base = { ...f.input };
  delete (base as Partial<typeof base>).projectMediaInputs;
  const old = await createInstalledPluginTaskRuntimeCore(base);
  assert.equal(old.projectMediaInputs, undefined);
  await old.close();
  const limited = await createInstalledPluginTaskRuntimeCore({
    ...f.input,
    projectMediaInputs: { ...f.configuration, reviews: [f.reviews[0]!] },
  });
  try {
    await assert.rejects(
      limited.projectMediaInputs!.saveInput(
        {
          method: "POST",
          url: f.root,
          remoteAddress: "127.0.0.1",
          headers: f.headers(f.command("D18").idempotencyKey),
        },
        f.actor,
        f.command("D18"),
      ),
      (error) =>
        error instanceof ApplicationError &&
        error.category === "conflict" &&
        error.message === "project_media_input_workflow_unreviewed",
    );
  } finally {
    await limited.close();
  }
  await f.noExecution();
});
test("Core close fences metadata and physically joins pending original authorization; parent stays usable", async (t) => {
  const f = await mediaInputControlFixture(t, "sqlite");
  const entered = deferred(),
    held = deferred();
  f.controlState.beforeMetadata = async (req) => {
    if (req.action === "projectMediaInput:write") {
      entered.resolve();
      await held.promise;
    }
  };
  const saving = f.save();
  await entered.promise;
  const closing = f.core.close();
  assert.equal(f.core.close(), closing);
  let complete = false;
  void closing.then(() => {
    complete = true;
  });
  await setImmediate();
  assert.equal(complete, false);
  held.resolve();
  const outcome = await saving;
  assert.ok(outcome.statusCode >= 400);
  await closing;
  assert.deepEqual(await f.countMedia(), {
    project_media_inputs: 0,
    project_media_input_revisions: 0,
    project_media_input_receipts: 0,
  });
  assert.ok(
    await f.parent.creativeProjectStore().loadProject({
      owner: {
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        principalId: f.actor.principalId,
      },
      projectId: f.query.projectId,
    }),
  );
  await f.noExecution();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("original client uses real loopback HTTP to share confirmed input and replay its saved acknowledgement", async (t) => {
  const f = await mediaInputControlFixture(t, "sqlite"),
    baseUrl = await f.app.listen({ host: "127.0.0.1", port: 0 });
  const h = f.headers();
  const client = new ControlApiClient({
    baseUrl,
    accessToken: h.authorization.slice(7),
    csrfToken: h["x-csrf-token"],
    origin: h.origin,
  });
  const saved = await client.projectMediaInputs.saveInput(f.command());
  const read = await client.projectMediaInputs.loadInput({
    projectId: f.query.projectId,
    mediaInputId: saved.input.mediaInputId,
    inputRevision: null,
  });
  assert.deepEqual(read.state?.input, saved.input);
  f.state.installationAllowed = false;
  f.state.configurationAllowed = false;
  const replay = await client.projectMediaInputs.saveInput(f.command());
  assert.equal(replay.disposition, "replayed");
  assert.deepEqual(replay.input, saved.input);
  assert.deepEqual(await f.countMedia(), {
    project_media_inputs: 1,
    project_media_input_revisions: 1,
    project_media_input_receipts: 1,
  });
  await f.noExecution();
});
test("real HTTP disconnection withdraws the native request before metadata commit", async (t) => {
  const f = await mediaInputControlFixture(t, "sqlite"),
    baseUrl = await f.app.listen({ host: "127.0.0.1", port: 0 });
  const h = f.headers(),
    controller = new AbortController(),
    entered = deferred(),
    held = deferred(),
    observed = deferred();
  const client = new ControlApiClient({
    baseUrl,
    accessToken: h.authorization.slice(7),
    csrfToken: h["x-csrf-token"],
    origin: h.origin,
  });
  let withdrawn = false;
  f.controlState.beforeMetadata = async (req) => {
    if (req.action === "projectMediaInput:write") {
      const signal = f.core.requests.currentSignal();
      entered.resolve();
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      withdrawn = signal.aborted;
      observed.resolve();
      await held.promise;
    }
  };
  const saving = client.projectMediaInputs.saveInput(f.command(), {
    signal: controller.signal,
  });
  try {
    await entered.promise;
    controller.abort();
    await assert.rejects(saving);
    await observed.promise;
    assert.equal(withdrawn, true);
  } finally {
    controller.abort();
    held.resolve();
    await f.core.close();
  }
  assert.deepEqual(await f.countMedia(), {
    project_media_inputs: 0,
    project_media_input_revisions: 0,
    project_media_input_receipts: 0,
  });
  await f.noExecution();
});
