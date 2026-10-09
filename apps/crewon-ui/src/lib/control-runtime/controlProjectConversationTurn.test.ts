import { describe, expect, it, vi } from "vitest";
import { ControlApiClient } from "@crewon/control-client";
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
  it("ambiguous response retry retains original revisions/body/key even when the Thread advanced", async () => {
    const bodies: unknown[] = [];
    const key = vi.fn(() => "original-key");
    const owner = new ControlProjectConversationTurn(
      api(async (_url, init) => {
        bodies.push(JSON.parse(init!.body as string));
        if (bodies.length === 1) throw new TypeError("lost ACK");
        return Response.json({ ...acknowledgement, disposition: "replayed" });
      }),
      key,
    );
    await expect(owner.start(input)).rejects.toThrow("lost ACK");
    expect(owner.retainedSelection("thread")).toEqual(input.selection);
    expect(owner.retainedSelection("other-thread")).toBeNull();
    expect(() => owner.start({ ...input, content: "different" })).toThrow(
      "original_request_pending",
    );
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
    expect(bodies[0]).toMatchObject({ modelId: input.modelId });
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
