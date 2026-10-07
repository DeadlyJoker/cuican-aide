import assert from "node:assert/strict";
import test from "node:test";
import { mediaResultFixture } from "./project-media-result-publisher.test-support.ts";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: exact output approval is checked before DNS, before GET and before freezing; frozen replay needs no network grant`,
    assetTestOptions(backend),
    async (t) => {
      let allowed = false,
        approvals = 0;
      const f = await mediaResultFixture(t, backend, "T10", {
        outputApproval: {
          assertCurrent: async ({ actor, source, signal }) => {
            approvals++;
            assert.deepEqual(actor, f.actor);
            assert.deepEqual(source.request.query, f.query);
            signal.throwIfAborted();
            if (!allowed) throw new Error("named_output_not_approved");
          },
        },
      });
      const publish = () =>
        f.publisher.publish(f.actor, f.query, {
          signal: new AbortController().signal,
        });
      await assert.rejects(publish(), /named_output_not_approved/u);
      assert.equal(f.state.dns, 0);
      allowed = true;
      f.state.onDns = async () => {
        allowed = false;
      };
      await assert.rejects(publish(), /named_output_not_approved/u);
      assert.equal(f.state.gets, 0);
      f.state.onDns = undefined;
      allowed = true;
      f.state.onGet = async () => {
        allowed = false;
      };
      await assert.rejects(publish(), /named_output_not_approved/u);
      assert.equal(f.state.gets, 1);
      assert.equal(await f.count(), 0);
      assert.equal(await f.archive.load(f.request), null);
      allowed = true;
      f.state.onGet = undefined;
      const saved = await publish(),
        before = approvals;
      allowed = false;
      assert.deepEqual((await publish()).candidate, saved.candidate);
      assert.ok(
        await f.publisher.readCandidate(f.actor, f.query, {
          signal: new AbortController().signal,
        }),
      );
      assert.equal(approvals, before);
      assert.equal(f.state.gets, 2);
      assert.equal(await f.count(), 1);
    },
  );
}
