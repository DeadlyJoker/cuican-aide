// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { ControlApiClient } from "@crewon/control-client";
import {
  createProjectChatCreation,
  type ProjectChatCreationPorts,
} from "./projectChatCreation";
import { controlUiItem } from "./controlPluginUi.test-support";
import { deferred, uiLease } from "./pluginUiLoader.test-support";
const at = "2026-10-15T00:00:00.000Z",
  digest = `sha256:${"a".repeat(64)}`;
function fixture() {
  const lease = uiLease(),
    module = {
      key: "module",
      mountKey: "mount",
      title: "AI 短剧",
      contributionId: "workbench",
      plugin: controlUiItem(lease),
    };
  const binding = {
    bindingId: "binding",
    projectId: "project",
    threadId: "thread",
    workspaceId: `workspace-project-${"b".repeat(64)}`,
    revision: 1,
    state: "active",
    source: {
      pluginId: lease.descriptor.pluginId,
      publisherId: lease.descriptor.publisherId,
      version: lease.descriptor.version,
      packageDigest: lease.packageDigest,
      selectionRevision: lease.selectionRevision,
    },
    createdAt: at,
    updatedAt: at,
  };
  const project = {
    projectId: "project",
    kind: "short-drama",
    title: "未来来信",
    revision: 2,
    state: "active",
    latestBriefRevision: 1,
    createdAt: at,
    updatedAt: at,
  };
  const invoke = vi.fn(
    async (
      _ref: string,
      request: { action: string; input: Record<string, unknown> },
    ) => {
      if (request.action.endsWith("createProject"))
        return {
          output: {
            kind: "create-project",
            disposition: "committed",
            project,
            brief: {
              projectId: "project",
              briefRevision: 1,
              text: request.input.briefText,
              contentDigest: digest,
              createdAt: at,
            },
            foundation: {
              schemaVersion: "crewon.project-foundation.v1",
              projectId: "project",
              origin: "creative",
              revision: 1,
              parametersRevision: 1,
              parameters: request.input.parameters,
              source: null,
              confirmedProposal: null,
              creativeStartMode: "confirm-plan",
              createdAt: at,
              updatedAt: at,
            },
            source: null,
            proposal: null,
          },
        };
      if (request.action.endsWith("resolveTarget"))
        return {
          output: { projectId: "project", workspaceId: binding.workspaceId },
        };
      return { output: { disposition: "committed", binding } };
    },
  );
  const getThread = vi.fn(async () => ({ thread: { revision: 7 } }));
  const startStage = vi.fn(
    async (
      _thread: string,
      _request: Record<string, unknown>,
      _options?: unknown,
    ) => ({ runId: "run" }),
  );
  const raw = new Map<string, string>();
  const ports: ProjectChatCreationPorts = {
    client: {
      plugins: { invoke },
      getThread,
      projectConversations: { startStage },
    } as unknown as ControlApiClient,
    storage: {
      getItem: (k) => raw.get(k) ?? null,
      setItem: (k, v) => {
        raw.set(k, v);
      },
      removeItem: (k) => {
        raw.delete(k);
      },
    },
    ownerKey: "account-original-api",
    assertCurrent: vi.fn(),
    acquire: vi.fn(async () => lease),
    release: vi.fn(async () => {}),
    opened: vi.fn(),
    diagnostic: vi.fn(),
  };
  return {
    module,
    lease,
    binding,
    ports,
    invoke,
    getThread,
    startStage,
    raw,
    create: createProjectChatCreation(ports),
  };
}
const idea = { content: "未来来信", modelId: "gpt-6.1-sol" };
describe("shared Send creates an isolated project through the original services", () => {
  it("creates a Foundation, allocates its own workspace and starts the original discussion with the selected model", async () => {
    const f = fixture();
    await f.create(f.module, idea);
    expect(f.invoke.mock.calls.map((c) => c[1].action)).toEqual([
      "crewon.project-foundation.v1.createProject",
      "crewon.project-workspace-target.v1.resolveTarget",
      "crewon.project-conversations.v1.createConversation",
    ]);
    expect(f.invoke.mock.calls[0][1].input).toMatchObject({
      briefText: idea.content,
      origin: "creative",
      creativeStartMode: "confirm-plan",
    });
    expect(f.invoke.mock.calls[2][1].input).toMatchObject({
      projectId: "project",
      workspaceId: f.binding.workspaceId,
    });
    expect(f.startStage).toHaveBeenCalledWith(
      "thread",
      expect.objectContaining({
        projectId: "project",
        threadId: "thread",
        content: idea.content,
        modelId: idea.modelId,
        expectedThreadRevision: 7,
        expectedBindingRevision: 1,
        stage: { kind: "discussion" },
      }),
      expect.anything(),
    );
    expect(f.ports.opened).toHaveBeenCalledWith(f.module, f.binding);
    expect(f.raw.size).toBe(0);
    expect(f.ports.release).toHaveBeenCalledOnce();
  });
  for (const lost of ["createProject", "createConversation", "startStage"])
    it(`a lost ${lost} receipt resumes the exact original command after reload`, async () => {
      const f = fixture();
      let first = true;
      if (lost === "startStage")
        f.startStage.mockImplementation(async () => {
          if (first) {
            first = false;
            throw new Error("lost");
          }
          return { runId: "run" };
        });
      else {
        const original = f.invoke.getMockImplementation()!;
        f.invoke.mockImplementation(async (...args) => {
          const reply = await original(...args);
          if (first && args[1].action.endsWith(lost)) {
            first = false;
            throw new Error("lost");
          }
          return reply;
        });
      }
      await expect(f.create(f.module, idea)).rejects.toThrow("lost");
      const prior = structuredClone(
        lost === "startStage"
          ? f.startStage.mock.calls.at(-1)![1]
          : f.invoke.mock.calls.at(-1)![1],
      );
      const restored = createProjectChatCreation(f.ports);
      const count = f.invoke.mock.calls.length + f.startStage.mock.calls.length;
      expect(restored.pending(f.module)).toEqual(idea);
      expect(f.invoke.mock.calls.length + f.startStage.mock.calls.length).toBe(
        count,
      );
      await restored(f.module, idea);
      const attempts =
        lost === "startStage"
          ? f.startStage.mock.calls.map((c) => c[1])
          : f.invoke.mock.calls
              .filter((c) => c[1].action.endsWith(lost))
              .map((c) => c[1]);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toEqual(prior);
      expect(f.ports.opened).toHaveBeenCalledOnce();
      expect(f.raw.size).toBe(0);
    });
  it("serializes duplicate sends, rejects a changed prompt and retains the committed project after account withdrawal", async () => {
    const f = fixture(),
      gate = deferred<typeof f.lease>();
    vi.mocked(f.ports.acquire).mockReturnValue(gate.promise);
    const pending = f.create(f.module, idea);
    expect(f.create(f.module, idea)).toBe(pending);
    expect(() => f.create(f.module, { ...idea, content: "different" })).toThrow(
      "original_request_pending",
    );
    gate.resolve(f.lease);
    await pending;
    const g = fixture(),
      original = g.invoke.getMockImplementation()!;
    g.invoke.mockImplementation(async (...args) => {
      const response = await original(...args);
      vi.mocked(g.ports.assertCurrent).mockImplementation(() => {
        throw new Error("session_changed");
      });
      return response;
    });
    await expect(g.create(g.module, idea)).rejects.toThrow("session_changed");
    expect(g.invoke).toHaveBeenCalledOnce();
    expect(g.startStage).not.toHaveBeenCalled();
    expect(JSON.parse([...g.raw.values()][0]).projectId).toBe("project");
    expect(g.ports.opened).not.toHaveBeenCalled();
  });
  it("does not dispatch after storage failure, malformed journal or changed installed source", async () => {
    const f = fixture();
    f.ports.storage.setItem = () => {
      throw new Error("storage");
    };
    await expect(f.create(f.module, idea)).rejects.toThrow("storage");
    expect(f.ports.acquire).not.toHaveBeenCalled();
    const g = fixture();
    Object.assign(g.binding.source, { packageDigest: digest });
    await expect(g.create(g.module, idea)).rejects.toThrow("source_changed");
    expect(g.startStage).not.toHaveBeenCalled();
    const key = [...g.raw.keys()][0];
    g.raw.set(
      key,
      JSON.stringify({ ...JSON.parse(g.raw.get(key)!), unknown: true }),
    );
    await expect(g.create(g.module, idea)).rejects.toThrow("intent_invalid");
  });
  it("ignores a close failure after committed launch and normalizes an empty model choice", async () => {
    const f = fixture();
    vi.mocked(f.ports.release).mockRejectedValue(new Error("close"));
    await f.create(f.module, { content: idea.content, modelId: " " });
    await Promise.resolve();
    expect(f.ports.opened).toHaveBeenCalledOnce();
    expect(f.ports.diagnostic).toHaveBeenCalledOnce();
    expect(f.startStage.mock.calls[0][1]).not.toHaveProperty("modelId");
  });
});
