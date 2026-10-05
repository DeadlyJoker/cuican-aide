// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { planningLaunchFixture } from "./projectPlanningLaunch.test-support";
import { createProjectPlanningLaunch } from "./projectPlanningLaunch";
import {
  createProjectPlanningLaunchIntentStore,
  parseProjectPlanningLaunchIntent,
} from "./projectPlanningLaunchIntent";
import { deferred } from "./pluginUiLoader.test-support";
const manual = { mode: "execute", adoption: "manual" } as const;
const writes = <T extends { action: string }>(calls: readonly T[]) =>
  calls.filter((c) => /\.(createProject|attach|start)$/u.test(c.action));
describe("original conversation project launch", () => {
  it("creates and associates the exact original Thread/workspace without starting work in create mode", async () => {
    const f = planningLaunchFixture();
    expect(f.launch.snapshot(f.proposal).phase).toBe("idle");
    expect(f.calls).toEqual([]);
    await f.launch.confirm(f.proposal, { mode: "create", adoption: "manual" });
    expect(writes(f.calls).map((c) => c.action)).toEqual([
      "crewon.creative-projects.v1.createProject",
      "crewon.project-conversation-association.v1.attach",
    ]);
    expect(writes(f.calls)[1].input).toMatchObject({
      threadId: "original-thread",
      expectedThreadRevision: 7,
      workspaceId: "original-workspace",
      projectId: "project",
    });
    expect(f.launch.snapshot(f.proposal).phase).toBe("created");
    expect(f.transport.release).toHaveBeenCalledOnce();
  });
  it("executes the confirmed stage/episode/adoption range using only the original text-plan service", async () => {
    const f = planningLaunchFixture();
    await f.launch.confirm(f.proposal, {
      mode: "execute",
      adoption: "whenUnchanged",
    });
    expect(writes(f.calls)).toHaveLength(3);
    expect(writes(f.calls)[2].input).toMatchObject({
      projectId: "project",
      threadId: "original-thread",
      expectedBindingRevision: 1,
      expectedBriefRevision: 1,
      instruction: f.proposal.input.instruction,
      start: "outline",
      target: "script",
      episodes: { kind: "newOutline", episodeCount: 2 },
      adoption: "whenUnchanged",
    });
    expect(f.launch.snapshot(f.proposal).plan?.plan.planId).toBe("plan");
    const count = writes(f.calls).length;
    await f.launch.refresh(f.proposal);
    await f.launch.confirm(f.proposal, {
      mode: "execute",
      adoption: "whenUnchanged",
    });
    expect(writes(f.calls)).toHaveLength(count);
  });
  for (const step of ["createProject", "attach", "start"])
    it(`retains a lost ${step} response, cold-reads only, and resumes the exact original command`, async () => {
      const f = planningLaunchFixture();
      let lost = false;
      f.transport.invoke.mockImplementation(async (_lease, request) => {
        const result = await f.response(request);
        if (!lost && request.action.endsWith(`.${step}`)) {
          lost = true;
          throw new Error("lost_response");
        }
        return result;
      });
      await expect(f.launch.confirm(f.proposal, manual)).rejects.toThrow(
        "lost_response",
      );
      expect(f.launch.snapshot(f.proposal).phase).toBe("uncertain");
      expect(f.transport.release).not.toHaveBeenCalled();
      const original = writes(f.calls).at(-1),
        before = writes(f.calls).length;
      const restored = createProjectPlanningLaunch(
        createProjectPlanningLaunchIntentStore(
          f.storage,
          "actual-account-original-api",
        ),
        f.transport,
      );
      await restored.refresh(f.proposal);
      expect(writes(f.calls)).toHaveLength(before);
      await restored.confirm(f.proposal, manual);
      const attempts = writes(f.calls).filter(
        (c) => c.action === original?.action,
      );
      if (step === "attach")
        expect(attempts).toHaveLength(1); // Positive canonical binding completes recovery without another POST.
      else expect(attempts).toHaveLength(2);
      expect(
        attempts.every(
          (c) => JSON.stringify(c.input) === JSON.stringify(original?.input),
        ),
      ).toBe(true);
      expect(restored.snapshot(f.proposal).phase).toBe("started");
    });
  it("freezes the original association revision when an uncommitted request is retried", async () => {
    const f = planningLaunchFixture();
    let first = true;
    f.transport.invoke.mockImplementation(async (_lease, request) => {
      if (first && request.action.endsWith(".attach")) {
        first = false;
        f.calls.push(structuredClone(request));
        throw new Error("unknown");
      }
      return f.response(request);
    });
    await expect(f.launch.confirm(f.proposal, manual)).rejects.toThrow(
      "unknown",
    );
    f.transport.originThread.mockResolvedValue({
      revision: 99,
      workspaceId: "changed-workspace",
    });
    await f.launch.confirm(f.proposal, manual);
    const attempts = writes(f.calls).filter((c) =>
      c.action.endsWith(".attach"),
    );
    expect(attempts[1].input).toEqual(attempts[0].input);
    expect(f.transport.originThread).toHaveBeenCalledOnce();
  });
  it("does not issue the next mutation after a late committed reply belongs to a changed context", async () => {
    const f = planningLaunchFixture();
    let changed = false;
    f.transport.assertCurrent.mockImplementation(() => {
      if (changed) throw new Error("context_changed");
    });
    f.transport.invoke.mockImplementation(async (_lease, request) => {
      const result = await f.response(request);
      if (request.action.endsWith(".createProject")) changed = true;
      return result;
    });
    await expect(f.launch.confirm(f.proposal, manual)).rejects.toThrow(
      "context_changed",
    );
    expect(writes(f.calls)).toHaveLength(1);
    expect(f.store.get(f.proposal)?.projectId).toBe("project");
  });
  it("serializes duplicate confirmation clicks and cannot change a frozen execution scope", async () => {
    const f = planningLaunchFixture(),
      gate = deferred<{ revision: number; workspaceId: string }>();
    f.transport.originThread.mockImplementation(() => gate.promise);
    const pending = f.launch.confirm(f.proposal, manual);
    await expect(f.launch.confirm(f.proposal, manual)).rejects.toThrow("busy");
    gate.resolve({ revision: 7, workspaceId: "original-workspace" });
    await pending;
    await expect(
      f.launch.confirm(f.proposal, {
        mode: "execute",
        adoption: "whenUnchanged",
      }),
    ).rejects.toThrow("confirmation_changed");
    expect(writes(f.calls)).toHaveLength(3);
  });
  it("blocks before writes if source lease, existing binding or execution availability differs", async () => {
    for (const kind of ["lease", "binding", "execution"]) {
      const f = planningLaunchFixture();
      if (kind === "lease")
        f.transport.acquire.mockResolvedValue({
          ...f.lease,
          selectionRevision: 2,
        });
      if (kind === "binding")
        f.transport.invoke.mockResolvedValue({
          binding: { ...f.binding, projectId: "other" },
        });
      const proposal =
        kind === "execution"
          ? {
              ...f.proposal,
              capability: { ...f.proposal.capability, executionReady: false },
            }
          : f.proposal;
      await expect(f.launch.confirm(proposal, manual)).rejects.toThrow();
      expect(writes(f.calls)).toHaveLength(0);
    }
  });
  it("does not dispatch when saving the frozen command fails", async () => {
    const f = planningLaunchFixture();
    f.storage.setItem.mockImplementation(() => {
      throw new Error("storage_unavailable");
    });
    await expect(f.launch.confirm(f.proposal, manual)).rejects.toThrow(
      "storage_unavailable",
    );
    expect(writes(f.calls)).toHaveLength(0);
  });
  it("isolates cache owners, rejects corrupt/coherently retargeted commands and respects bounded capacity", async () => {
    const f = planningLaunchFixture();
    await f.launch.confirm(f.proposal, manual);
    const intent = f.store.get(f.proposal)!;
    expect(
      createProjectPlanningLaunchIntentStore(f.storage, "other-account").get(
        f.proposal,
      ),
    ).toBeNull();
    for (const patch of [
      { actorId: "forged" },
      { threadRevision: 8 },
      { workspaceId: null },
      { mode: "create" },
      { adoption: "whenUnchanged" },
      { dispatched: "other" },
      { start: { ...intent.start, threadId: "other" } },
      { attach: { ...intent.attach, idempotencyKey: "new-key" } },
    ])
      expect(() =>
        parseProjectPlanningLaunchIntent({ ...intent, ...patch }),
      ).toThrow();
    const unresolved = {
      ...intent,
      dispatched: "create",
      projectId: null,
      briefRevision: null,
      attach: null,
      start: null,
      associated: false,
      planId: null,
    } as const;
    const boundedStore = createProjectPlanningLaunchIntentStore(
      f.storage,
      "bounded-owner",
    );
    boundedStore.save(unresolved);
    for (let i = 1; i < 16; i++)
      boundedStore.save({
        ...unresolved,
        proposal: {
          ...intent.proposal,
          origin: { ...intent.proposal.origin, callId: `call-${i}` },
        },
      });
    expect(() =>
      boundedStore.save({
        ...unresolved,
        proposal: {
          ...intent.proposal,
          origin: { ...intent.proposal.origin, callId: "call-overflow" },
        },
      }),
    ).toThrow("intent_limit");
    boundedStore.save({
      ...intent,
      proposal: {
        ...intent.proposal,
        origin: { ...intent.proposal.origin, callId: "call-1" },
      },
    });
    boundedStore.save({
      ...unresolved,
      proposal: {
        ...intent.proposal,
        origin: { ...intent.proposal.origin, callId: "call-overflow" },
      },
    });
    expect(boundedStore.get(f.proposal)?.dispatched).toBe("create");
    expect(() =>
      createProjectPlanningLaunchIntentStore(
        { getItem: () => "{bad", setItem: vi.fn() },
        "owner",
      ),
    ).toThrow();
  });
  it("rejects a corrupted frozen identity before dispatching or acquiring a mount", async () => {
    const f = planningLaunchFixture();
    await f.launch.confirm(f.proposal, manual);
    const corrupted = {
      ...f.store.get(f.proposal)!,
      key: "b".repeat(64),
      attach: {
        ...f.store.get(f.proposal)!.attach!,
        idempotencyKey: `planning-attach:${"b".repeat(64)}`,
      },
      start: {
        ...f.store.get(f.proposal)!.start!,
        idempotencyKey: `planning-start:${"b".repeat(64)}`,
      },
    };
    f.raw.set([...f.raw.keys()][0], JSON.stringify([corrupted]));
    const calls = f.calls.length,
      mounts = f.transport.acquire.mock.calls.length;
    await expect(f.launch.refresh(f.proposal)).rejects.toThrow(
      "intent_invalid",
    );
    expect(f.calls).toHaveLength(calls);
    expect(f.transport.acquire.mock.calls).toHaveLength(mounts);
  });
  it("rereads shared account hints and refuses to overwrite a previous frozen confirmation", async () => {
    const f = planningLaunchFixture(),
      other = createProjectPlanningLaunchIntentStore(
        f.storage,
        "actual-account-original-api",
      );
    f.transport.invoke.mockImplementation(async (_lease, request) => {
      if (request.action.endsWith(".createProject")) throw new Error("unknown");
      return f.response(request);
    });
    await expect(f.launch.confirm(f.proposal, manual)).rejects.toThrow(
      "unknown",
    );
    const original = other.get(f.proposal)!;
    expect(original.dispatched).toBe("create");
    expect(() => other.save({ ...original, mode: "create" })).toThrow(
      "intent_changed",
    );
    expect(f.store.get(f.proposal)).toEqual(original);
  });
});
