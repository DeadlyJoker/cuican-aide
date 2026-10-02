import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "./application-error.ts";
import {
  pluginTaskFixture,
  taskActor,
  taskCommand,
  taskPin,
} from "./extension-plugin-task.test-support.ts";

test("plugin host commit authority runs after pricing and can refuse all writes", async () => {
  const fixture = pluginTaskFixture();
  let calls = 0;
  await assert.rejects(
    fixture.create().createTaskFromPlugin(taskActor, taskCommand, taskPin, {
      async assertCurrent(input) {
        assert.equal(fixture.state.quoteCalls, 1);
        assert.deepEqual(input.actor, taskActor);
        assert.deepEqual(input.pin, taskPin);
        calls++;
        throw new ApplicationError(
          "authorization",
          "fixture_plugin_epoch_changed",
        );
      },
    }),
    /fixture_plugin_epoch_changed/u,
  );
  assert.equal(calls, 1);
  assert.equal(fixture.state.commits.length, 0);
});

test("accepted plugin task replay preserves the original commit without a new admission callback", async () => {
  const fixture = pluginTaskFixture();
  let calls = 0;
  const authority = {
    async assertCurrent() {
      calls++;
    },
  };
  const first = await fixture
    .create()
    .createTaskFromPlugin(taskActor, taskCommand, taskPin, authority);
  const repeated = await fixture
    .create()
    .createTaskFromPlugin(taskActor, taskCommand, taskPin, {
      async assertCurrent() {
        throw new Error("must_not_admit_again");
      },
    });
  assert.equal(repeated.binding.runId, first.binding.runId);
  assert.equal(calls, 1);
  assert.equal(fixture.state.commits.length, 1);
  assert.equal(fixture.state.quoteCalls, 1);
});
