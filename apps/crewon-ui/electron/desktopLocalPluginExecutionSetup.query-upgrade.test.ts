import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { prepareDesktopPluginBootstrap } from "./desktopPluginBootstrap.ts";
import {
  executionSetupFixture,
  fixtureHash,
} from "./desktopLocalPluginExecutionSetup.test-support.ts";
import { SHORT_WORKFLOW_PANEL_NETWORK_PATHS } from "./desktopLocalPluginExecutionSetupSnapshot.ts";
import { DESKTOP_RUNTIME_OWNER as actor } from "./desktopExtensionRuntime.ts";
const fixtures: Awaited<ReturnType<typeof executionSetupFixture>>[] = [];
it.each(["other-origin", "extra-route", "per-action"])(
  "refuses conflicting legacy panel grant %s without changing its policy",
  async (conflict) => {
    const f = await fixture({
      version: "50.2.12",
      serviceProtocol: "workflow-api-v1",
      preset: "api-c16-scene",
    });
    const { owner, claim } = await previewClaim(f);
    await owner.commitPolicyWhileStopped(claim);
    const saved = JSON.parse(readFileSync(f.policyPath, "utf8"));
    saved.networkGrants[0].paths = [
      { method: "POST", path: "/api/workflow/generate" },
      { method: "GET", path: "/api/comfy/proxy/queue" },
      { method: "GET", path: "/api/comfy/proxy/history" },
      { method: "GET", path: "/api/comfy/view" },
    ];
    if (conflict === "other-origin")
      saved.networkGrants[0].baseUrl = "https://foreign.example/";
    else if (conflict === "extra-route")
      saved.networkGrants[0].paths.push({ method: "GET", path: "/all" });
    else saved.packages[0].approvalRequirement = "perAction";
    writeFileSync(f.policyPath, JSON.stringify(saved), { mode: 0o600 });
    const before = readFileSync(f.policyPath, "utf8");
    const bootstrap = (await prepareDesktopPluginBootstrap({
      dataDirectory: f.dataDirectory,
      actor,
      sessionEntropy: fixtureHash("query-upgrade-conflict"),
    }))!;
    try {
      await expect(
        f.create().preview({ bootstrap, pluginId: f.identity.pluginId }),
      ).rejects.toThrow("policy_conflict");
      expect(readFileSync(f.policyPath, "utf8")).toBe(before);
    } finally {
      await bootstrap.cleanup();
    }
  },
);
async function fixture(options?: Parameters<typeof executionSetupFixture>[0]) {
  const f = await executionSetupFixture(options);
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});
async function previewClaim(
  f: Awaited<ReturnType<typeof executionSetupFixture>>,
) {
  const owner = f.create();
  const preview = await owner.preview({
    bootstrap: f.bootstrap,
    pluginId: f.identity.pluginId,
  });
  return {
    owner,
    claim: owner.claimPreview({
      previewId: preview.previewId,
      approveExecution: true,
    }),
  };
}
it.each(["workflow-panel-v1", "workflow-api-v1"] as const)(
  "upgrades the exact saved %s history grant only after execution preparation consent",
  async (serviceProtocol) => {
    const f = await fixture({
      version: "50.2.12",
      serviceProtocol,
      ...(serviceProtocol === "workflow-api-v1"
        ? { preset: "api-c16-scene" as const }
        : {}),
    });
    const { owner, claim } = await previewClaim(f);
    await owner.commitPolicyWhileStopped(claim);
    const saved = JSON.parse(readFileSync(f.policyPath, "utf8"));
    saved.networkGrants[0].paths = [
      { method: "POST", path: "/api/workflow/generate" },
      { method: "GET", path: "/api/comfy/proxy/queue" },
      { method: "GET", path: "/api/comfy/proxy/history" },
      { method: "GET", path: "/api/comfy/view" },
    ];
    writeFileSync(f.policyPath, JSON.stringify(saved), { mode: 0o600 });
    const bootstrap = (await prepareDesktopPluginBootstrap({
      dataDirectory: f.dataDirectory,
      actor,
      sessionEntropy: fixtureHash("query-upgrade-fixture"),
    }))!;
    try {
      const upgrading = f.create();
      const before = readFileSync(f.policyPath, "utf8");
      const preview = await upgrading.preview({
        bootstrap,
        pluginId: f.identity.pluginId,
      });
      expect(preview.networkPaths).toEqual(SHORT_WORKFLOW_PANEL_NETWORK_PATHS);
      expect(readFileSync(f.policyPath, "utf8")).toBe(before);
      const upgradeClaim = upgrading.claimPreview({
        previewId: preview.previewId,
        approveExecution: true,
      });
      await upgrading.commitPolicyWhileStopped(upgradeClaim);
      const after = JSON.parse(readFileSync(f.policyPath, "utf8"));
      expect(after.packages).toEqual(saved.packages);
      expect(after.networkGrants).toEqual([
        {
          ...saved.networkGrants[0],
          paths: SHORT_WORKFLOW_PANEL_NETWORK_PATHS,
        },
      ]);
    } finally {
      await bootstrap.cleanup();
    }
  },
);
