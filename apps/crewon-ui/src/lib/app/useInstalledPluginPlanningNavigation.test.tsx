// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { parseProjectPlanningProposal } from "@crewon/contracts/project-planning";
import { useInstalledPluginPlanningNavigation } from "./useInstalledPluginPlanningNavigation";
import { controlUiItem } from "../plugins/controlPluginUi.test-support";
import { uiLease } from "../plugins/pluginUiLoader.test-support";
import type { ControlPluginUiCatalog } from "../plugins/controlPluginUiCatalog";
it("accepts a proposal only for the current session, Thread and complete installed module pin", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const item = controlUiItem(uiLease());
  const plugin = {
    ...item,
    descriptor: {
      ...item.descriptor,
      requires: [
        {
          service: "crewon.project-planning-drafts",
          apiVersion: "1",
          optional: true,
        },
      ],
    },
  };
  const module = {
    key: "module",
    mountKey: "mount",
    title: "短剧",
    contributionId: "workbench",
    plugin,
  };
  const catalog: ControlPluginUiCatalog = {
    fingerprint: "one",
    plugins: [plugin],
    modules: [module],
  };
  const digest = `sha256:${"a".repeat(64)}`;
  const proposal = parseProjectPlanningProposal({
    schemaVersion: "crewon.project-planning-proposal.v1",
    kind: "newProject",
    capability: {
      capabilityId: digest,
      source: {
        pluginId: plugin.descriptor.pluginId,
        publisherId: plugin.descriptor.publisherId,
        version: plugin.descriptor.version,
        packageDigest: plugin.packageDigest,
        contributionId: module.contributionId,
      },
      title: "短剧",
      kind: "short-drama",
      stages: ["brief", "outline", "script"],
      maximumEpisodes: 16,
      moduleAvailable: true,
      textPlansAvailable: true,
      executionReady: false,
    },
    origin: { threadId: "thread", runId: "run", callId: "call" },
    input: {
      capabilityId: digest,
      title: "故事",
      briefText: "雨夜重逢",
      instruction: "写需求",
      start: "brief",
      target: "brief",
      episodeCount: null,
      adoption: "manual",
    },
  });
  type Input = Parameters<
    typeof useInstalledPluginPlanningNavigation<object>
  >[0];
  let state!: ReturnType<typeof useInstalledPluginPlanningNavigation<object>>;
  const root = createRoot(document.createElement("div")),
    scope = {};
  function Probe(input: Input) {
    state = useInstalledPluginPlanningNavigation(input);
    return null;
  }
  async function render(input: Input) {
    await act(async () => root.render(<Probe {...input} />));
  }
  try {
    await render({ scope, catalog, threadId: "thread" });
    expect(state.request).toBeNull();
    await act(async () => state.navigation.open(proposal));
    expect(state.request?.id).toBe("module");
    expect(state.draftFor(module)).toEqual(proposal);
    await act(async () => state.navigation.openWorkbench(proposal));
    expect(state.request?.id).toBe("module");
    expect(state.draftFor(module)).toBeUndefined();
    await render({ scope, catalog, threadId: "another-thread" });
    expect(state.request).toBeNull();
    expect(() => state.navigation.open(proposal)).toThrow();
    await render({ scope: {}, catalog, threadId: "thread" });
    expect(state.request).toBeNull();
    await render({
      scope,
      catalog: {
        ...catalog,
        modules: [{ ...module, plugin: { ...plugin, packageDigest: digest } }],
      },
      threadId: "thread",
    });
    expect(state.navigation.canOpen(proposal)).toBe(false);
    expect(state.request).toBeNull();
    await render({ scope, catalog: null, threadId: "thread" });
    expect(() => state.navigation.open(proposal)).toThrow();
  } finally {
    await act(async () => root.unmount());
  }
});
