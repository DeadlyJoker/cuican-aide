import {
  ApplicationError,
  capturePluginHistoricalQueryInvocationCommitAuthority,
  type PluginUiActionContext,
} from "@crewon/application";
import {
  parsePluginPackageDescriptor,
  parsePluginUiLease,
} from "@crewon/contracts/plugins";
import { registerPluginHistoricalQueryInvocation } from "../../application/src/plugin-project-historical-query-invocation.ts";
import { projectHistoricalQueryTaskFixture } from "../../application/src/project-historical-query-task.test-support.ts";
import {
  PluginProjectHistoricalQueryActionBridge,
  type PluginProjectHistoricalQueryDispatchPort,
} from "./plugin-project-historical-query-action-bridge.ts";
/** Named private registration / Node borrow doubles; no formal Main or supplier is claimed. */
export async function projectHistoricalQueryBridgeFixture() {
  const app = await projectHistoricalQueryTaskFixture(),
    context: PluginUiActionContext = {
      ...app.context,
      lease: parsePluginUiLease({
        ...app.context.lease,
        descriptor: parsePluginPackageDescriptor({
          ...app.context.lease.descriptor,
          requires: [
            {
              service: "crewon.project-historical-queries",
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
  };
  const register = (next: PluginUiActionContext = context) =>
    registerPluginHistoricalQueryInvocation(
      next,
      async () => {
        state.currentCalls++;
        if (!state.allow)
          throw new ApplicationError(
            "authorization",
            "fixture_query_policy_denied",
          );
      },
      async () => {
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
  const accept = async (next: PluginUiActionContext = context) => {
    const invocation =
      capturePluginHistoricalQueryInvocationCommitAuthority(next);
    return {
      command: app.command,
      executionPin: app.executionPin,
      result:
        await app.tasks.createHistoricalPublishedProjectQueryTaskFromPlugin({
          ...app.input,
          sourcePin: invocation.sourcePin,
          authority: {
            invocation,
            assertCurrent: () => invocation.assertCurrent(),
            assertTransactionCurrent: () =>
              invocation.assertTransactionCurrent(),
            assertActive: () => invocation.assertActive(),
          },
        }),
    };
  };
  const queries: PluginProjectHistoricalQueryDispatchPort = {
    async query(input) {
      state.calls++;
      await state.beforeQuery?.();
      await input.authority.assertCurrent();
      const result = await accept(input.context);
      state.afterCommit?.();
      return { publication: app.publication, ...result };
    },
    isAvailable: () => state.available,
  };
  const bridge = new PluginProjectHistoricalQueryActionBridge({
      publications: [app.publication],
      generation: queries,
      committedTasks: app.committed,
    }),
    fallback = {
      async invoke(c: PluginUiActionContext) {
        return c.input;
      },
    },
    actions = bridge.actions(fallback);
  const invoke = async (next = context) => {
    const dispose = register(next);
    try {
      return await actions.invoke(next);
    } finally {
      dispose();
    }
  };
  return {
    app: { ...app, accept },
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
