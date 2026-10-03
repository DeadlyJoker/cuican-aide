import {
  ApplicationError,
  type PluginUiActionContext,
} from "@crewon/application";
import { registerPluginUiInvocation } from "../../application/src/plugin-ui-invocation-authority.ts";
import { committedProjectGenerationFixture } from "../../application/src/plugin-ui-committed-project-generation.test-support.ts";
import {
  PluginProjectGenerationActionBridge,
  type PluginProjectGenerationDispatchPort,
} from "./plugin-project-generation-action-bridge.ts";

/** Real Application receipt verification over explicit in-memory stores; this is not SQL/production admission evidence. */
export function projectGenerationBridgeFixture() {
  const app = committedProjectGenerationFixture();
  const state = {
    open: true,
    allow: true,
    available: true,
    currentCalls: 0,
    generationCalls: 0,
    availabilityCalls: 0,
    beforeGenerate: null as (() => Promise<void>) | null,
    afterCommit: null as (() => void) | null,
    lastInput: null as
      | Parameters<PluginProjectGenerationDispatchPort["generate"]>[0]
      | null,
  };
  const generation: PluginProjectGenerationDispatchPort = {
    async generate(input) {
      state.generationCalls++;
      state.lastInput = input;
      await state.beforeGenerate?.();
      await input.authority.assertCurrent();
      const accepted = await app.accept(input.context);
      state.afterCommit?.();
      return {
        command: accepted.command,
        executionPin: accepted.executionPin,
        result: accepted.result,
      };
    },
    isAvailable() {
      state.availabilityCalls++;
      return state.available;
    },
  };
  const bridge = new PluginProjectGenerationActionBridge({
    publications: [app.publication],
    generation,
    committedTasks: app.authority,
  });
  const fallback = {
    async invoke() {
      return { ordinary: true };
    },
  };
  const actions = bridge.actions(fallback);
  const register = (context: PluginUiActionContext) =>
    registerPluginUiInvocation(
      context,
      async () => {
        state.currentCalls++;
        if (!state.allow)
          throw new ApplicationError(
            "authorization",
            "plugin_ui_authorization_denied",
          );
      },
      () => {
        if (!state.open)
          throw new ApplicationError(
            "authorization",
            "fixture_invocation_closed",
          );
      },
    );
  async function invoke(
    context: PluginUiActionContext = app.detachedContext(),
  ) {
    const dispose = register(context);
    try {
      return await actions.invoke(context);
    } finally {
      dispose();
    }
  }
  return {
    app,
    state,
    generation,
    bridge,
    actions,
    register,
    invoke,
    fallback,
  };
}

export function bridgeDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
