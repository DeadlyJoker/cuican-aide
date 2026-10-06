import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync } from "node:fs";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { ProjectMaterialPreparer } from "./project-material-preparer.ts";
import {
  projectMaterialPreparerFixture as fixture,
  materialSignal as signal,
} from "./project-material-preparer.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend} preparation revoked during DNS sends no POST and keeps the original reservation`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      f.state.onDns = async () => {
        f.state.uploadAllowed = false;
      };
      await assert.rejects(
        f.preparer.prepareSelectedReference(f.actor, f.input, signal()),
        /preparation_denied/u,
      );
      assert.equal(f.state.uploads, 0);
      assert.deepEqual(await f.headPhases(), ["reserved"]);
      const original = await f.journal.load(f.request, f.authority());
      f.state.uploadAllowed = true;
      f.state.onDns = undefined;
      const next = await f.preparer.prepareSelectedReference(
        f.actor,
        f.input,
        signal(),
      );
      assert.equal(next.disposition, "verified");
      assert.deepEqual(next.state.initial, original!.initial);
      assert.equal(f.state.uploads, 1);
      assert.equal(f.state.sourceGets, 1);
    },
  );
  test(
    `${backend} revoked observation after provider GET cannot commit verified or trigger another upload`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      f.state.onGet = async () => {
        f.state.observeAllowed = false;
      };
      await assert.rejects(
        f.preparer.prepareSelectedReference(f.actor, f.input, signal()),
        /preparation_denied/u,
      );
      assert.equal(f.state.uploads, 1);
      assert.equal(f.state.targetGets, 1);
      assert.deepEqual(await f.headPhases(), ["dispatching"]);
      f.state.observeAllowed = true;
      f.state.onGet = undefined;
      const next = await f.preparer.observePreparedReference(
        f.actor,
        f.input,
        signal(),
      );
      assert.equal(next.disposition, "verified");
      assert.equal(f.state.uploads, 1);
      assert.equal(f.state.sourceGets, 1);
    },
  );
  test(
    `${backend} cancellation before preparation is empty; cancellation after supplier acceptance preserves query-only intent`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        aborted = new AbortController();
      aborted.abort();
      await assert.rejects(
        f.preparer.prepareSelectedReference(f.actor, f.input, {
          signal: aborted.signal,
        }),
      );
      assert.equal(readdirSync(f.root).length, 0);
      assert.equal(f.state.sourceGets, 0);
      assert.equal(f.state.uploads, 0);
      const duringPost = new AbortController();
      f.state.onPost = async () => {
        duringPost.abort();
      };
      await assert.rejects(
        f.preparer.prepareSelectedReference(f.actor, f.input, {
          signal: duringPost.signal,
        }),
      );
      assert.deepEqual(await f.headPhases(), ["dispatching"]);
      assert.equal(f.state.uploads, 1);
      f.state.onPost = undefined;
      assert.equal(
        (await f.preparer.observePreparedReference(f.actor, f.input, signal()))
          .disposition,
        "verified",
      );
      assert.equal(f.state.uploads, 1);
      assert.equal(f.state.sourceGets, 1);
    },
  );
  test(
    `${backend} malformed upload acknowledgement and failed original-path query remain pending with no resend`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      f.state.reply = (expected) => ({
        ...expected,
        body: Buffer.from("not-json"),
      });
      const first = await f.preparer.prepareSelectedReference(
        f.actor,
        f.input,
        signal(),
      );
      assert.equal(first.disposition, "pending");
      assert.equal(first.state.event.phase, "unknownOutcome");
      const network = new ProjectMaterialPreparer({
        ...f.dependencies,
        dns: {
          resolveAll: async () => {
            throw Object.assign(
              new Error("queryA ESERVFAIL named supplier lookup"),
              { code: "ESERVFAIL" },
            );
          },
        },
      });
      const pending = await network.observePreparedReference(
        f.actor,
        f.input,
        signal(),
      );
      assert.equal(pending.disposition, "pending");
      assert.deepEqual(pending.state, first.state);
      assert.equal(f.state.uploads, 1);
      assert.equal(f.state.targetGets, 0);
      f.state.files.clear();
      const missing = await f.preparer.prepareSelectedReference(
        f.actor,
        f.input,
        signal(),
      );
      assert.equal(missing.disposition, "pending");
      assert.deepEqual(missing.state, first.state);
      assert.equal(f.state.uploads, 1);
      assert.equal(f.state.sourceGets, 1);
    },
  );
  test(
    `${backend} failed host clock after exact GET is not misclassified as target corruption`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      let invalidClock = false;
      const preparer = new ProjectMaterialPreparer({
        ...f.dependencies,
        clock: {
          now: () => (invalidClock ? "invalid" : f.dependencies.clock.now()),
        },
      });
      f.state.onGet = async () => {
        invalidClock = true;
      };
      await assert.rejects(
        preparer.prepareSelectedReference(f.actor, f.input, signal()),
      );
      assert.deepEqual(await f.headPhases(), ["dispatching"]);
      assert.equal(f.state.uploads, 1);
      f.state.onGet = undefined;
      assert.equal(
        (await f.preparer.observePreparedReference(f.actor, f.input, signal()))
          .disposition,
        "verified",
      );
      assert.equal(f.state.uploads, 1);
    },
  );
  test(
    `${backend} async activity callback and absent preparation authorization never grant transfer`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        invalid = new ProjectMaterialPreparer({
          ...f.dependencies,
          authorization: { ...f.authorization, assertActive: async () => {} },
        });
      await assert.rejects(
        invalid.prepareSelectedReference(f.actor, f.input, signal()),
        /authority_invalid/u,
      );
      assert.throws(
        () =>
          new ProjectMaterialPreparer({
            ...f.dependencies,
            authorization: {} as never,
          }),
        /dependency_invalid/u,
      );
      assert.equal(f.state.sourceGets, 0);
      assert.equal(f.state.uploads, 0);
      assert.equal(f.state.targetGets, 0);
    },
  );
  test(
    `${backend} actor/project selectors cannot borrow another owner's preparation or input bytes`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      await f.preparer.prepareSelectedReference(f.actor, f.input, signal());
      await assert.rejects(
        f.preparer.prepareSelectedReference(
          { ...f.actor, principalId: "other-owner" },
          f.input,
          signal(),
        ),
      );
      await assert.rejects(
        f.preparer.prepareSelectedReference(
          f.actor,
          {
            ...f.input,
            source: {
              ...f.input.source,
              query: { ...f.input.source.query, assetId: "another-asset" },
            },
          },
          signal(),
        ),
        /idempotency_conflict/u,
      );
      assert.equal(f.state.sourceGets, 1);
      assert.equal(f.state.uploads, 1);
      assert.equal(f.state.targetGets, 1);
    },
  );
}
