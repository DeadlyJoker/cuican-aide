import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspect } from "node:util";
import { nativeMediaFlowFixture } from "./desktop-native-project-media-flow.test-support.ts";

type Fixture = Awaited<ReturnType<typeof nativeMediaFlowFixture>>;
const options = { skip: process.platform === "win32", timeout: 180_000 };
function counts(f: Fixture) {
  const db = new DatabaseSync(f.databasePath, { readOnly: true });
  try {
    return [
      "run_snapshots",
      "work_items",
      "project_media_generation_links",
    ].map((table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
  } finally {
    db.close();
  }
}
for (const kind of ["T10", "D18"] as const)
  test(
    `Native ${kind}: adopted Comfy references prepare through original policies and commit one media Run in the existing project conversation`,
    options,
    async (t) => {
      const f = await nativeMediaFlowFixture(t, { kind });
      const accepted = await f.post();
      assert.equal(accepted.statusCode, 200, inspect(f.routeState.errors));
      const result = accepted.json();
      assert.equal(result.disposition, "committed");
      assert.equal(result.threadId, f.binding.threadId);
      assert.notEqual(result.runId, f.sourceRunId);
      assert.equal(f.provider.state.uploads, kind === "T10" ? 1 : 3);
      assert.deepEqual(counts(f), [2, 2, 1]);
      const before = { ...f.provider.state };
      const replay = await f.post();
      assert.equal(replay.statusCode, 200, replay.body);
      assert.deepEqual(replay.json(), { ...result, disposition: "replayed" });
      assert.deepEqual(f.provider.state, before);
      const changed = await f.post({
        body: { ...f.body, executionId: "another-intent-with-the-same-key" },
      });
      assert.equal(changed.statusCode, 409, changed.body);
      assert.deepEqual(f.provider.state, before);
      assert.deepEqual(counts(f), [2, 2, 1]);
      const thread = await f.parent.loadThreadInSpace({
        ...f.actor,
        threadId: f.binding.threadId,
      });
      assert.equal(thread!.workspaceId, "native-existing-workspace");
      const admission = await f.parent
        .extensionStore()
        .loadPluginTaskUnmeteredAdmission({
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          runId: result.runId,
        });
      assert.equal(
        admission!.authorization.authorityId,
        f.nativeControl.authority.authorityId,
      );
      await f.app.close();
      await f.runtime.close();
      const next = await f.reopen();
      const cold = await next.app.inject({
        method: "POST",
        url: `/api/v1/creative-projects/${f.query.projectId}/media-generations`,
        headers: {
          ...next.headers,
          "idempotency-key": "native-original-media-generation",
        },
        payload: f.body,
      });
      assert.equal(cold.statusCode, 200, cold.body);
      assert.deepEqual(cold.json(), { ...result, disposition: "replayed" });
      assert.deepEqual(f.provider.state, before);
      assert.deepEqual(counts(f), [2, 2, 1]);
    },
  );

for (const mediaTransportGrant of ["none", "read"] as const)
  test(
    `Native ${mediaTransportGrant} transport grant cannot upload or accept a Run from an otherwise valid adopted input`,
    options,
    async (t) => {
      const f = await nativeMediaFlowFixture(t, { mediaTransportGrant });
      const before = counts(f);
      const result = await f.post();
      assert.equal(result.statusCode, 403, inspect(f.routeState.errors));
      assert.equal(
        f.provider.state.sourceGets,
        mediaTransportGrant === "none" ? 0 : 1,
      );
      assert.equal(f.provider.state.uploads, 0);
      assert.equal(f.routeState.wakes, 0);
      assert.deepEqual(counts(f), before);
    },
  );

test(
  "Native authority withdrawal during the real material upload prevents later observation and original Run admission",
  options,
  async (t) => {
    const f = await nativeMediaFlowFixture(t);
    const before = counts(f);
    f.provider.state.onUpload = async () => {
      await writeFile(join(dirname(f.authorityPath), "withdrawn.json"), "{}", {
        mode: 0o600,
      });
    };
    const result = await f.post();
    assert.equal(result.statusCode, 403, inspect(f.routeState.errors));
    assert.equal(f.provider.state.uploads, 1);
    assert.equal(f.provider.state.targetGets, 0);
    assert.equal(f.routeState.wakes, 0);
    assert.deepEqual(counts(f), before);
  },
);
