import test from "node:test";
import assert from "node:assert/strict";
import { projectModelSelectionFixture as fixture } from "./project-model-selection.test-support.ts";
import { target as originalTarget } from "../../store/src/extension-store.test-support.ts";
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: selected project model creates one original Run and cold replay never resolves or replaces its model`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const result = await f.app.startProjectTurn(
        f.actor,
        f.input,
        f.authority,
      );
      assert.deepEqual(result.result.binding.target, f.modelTarget);
      assert.equal(result.result.turn.messages[0]!.content, f.input.content);
      assert.equal(
        result.result.turn.threadState.workspaceId,
        "original-project-workspace",
      );
      assert.equal(
        result.result.turn.runState.agentVersionId,
        f.modelTarget.agentVersionId,
      );
      assert.equal(f.model.preparations, 1);
      const activation = await f.first.store.loadExtensionActivation(
        result.result.binding,
      );
      assert.deepEqual(activation!.target, originalTarget);
      f.model.live = false;
      const replay = await f
        .create({ unavailable: true })
        .startProjectTurn(f.actor, f.input, f.authority);
      assert.equal(replay.result.run.disposition, "replayed");
      assert.deepEqual(replay.result.binding, result.result.binding);
      assert.equal(f.model.preparations, 1);
      await assert.rejects(
        f
          .create({ unavailable: true })
          .startProjectTurn(
            f.actor,
            { ...f.input, modelId: "gpt-5.6-luna" },
            f.authority,
          ),
      );
      assert.equal(
        (await f.parent.loadThreadInSpace({
          ...f.actor,
          threadId: f.input.threadId,
        }))!.revision,
        2,
      );
    },
  );
  for (const failure of [
    "copyGrant",
    "omitGrant",
    "withdraw",
    "invalidOptionPrototype",
    "symbolOption",
  ] as const)
    test(
      `${backend}: ${failure} cannot admit an alternate project model or leave a partial Turn`,
      options,
      async (t) => {
        const f = await fixture(t, backend);
        if (failure === "withdraw")
          f.state.beforeTransaction = () => {
            f.model.live = false;
          };
        const app =
          failure === "withdraw" ? f.app : f.create({ [failure]: true });
        await assert.rejects(
          app.startProjectTurn(f.actor, f.input, f.authority),
        );
        assert.equal(
          (await f.parent.loadThreadInSpace({
            ...f.actor,
            threadId: f.input.threadId,
          }))!.revision,
          1,
        );
        const { modelId: _model, ...legacy } = f.input;
        const result = await f
          .create({ unavailable: true })
          .startProjectTurn(f.actor, legacy, f.authority);
        assert.deepEqual(result.result.binding.target, originalTarget);
      },
    );
}
