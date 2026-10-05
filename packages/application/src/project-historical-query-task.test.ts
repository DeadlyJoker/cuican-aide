import assert from "node:assert/strict";
import { test } from "node:test";
import { projectHistoricalQueryTaskFixture } from "./project-historical-query-task.test-support.ts";
import {
  capturePluginHistoricalQueryInvocationCommitAuthority,
  assertPluginHistoricalQueryInvocationAuthority,
} from "./plugin-project-historical-query-invocation.ts";
import {
  isPluginUiCommittedProjectHistoricalQueryAuthority,
  isPluginUiCommittedProjectQueryAuthority,
} from "./plugin-ui-committed-task-authority.ts";
async function invoke(
  f: Awaited<ReturnType<typeof projectHistoricalQueryTaskFixture>>,
  after?: Parameters<typeof f.createUi>[0],
) {
  const ui = f.createUi(after),
    lease = await ui.openMount(f.input.actor, f.business.openCommand);
  return ui.invoke(f.input.actor, {
    mountRef: lease.mountRef,
    action: f.context.action,
    input: f.request,
  });
}
test("actual mounted new namespace admits query-only and original-key receipt without quote or new operation", async () => {
  const f = await projectHistoricalQueryTaskFixture(),
    before = {
      quotes: f.saved.f.base.state.quoteCalls,
      admissions: f.saved.f.base.state.admissions.size,
      sources: f.saved.f.state.links.size,
    };
  const first = (await invoke(f)) as { runId: string };
  assert.notEqual(first.runId, f.generated.binding.runId);
  assert.equal(
    f.state.links.get(first.runId)?.sourcePin.action,
    f.context.action,
  );
  assert.equal(f.state.links.get(first.runId)?.executionPin.version, "0.1.0");
  const commits = f.saved.f.base.state.commits.length;
  const replay = (await invoke(f)) as { runId: string };
  assert.equal(replay.runId, first.runId);
  assert.equal(f.saved.f.base.state.commits.length, commits);
  assert.deepEqual(
    {
      quotes: f.saved.f.base.state.quoteCalls,
      admissions: f.saved.f.base.state.admissions.size,
      sources: f.saved.f.state.links.size,
    },
    before,
  );
  assert.ok(
    isPluginUiCommittedProjectHistoricalQueryAuthority({
      authority: f.committed,
      publications: [f.publication],
    }),
  );
  assert.equal(
    isPluginUiCommittedProjectQueryAuthority({
      authority: f.committed,
      publications: [],
    }),
    false,
  );
});
test("plain context/old public authority/copy cannot produce new invocation qualification", async () => {
  const f = await projectHistoricalQueryTaskFixture();
  assert.throws(
    () => capturePluginHistoricalQueryInvocationCommitAuthority(f.context),
    /project_historical_query_invocation_unavailable/u,
  );
  await assert.rejects(
    f.tasks.createHistoricalPublishedProjectQueryTaskFromPlugin({
      ...f.input,
      authority: { ...f.authority, invocation: {} as never },
    }),
    /project_historical_query_invocation_unavailable/u,
  );
  assert.equal(f.state.links.size, 0);
});
test("confirmed commit retains original receipt after mount withdrawal and issuer cannot be used as execution grant", async () => {
  const f = await projectHistoricalQueryTaskFixture();
  let captured:
    | ReturnType<typeof capturePluginHistoricalQueryInvocationCommitAuthority>
    | undefined;
  const result = (await invoke(f, async (context, _result, ui) => {
    captured = capturePluginHistoricalQueryInvocationCommitAuthority(context);
    await ui.closeMount(f.input.actor, { mountRef: context.lease.mountRef });
    f.business.state.allow = false;
    f.state.alive = false;
  })) as { runId: string };
  assert.ok(f.state.links.has(result.runId));
  assert.ok(captured);
  assert.throws(
    () => assertPluginHistoricalQueryInvocationAuthority(captured!),
    /project_historical_query_invocation_unavailable|plugin_ui_mount/u,
  );
});
test("missing original operation refuses before any query Turn", async () => {
  const f = await projectHistoricalQueryTaskFixture();
  f.state.operation = null;
  const commits = f.saved.f.base.state.commits.length;
  await assert.rejects(invoke(f));
  assert.equal(f.saved.f.base.state.commits.length, commits);
  assert.equal(f.state.links.size, 0);
});

test("server resolver selects unique original full target and rechecks operation without accepting client target", async () => {
  const f = await projectHistoricalQueryTaskFixture();
  const { prepareProjectHistoricalQueryResolver } = await import(
    "./project-historical-query-resolver.ts"
  );
  const wrong = {
    ...f.publication,
    target: {
      ...f.publication.target,
      version: "9.0.0",
      packageDigest: `sha256:${"e".repeat(64)}`,
    },
  };
  const capturedDependencies = { ...f.dependencies };
  const resolver = prepareProjectHistoricalQueryResolver(capturedDependencies, [
    wrong,
    f.publication,
  ]);
  capturedDependencies.authorization = {
    authorize: async () => ({ outcome: "deny", reasonCode: "replaced_port" }),
  };
  const ui = f.createUi(undefined, async (context, authority) => {
    const resolved = await resolver.resolve({
      context,
      authority,
      request: f.request,
    });
    assert.deepEqual(resolved.publication, f.publication);
    assert.deepEqual(resolved.command(f.executionPin), f.command);
    await resolved.assertCurrent();
    const operation = f.state.operation;
    f.state.operation = null;
    await assert.rejects(resolved.assertCurrent());
    f.state.operation = operation;
    await assert.rejects(
      prepareProjectHistoricalQueryResolver(f.dependencies, [wrong]).resolve({
        context,
        authority,
        request: f.request,
      }),
      /project_historical_query_target_unapproved/u,
    );
    await assert.rejects(
      resolver.resolve({
        context,
        authority,
        request: { ...f.request, target: f.publication.target } as never,
      }),
    );
  });
  const lease = await ui.openMount(f.input.actor, f.business.openCommand);
  await ui.invoke(f.input.actor, {
    mountRef: lease.mountRef,
    action: f.context.action,
    input: f.request,
  });
  assert.equal(f.state.links.size, 1);
});
