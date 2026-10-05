import { vi } from "vitest";
import { parseProjectPlanningProposal } from "@crewon/contracts/project-planning";
import { controlUiItem } from "./controlPluginUi.test-support";
import { uiLease } from "./pluginUiLoader.test-support";
import { createProjectPlanningLaunch } from "./projectPlanningLaunch";
import { createProjectPlanningLaunchIntentStore } from "./projectPlanningLaunchIntent";
const at = "2026-10-06T00:00:00.000Z",
  digest = `sha256:${"a".repeat(64)}`;
export function planningLaunchFixture() {
  const original = uiLease();
  const lease = {
    ...original,
    descriptor: {
      ...original.descriptor,
      requires: [
        "crewon.project-planning-drafts",
        "crewon.creative-projects",
        "crewon.project-conversations",
        "crewon.project-conversation-association",
        "crewon.project-text-plans",
      ].map((service) => ({ service, apiVersion: "1", optional: true })),
    },
  };
  const module = {
    key: "module",
    mountKey: "mount",
    title: "AI 短剧",
    contributionId: "workbench",
    plugin: controlUiItem(lease),
  };
  const proposal = parseProjectPlanningProposal({
    schemaVersion: "crewon.project-planning-proposal.v1",
    kind: "newProject",
    capability: {
      capabilityId: digest,
      source: {
        pluginId: lease.descriptor.pluginId,
        publisherId: lease.descriptor.publisherId,
        version: lease.descriptor.version,
        packageDigest: lease.packageDigest,
        contributionId: "workbench",
      },
      title: "AI 短剧",
      kind: "short-drama",
      stages: ["brief", "outline", "script"],
      maximumEpisodes: 16,
      moduleAvailable: true,
      textPlansAvailable: true,
      executionReady: true,
    },
    origin: {
      runId: "original-run",
      threadId: "original-thread",
      callId: "original-call",
    },
    input: {
      capabilityId: digest,
      title: "雨夜来信",
      briefText: "两位老友在雨夜重逢",
      instruction: "先做两集悬疑方案",
      start: "outline",
      target: "script",
      episodeCount: 2,
      adoption: "manual",
    },
  });
  const project = {
    projectId: "project",
    kind: "short-drama",
    title: proposal.input.title,
    revision: 2,
    state: "active",
    latestBriefRevision: 1,
    createdAt: at,
    updatedAt: at,
  };
  const brief = {
    projectId: "project",
    briefRevision: 1,
    text: proposal.input.briefText,
    contentDigest: digest,
    createdAt: at,
  };
  const binding = {
    bindingId: "binding",
    projectId: "project",
    threadId: proposal.origin.threadId,
    workspaceId: "original-workspace",
    revision: 1,
    state: "active",
    source: {
      ...proposal.capability.source,
      selectionRevision: lease.selectionRevision,
    },
    createdAt: at,
    updatedAt: at,
  };
  const { contributionId: _unused, ...bindingSource } = binding.source;
  binding.source = bindingSource as typeof binding.source;
  const view = {
    plan: {
      planId: "plan",
      projectId: "project",
      threadId: proposal.origin.threadId,
      revision: 1,
      currentPlanRevision: 1,
      state: "ready",
      activeStepId: "outline-step",
      pauseReason: null,
      createdAt: at,
      updatedAt: at,
    },
    definition: {
      planId: "plan",
      planRevision: 1,
      start: "outline",
      target: "script",
      episodeMode: "newOutline",
      episodeIds: ["episode-1", "episode-2"],
      adoption: "manual",
      instruction: proposal.input.instruction,
      sources: {
        brief: { briefRevision: 1, contentDigest: digest },
        outline: null,
      },
    },
    steps: [
      { stepId: "outline-step", ordinal: 1, kind: "outline", episodeId: null },
      ...["episode-1", "episode-2"].map((episodeId, i) => ({
        stepId: `script-${i + 1}`,
        ordinal: i + 2,
        kind: "script",
        episodeId,
      })),
    ].map((s) => ({
      ...s,
      attempt: 1,
      revision: 1,
      state: "ready",
      sources: null,
      run: null,
      result: null,
      selection: null,
      terminal: null,
    })),
  };
  const raw = new Map<string, string>();
  const storage = {
    getItem: (key: string) => raw.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      raw.set(key, value);
    }),
  };
  const store = createProjectPlanningLaunchIntentStore(
    storage,
    "actual-account-original-api",
  );
  let attached = false,
    created = false;
  const calls: { action: string; input: unknown }[] = [];
  const response = async (request: {
    action: string;
    input: unknown;
  }): Promise<unknown> => {
    calls.push(structuredClone(request));
    if (request.action.endsWith(".getProject")) return { project };
    if (request.action.endsWith(".getBinding"))
      return { binding: attached ? binding : null };
    if (request.action.endsWith(".createProject")) {
      const replay = created;
      created = true;
      return { disposition: replay ? "replayed" : "committed", project, brief };
    }
    if (request.action.endsWith(".attach")) {
      const replay = attached;
      attached = true;
      return { disposition: replay ? "replayed" : "committed", binding };
    }
    if (request.action.endsWith(".start")) {
      view.definition.adoption = (
        request.input as { adoption: string }
      ).adoption;
      return { disposition: "committed", view };
    }
    if (request.action.endsWith(".get")) return { view };
    throw new Error(`unexpected_action:${request.action}`);
  };
  const transport = {
    module: vi.fn(() => module),
    assertCurrent: vi.fn(),
    originThread: vi.fn(async () => ({
      revision: 7,
      workspaceId: "original-workspace",
    })),
    acquire: vi.fn(async () => lease),
    invoke: vi.fn(
      async (_lease: unknown, request: { action: string; input: unknown }) =>
        response(request),
    ),
    release: vi.fn(async () => undefined),
  };
  return {
    lease,
    module,
    proposal,
    project,
    brief,
    binding,
    view,
    calls,
    storage,
    raw,
    store,
    transport,
    response,
    launch: createProjectPlanningLaunch(store, transport),
  };
}
