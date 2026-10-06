import assert from "node:assert/strict";
import test from "node:test";
import { ProjectMediaGenerationCommands } from "@crewon/media-runtime";
import { mediaGenerationFixture } from "./project-media-generation.test-support.ts";
import {
  mediaWorkerFixture,
  finishMediaWorkerRun,
} from "./project-media-worker.test-support.ts";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { deferred } from "./runtime-store-access.test-support.ts";

type Fixture = Awaited<ReturnType<typeof mediaGenerationFixture>>;
function commands(f: Fixture) {
  return new ProjectMediaGenerationCommands({
    profileId: f.pin.profileId,
    preparer: f.issuer,
    tasks: f.service,
    extensions: f.ext,
    admissions: { resolve: async () => f.pin },
  });
}
async function setup(f: Fixture) {
  const saved = await f.app.saveInput(f.actor, f.command);
  return {
    ...f.mediaQuery(saved.input),
    executionId: "page-agent-shared-intent",
    threadId: "media-task-thread",
    expectedThreadRevision: 1,
    idempotencyKey: "shared-create",
  };
}
const ioCounts = (f: Pick<Fixture, "state">) => [
  f.state.sourceGets,
  f.state.uploads,
  f.state.targetGets,
];

for (const backend of ["sqlite", "postgres"] as const) {
  for (const kind of ["T10", "D18"] as const)
    test(
      `${backend} ${kind}: shared command prepares actual materials, runs installed Worker and publishes original candidate`,
      assetTestOptions(backend),
      async (t) => {
        const f = await mediaWorkerFixture(t, backend, kind, "shared-command");
        assert.ok(f.sharedCommand);
        const opened = await f.open(undefined, {
          executionBudget: { maxBoundariesPerWake: 1 },
        });
        const { outcome, yields } = await finishMediaWorkerRun(
          opened.worker,
          f.accepted.binding.runId,
        );
        assert.ok(
          yields > 0,
          "Actual command resumes the original Run after a real scheduler yield",
        );
        assert.equal(
          outcome.kind,
          "completed",
          JSON.stringify({
            outcome,
            run: await f.parent.loadRun(f.accepted.binding),
          }),
        );
        assert.equal(f.state.posts, 1);
        const { result } = await f.publish();
        assert.equal(result.disposition, "created");
        assert.equal(
          result.candidate.frozen.source.projection.reference.executionId,
          f.sharedCommand.executionId,
        );
        const before = [
          f.state.posts,
          ...ioCounts({ ...f, state: f.materialState }),
        ];
        const replay = await f.commands.generate(
          f.actor,
          f.sharedCommand,
          f.signal(),
        );
        assert.equal(replay.run.disposition, "replayed");
        assert.deepEqual(replay.binding, f.accepted.binding);
        assert.deepEqual(
          [f.state.posts, ...ioCounts({ ...f, state: f.materialState })],
          before,
        );
        await opened.close();
      },
    );

  test(
    `${backend}: two independent command owners recover one original Run after input changes and database reopens`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationFixture(t, backend, { unmetered: true }),
        request = await setup(f),
        a = commands(f),
        b = commands(f);
      t.after(() => Promise.all([a.close(), b.close()]));
      const accepted = await a.generate(f.actor, request, f.signal()),
        before = ioCounts(f);
      await f.app.saveInput(f.actor, {
        ...f.command,
        mediaInputId: request.mediaInputId,
        expectedInputRevision: 1,
        prompt: "Manual revision after the original accepted generation",
        idempotencyKey: "manual-new-head",
      });
      const replay = await b.generate(f.actor, request, f.signal());
      assert.deepEqual(replay.binding, accepted.binding);
      assert.equal(replay.run.disposition, "replayed");
      assert.deepEqual(ioCounts(f), before);
      await a.close();
      await b.close();
      const next = await f.cold(),
        c = commands({ ...f, ...next });
      t.after(() => c.close());
      const cold = await c.generate(f.actor, request, f.signal());
      assert.deepEqual(cold.binding, accepted.binding);
      assert.equal(cold.run.disposition, "replayed");
      assert.deepEqual(ioCounts(f), before);
      assert.equal(
        (
          await next.app.loadInput(f.actor, {
            projectId: request.projectId,
            mediaInputId: request.mediaInputId,
            inputRevision: null,
          })
        )?.latestInputRevision,
        2,
      );
    },
  );

  test(
    `${backend}: changed original command cannot reuse an accepted receipt or start material I/O`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationFixture(t, backend, { unmetered: true }),
        request = await setup(f),
        owner = commands(f);
      t.after(() => owner.close());
      await owner.generate(f.actor, request, f.signal());
      const io = ioCounts(f),
        runs = await f.countRuns();
      for (const patch of [
        { executionId: "different-execution" },
        { inputRevision: 2 },
        { expectedInputRevision: 2 },
        { threadId: "different-thread" },
        { expectedThreadRevision: 2 },
        { projectId: "different-project" },
      ])
        await assert.rejects(
          owner.generate(f.actor, { ...request, ...patch }, f.signal()),
        );
      assert.deepEqual(ioCounts(f), io);
      assert.deepEqual(await f.countRuns(), runs);
    },
  );

  test(
    `${backend}: concurrent page and Agent requests converge on one execution and one material upload`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationFixture(t, backend, { unmetered: true }),
        request = await setup(f),
        page = commands(f),
        agent = commands(f);
      t.after(() => Promise.all([page.close(), agent.close()]));
      const uploads = f.state.uploads;
      const initial = await Promise.allSettled([
        page.generate(f.actor, request, f.signal()),
        agent.generate(f.actor, request, f.signal()),
      ]);
      const accepted = await page.generate(f.actor, request, f.signal());
      for (const result of initial) {
        if (result.status === "fulfilled")
          assert.deepEqual(result.value.binding, accepted.binding);
        else
          assert.match(
            String(result.reason),
            /project_media_generation_materials_unavailable/,
          );
      }
      assert.equal(f.state.uploads, uploads + 1);
      assert.equal((await f.countRuns()).project_media_generation_links, 1);
      assert.equal(
        (await agent.generate(f.actor, request, f.signal())).run.disposition,
        "replayed",
      );
    },
  );

  test(
    `${backend}: foreign admission and provider-field injection fail before material I/O`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationFixture(t, backend, { unmetered: true }),
        request = await setup(f),
        foreign = new ProjectMediaGenerationCommands({
          profileId: f.pin.profileId,
          preparer: f.issuer,
          tasks: f.service,
          extensions: f.ext,
          admissions: {
            resolve: async () => ({ ...f.pin, actorId: "another-actor" }),
          },
        });
      t.after(() => foreign.close());
      const io = ioCounts(f),
        runs = await f.countRuns();
      await assert.rejects(
        foreign.generate(f.actor, request, f.signal()),
        /project_media_generation_owner_mismatch/,
      );
      assert.throws(() =>
        foreign.generate(
          f.actor,
          {
            ...request,
            providerUrl: "https://untrusted.invalid",
          } as typeof request,
          f.signal(),
        ),
      );
      assert.deepEqual(ioCounts(f), io);
      assert.deepEqual(await f.countRuns(), runs);
    },
  );

  test(
    `${backend}: denied generation purpose stops before any source read, upload or Run`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationFixture(t, backend, { unmetered: true }),
        request = await setup(f),
        owner = commands(f);
      t.after(() => owner.close());
      const io = ioCounts(f),
        runs = await f.countRuns();
      f.generation.allowed = false;
      await assert.rejects(
        owner.generate(f.actor, request, f.signal()),
        /project_media_generation_denied/,
      );
      assert.deepEqual(ioCounts(f), io);
      assert.deepEqual(await f.countRuns(), runs);
    },
  );

  test(
    `${backend}: close waits for physical material I/O and prevents task acceptance`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationFixture(t, backend, { unmetered: true }),
        request = await setup(f),
        owner = commands(f),
        entered = deferred<void>(),
        release = deferred<void>();
      t.after(() => owner.close());
      f.state.onGet = async () => {
        entered.resolve();
        await release.promise;
      };
      const runs = await f.countRuns(),
        work = owner.generate(f.actor, request, f.signal());
      const failed = assert.rejects(work);
      await entered.promise;
      let closed = false;
      const closing = owner.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      assert.equal(closed, false);
      release.resolve();
      await failed;
      await closing;
      assert.deepEqual(await f.countRuns(), runs);
      assert.throws(
        () => owner.generate(f.actor, request, f.signal()),
        /project_media_generation_closed/,
      );
    },
  );
}
