import assert from "node:assert/strict";
import test from "node:test";
import { foundationToolsOwnerFixture } from "../../../apps/runtime-worker/src/plugins/project-foundation-tools-service-owner.test-support.ts";
import {
  issuePluginProjectRuntimeObservation,
  qualifyPluginProjectRuntimeObservation,
  type PluginProjectRuntimeObservationAuthority,
} from "./plugin-project-runtime-observation.ts";
import { qualifyPluginProjectReadScope } from "./plugin-project-read-scope.ts";
test("runtime metadata observation captures original admitted identity, rejects copied tokens and never becomes Tool read scope", async (t) => {
  const f = await foundationToolsOwnerFixture(t, "novel");
  let live = true,
    allowed = true,
    checks = 0;
  const input: PluginProjectRuntimeObservationAuthority = {
    version: "crewon.plugin-project-runtime-observation.v1",
    actor: f.actor,
    admission: f.taskAdmission,
    binding: f.binding,
    stage: f.stage,
    purpose: "submit",
    async assertCurrent() {
      checks++;
      assert.ok(allowed, "named-runtime-pdp-denied");
    },
    assertActive() {
      assert.ok(live, "named-runtime-ended");
    },
  };
  const token = await issuePluginProjectRuntimeObservation(input);
  assert.equal(checks, 1);
  assert.ok(Object.isFrozen(token));
  assert.deepEqual(Object.keys(token), []);
  const source = qualifyPluginProjectRuntimeObservation(token);
  assert.equal(source.owner.pluginId, f.taskAdmission.pluginId);
  assert.equal(source.owner.profileId, f.taskAdmission.profileId);
  assert.equal(source.stage.projectId, f.admission.projectId);
  assert.notEqual(source.binding, input.binding);
  assert.ok(Object.isFrozen(source.binding));
  assert.throws(() => qualifyPluginProjectRuntimeObservation({ ...token }));
  assert.throws(() => qualifyPluginProjectReadScope(token as never));
  await assert.rejects(
    issuePluginProjectRuntimeObservation({
      ...input,
      binding: { ...input.binding, source: { runId: "foreign" } },
    } as never),
  );
  await assert.rejects(
    issuePluginProjectRuntimeObservation({
      ...input,
      actor: { ...input.actor, principalId: "foreign" },
    }),
  );
  let getter = 0;
  await assert.rejects(
    issuePluginProjectRuntimeObservation({
      ...input,
      get actor() {
        getter++;
        return input.actor;
      },
    }),
  );
  assert.equal(getter, 0);
  allowed = false;
  await assert.rejects(source.assertCurrent(), /named-runtime-pdp-denied/u);
  await assert.rejects(
    issuePluginProjectRuntimeObservation(input),
    /named-runtime-pdp-denied/u,
  );
  allowed = true;
  live = false;
  assert.throws(
    () => qualifyPluginProjectRuntimeObservation(token),
    /named-runtime-ended/u,
  );
});
