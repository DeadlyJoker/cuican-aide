import { describe, expect, it, vi } from "vitest";
import {
  ControlApiClient,
  ControlApiTransportError,
} from "@crewon/control-client";
import { ControlProjectConversationTurn } from "./controlProjectConversationTurn";
const at = "2026-10-06T00:00:00.000Z";
const binding = {
  bindingId: "binding",
  projectId: "project",
  threadId: "thread",
  workspaceId: "original-workspace",
  revision: 1,
  state: "active" as const,
  source: {
    pluginId: "crewon.short-drama",
    publisherId: "example.publisher",
    version: "16.0.0",
    packageDigest: `sha256:${"a".repeat(64)}`,
    selectionRevision: 2,
  },
  createdAt: at,
  updatedAt: at,
};
const input = {
  threadId: "thread",
  content: " 原聊天\n保留原话 ",
  modelId: "gpt-5.6-sol",
  expectedThreadRevision: 3,
  selection: { binding, stage: { kind: "outline" as const, briefRevision: 1 } },
};
const acknowledgement = {
  disposition: "committed",
  threadId: "thread",
  threadRevision: 4,
  runId: "actual-run",
  runRevision: 1,
  bindingRevision: 1,
  stageAdmissionDigest: `sha256:${"b".repeat(64)}`,
};
function api(fetch: typeof globalThis.fetch) {
  return new ControlApiClient({
    baseUrl: "https://control.test",
    accessToken: "actual-token",
    csrfToken: "actual-csrf",
    fetch,
  });
}
describe("original project Turn key and physical lifetime", () => {
  it("retains an unknown intent through later CAS conflicts without allocating a replacement key", async () => {
    const bodies: unknown[] = [];
    const key = vi.fn(() => "original-key");
    const owner = new ControlProjectConversationTurn(
      api(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (bodies.length === 1) throw new TypeError("lost ACK");
        return Response.json(
          {
            error: {
              category: "conflict",
              code: "project_conversation_revision_conflict",
              requestId: "fixture",
            },
          },
          { status: 409 },
        );
      }),
      key,
    );
    try {
      await expect(owner.start(input)).rejects.toMatchObject({
        name: "ControlApiTransportError",
        cause: { message: "lost ACK" },
      });
      for (const revision of [4, 5]) {
        await expect(
          owner.start({
            ...input,
            expectedThreadRevision: revision,
            selection: {
              ...input.selection,
              binding: { ...binding, revision },
            },
          }),
        ).rejects.toThrow("project_conversation_revision_conflict");
        expect(owner.retainedSelection("thread")).toEqual(input.selection);
      }
      expect(bodies).toEqual([bodies[0], bodies[0], bodies[0]]);
      expect(key).toHaveBeenCalledOnce();
    } finally {
      await owner.close();
    }
  });

  it("allows a new reviewed intent after an initial explicit CAS rejection", async () => {
    let keyCount = 0;
    const key = vi.fn(() => `key-${++keyCount}`);
    const bodies: Array<{
      idempotencyKey: string;
      expectedThreadRevision: number;
    }> = [];
    const owner = new ControlProjectConversationTurn(
      api(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json(
          {
            error: {
              category: "conflict",
              code: "project_conversation_revision_conflict",
              requestId: "fixture",
            },
          },
          { status: 409 },
        );
      }),
      key,
    );
    try {
      await expect(owner.start(input)).rejects.toThrow(
        "project_conversation_revision_conflict",
      );
      expect(owner.retainedSelection("thread")).toBeNull();
      await expect(
        owner.start({ ...input, expectedThreadRevision: 4 }),
      ).rejects.toThrow("project_conversation_revision_conflict");
      expect(
        bodies.map(({ expectedThreadRevision }) => expectedThreadRevision),
      ).toEqual([3, 4]);
      expect(bodies[0]!.idempotencyKey).not.toBe(bodies[1]!.idempotencyKey);
      expect(key).toHaveBeenCalledTimes(2);
    } finally {
      await owner.close();
    }
  });

  it("releases a rejected model selection so a corrected model can be sent", async () => {
    let keyCount = 0;
    const key = vi.fn(() => `key-${++keyCount}`);
    const owner = new ControlProjectConversationTurn(
      api(async () => {
        if (keyCount === 1)
          return Response.json(
            {
              error: {
                category: "validation",
                code: "plugin_task_model_selection_invalid",
                requestId: "fixture",
              },
            },
            { status: 422 },
          );
        return Response.json(acknowledgement);
      }),
      key,
    );
    try {
      await expect(owner.start(input)).rejects.toThrow(
        "plugin_task_model_selection_invalid",
      );
      expect(owner.retainedSelection("thread")).toBeNull();
      await expect(
        owner.start({ ...input, modelId: "gpt-6-astra" }),
      ).resolves.toEqual({ threadId: "thread", runId: "actual-run" });
      expect(key).toHaveBeenCalledTimes(2);
    } finally {
      await owner.close();
    }
  });

  it("ambiguous response retry retains original revisions/body/key even when the Thread advanced", async () => {
    const bodies: unknown[] = [];
    const key = vi.fn(() => "original-key");
    const lostAcknowledgement = new TypeError("lost ACK");
    const owner = new ControlProjectConversationTurn(
      api(async (_url, init) => {
        bodies.push(JSON.parse(init!.body as string));
        if (bodies.length === 1) throw lostAcknowledgement;
        return Response.json({ ...acknowledgement, disposition: "replayed" });
      }),
      key,
    );
    const first = owner.start(input);
    await expect(first).rejects.toBeInstanceOf(ControlApiTransportError);
    await expect(first).rejects.toMatchObject({
      name: "ControlApiTransportError",
      message: "control_api_transport_unavailable",
      cause: lostAcknowledgement,
    });
    expect(owner.retainedSelection("thread")).toEqual(input.selection);
    expect(owner.retainedSelection("other-thread")).toBeNull();
    expect(() => owner.start({ ...input, content: "different" })).toThrow(
      "original_request_pending",
    );
    expect(() =>
      owner.start({
        ...input,
        selection: {
          ...input.selection,
          binding: { ...binding, projectId: "foreign-project" },
        },
      }),
    ).toThrow("original_request_pending");
    expect(
      await owner.start({
        ...input,
        expectedThreadRevision: 4,
        selection: {
          binding: { ...binding, revision: 2 },
          stage: { kind: "outline", briefRevision: 2 },
        },
      }),
    ).toEqual({ threadId: "thread", runId: "actual-run" });
    expect(() => owner.start({ ...input, modelId: "gpt-5.6-luna" })).toThrow(
      "original_request_pending",
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      projectId: binding.projectId,
      threadId: input.threadId,
      content: input.content,
      modelId: input.modelId,
      expectedThreadRevision: input.expectedThreadRevision,
      expectedBindingRevision: binding.revision,
      idempotencyKey: "original-key",
      stage: input.selection.stage,
    });
    expect(bodies[0]).toEqual(bodies[1]);
    expect(key).toHaveBeenCalledTimes(1);
    expect(owner.retainedSelection("thread")).toEqual(input.selection);
    owner.adopted("thread", "actual-run");
    expect(owner.retainedSelection("thread")).toBeNull();
    await owner.close();
  });
  it("duplicate hot sends physically join once, and accepted hydration retry issues no new POST", async () => {
    let release!: (r: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    );
    const owner = new ControlProjectConversationTurn(api(fetch), () => "key");
    const first = owner.start(input),
      second = owner.start(input);
    expect(first).toBe(second);
    release(Response.json(acknowledgement));
    expect(await first).toEqual({ threadId: "thread", runId: "actual-run" });
    expect(await owner.start(input)).toEqual({
      threadId: "thread",
      runId: "actual-run",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await owner.close();
  });
  it("withdrawn owner cancels request and waits for the real transport before release", async () => {
    let release!: (r: Response) => void;
    const owner = new ControlProjectConversationTurn(
      api(
        () =>
          new Promise<Response>((r) => {
            release = r;
          }),
      ),
      () => "key",
    );
    const pending = owner.start(input);
    let joined = false;
    const closing = owner.close().then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    release(Response.json(acknowledgement));
    await expect(pending).rejects.toBeDefined();
    await closing;
    expect(joined).toBe(true);
    expect(() => owner.start(input)).toThrow();
  });
});
