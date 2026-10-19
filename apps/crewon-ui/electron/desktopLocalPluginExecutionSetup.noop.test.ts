import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { executionSetupFixture } from "./desktopLocalPluginExecutionSetup.test-support.ts";
import { runDesktopLocalPluginExecutionSetup } from "./desktopLocalPluginExecutionSetup.ts";
import { runRuntimeStoppedMutation } from "./runtimeStoppedMutation.ts";
import { SHORT_WORKFLOW_PANEL_NETWORK_PATHS } from "./desktopLocalPluginExecutionSetupSnapshot.ts";

const fixtures: Awaited<ReturnType<typeof executionSetupFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});

async function fixture() {
  const f = await executionSetupFixture({
    version: "50.2.12",
    serviceProtocol: "workflow-api-v1",
    preset: "api-c16-scene",
  });
  fixtures.push(f);
  return f;
}
async function prepare(
  f: Awaited<ReturnType<typeof fixture>>,
  options: Readonly<{
    failAfterFirstRestart?: boolean;
    revokeBeforeReuse?: boolean;
  }> = {},
) {
  const owner = f.create();
  const preview = await owner.preview({
    bootstrap: f.bootstrap,
    pluginId: f.identity.pluginId,
  });
  const claim = owner.claimPreview({
    previewId: preview.previewId,
    approveExecution: true,
  });
  const events: string[] = [];
  let starts = 0;
  const executingOwner = options.revokeBeforeReuse
    ? {
        ...owner,
        reuseProjectMappingWhileRunning: (
          ...args: Parameters<typeof owner.reuseProjectMappingWhileRunning>
        ) => {
          f.withdrawRuntime();
          return owner.reuseProjectMappingWhileRunning(...args);
        },
      }
    : owner;
  const result = await runDesktopLocalPluginExecutionSetup(
    { owner: executingOwner, claim, onStopInvalidation: (stop) => stop() },
    {
      mutateWhileStopped: (mutation) =>
        runRuntimeStoppedMutation(mutation, {
          async stop() {
            events.push("stop");
            await f.stop();
          },
          async start() {
            events.push("start");
            if (++starts > 1 && options.failAfterFirstRestart)
              throw new Error("second_restart_forbidden");
            await f.start();
          },
          assertReady() {
            events.push("ready");
          },
        }),
      preparedRuntime() {
        events.push("capture");
        const runtime = f.fakePreparedRuntime();
        return runtime;
      },
    },
  );
  return { result, events };
}

it("upgrades an old query grant with one restart when the exact project mapping is already current", async () => {
  const f = await fixture();
  const initial = await prepare(f);
  expect(initial.result.state).toBe("prepared");
  expect(initial.events.filter((event) => event === "start")).toHaveLength(2);
  const approval = readFileSync(f.approvalPath);
  const old = JSON.parse(readFileSync(f.policyPath, "utf8"));
  old.networkGrants[0].paths = [
    { method: "POST", path: "/api/workflow/generate" },
    { method: "GET", path: "/api/comfy/proxy/queue" },
    { method: "GET", path: "/api/comfy/proxy/history" },
    { method: "GET", path: "/api/comfy/view" },
  ];
  writeFileSync(f.policyPath, JSON.stringify(old), { mode: 0o600 });
  await f.stop();
  await f.start();
  const upgraded = await prepare(f, { failAfterFirstRestart: true });
  expect(upgraded.result.state).toBe("prepared");
  expect(upgraded.events).toEqual(["stop", "start", "ready", "capture"]);
  expect(readFileSync(f.approvalPath)).toEqual(approval);
  expect(
    JSON.parse(readFileSync(f.policyPath, "utf8")).networkGrants[0].paths,
  ).toEqual(SHORT_WORKFLOW_PANEL_NETWORK_PATHS);
});

it("does not report an unchanged mapping prepared after the live runtime is withdrawn", async () => {
  const f = await fixture();
  await prepare(f);
  await expect(prepare(f, { revokeBeforeReuse: true })).rejects.toThrow(
    "withdrawn",
  );
});
