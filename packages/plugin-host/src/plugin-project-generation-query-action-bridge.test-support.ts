import {
  ApplicationError,
  type PluginUiActionContext,
} from "@crewon/application";
import {
  parsePluginPackageDescriptor,
  parsePluginUiLease,
} from "@crewon/contracts/plugins";
import { registerPluginUiInvocation } from "../../application/src/plugin-ui-invocation-authority.ts";
import { projectQueryTaskFixture } from "../../application/src/project-query-task.test-support.ts";
import {
  PluginProjectGenerationQueryActionBridge,
  type PluginProjectGenerationQueryDispatchPort,
} from "./plugin-project-generation-query-action-bridge.ts";

/** Real Application query/receipt services over memory ports, not SQL or supplier evidence. */
export async function projectGenerationQueryBridgeFixture() {
  const app = await projectQueryTaskFixture();
  const context: PluginUiActionContext = {
    ...app.context,
    lease: parsePluginUiLease({
      ...app.context.lease,
      descriptor: parsePluginPackageDescriptor({
        ...app.context.lease.descriptor,
        requires: [
          {
            service: "crewon.project-generation-queries",
            apiVersion: "1",
            optional: false,
          },
        ],
      }),
    }),
  };
  const state = {
    open: true,
    allow: true,
    available: true,
    calls: 0,
    currentCalls: 0,
    beforeQuery: null as (() => Promise<void>) | null,
    afterCommit: null as (() => void) | null,
    lastInput: null as
      | Parameters<PluginProjectGenerationQueryDispatchPort["query"]>[0]
      | null,
  };
  const queries: PluginProjectGenerationQueryDispatchPort = {
    async query(input) {
      state.calls++;
      state.lastInput = input;
      await state.beforeQuery?.();
      await input.authority.assertCurrent();
      const result = await app.accept();
      state.afterCommit?.();
      return {
        command: result.command,
        executionPin: result.executionPin,
        result: result.result,
      };
    },
    isAvailable: () => state.available,
  };
  const bridge = new PluginProjectGenerationQueryActionBridge({
    publications: [app.publication],
    generation: queries,
    committedTasks: app.committed,
  });
  const fallback = {
    async invoke(input: PluginUiActionContext) {
      return input.input;
    },
  };
  const actions = bridge.actions(fallback);
  const register = (next: PluginUiActionContext = context) =>
    registerPluginUiInvocation(
      next,
      async () => {
        state.currentCalls++;
        if (!state.allow)
          throw new ApplicationError(
            "authorization",
            "fixture_query_policy_denied",
          );
      },
      () => {
        if (!state.open)
          throw new ApplicationError(
            "authorization",
            "fixture_query_invocation_closed",
          );
      },
    );
  const invoke = async (next = context) => {
    const dispose = register(next);
    try {
      return await actions.invoke(next);
    } finally {
      dispose();
    }
  };
  return {
    app,
    context,
    state,
    queries,
    bridge,
    actions,
    register,
    invoke,
    fallback,
  };
}
