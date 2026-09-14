import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebContents } from "electron";
import {
  canonicalActionIntent,
  type ActionIntent,
  type BrowserActInput,
} from "@crewon/contracts";
import type {
  ToolExecutionCommand,
  ToolExecutionResolution,
} from "@crewon/tool-broker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserGrantScope } from "../src/lib/browser-execution/browserExecutionGrant.ts";
import type { BrowserRunIdentity } from "./browserExecutionGrants.ts";
import {
  BrowserExecutionHost,
  browserHostPolicy,
  type BrowserSessionAccess,
} from "./browserExecutionHost.ts";

const automation = vi.hoisted(() => ({
  construct: vi.fn(),
  observe: vi.fn(),
  act: vi.fn(),
  close: vi.fn(),
  isInput: false,
}));
vi.mock("./browserExecutionPuppeteer.ts", () => ({
  BrowserViewAutomation: class {
    constructor(...args: unknown[]) {
      automation.construct(...args);
    }
    observe() {
      return automation.observe();
    }
    act(...args: unknown[]) {
      return automation.act(...args);
    }
    close() {
      return automation.close();
    }
  },
  isBrowserAutomationInput: () => automation.isInput,
}));

const origin = "https://reports.example.com";
const ref = {
  skillId: "skill-1",
  versionId: "version-1",
  contentDigest: `sha256:${"a".repeat(64)}`,
};
const observedTargets = [
  {
    targetId: "target-export",
    role: "button",
    name: "导出 CSV",
    tag: "button",
  },
  { targetId: "target-date", role: "textbox", name: "日期", tag: "input" },
];
const resources: { host: BrowserExecutionHost; directory: string }[] = [];
let commandSequence = 0;

beforeEach(() => {
  vi.clearAllMocks();
  automation.isInput = false;
  automation.observe.mockImplementation(async () => ({
    url: origin,
    targets: structuredClone(observedTargets),
    truncated: false,
    unsupported: [],
  }));
  automation.act.mockImplementation(
    async (
      _input: unknown,
      _target: unknown,
      _signal: AbortSignal,
      beforeEffect: () => void,
    ) => {
      beforeEffect();
    },
  );
  automation.close.mockResolvedValue(undefined);
});
afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.host.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

// These tests isolate the host contract. The DOM/Puppeteer adapter is mocked;
// they are deliberately not evidence of GUI execution or real model routing.
describe("BrowserExecutionHost authorization and recovery boundaries", () => {
  it("B02 rejects absent grants before acquiring a session or touching automation", async () => {
    const fixture = setup();
    const result = await fixture.host.execute(
      command("crewon_browser_observe"),
    );
    expect(errorCode(result)).toBe("browser_authorization_required");
    expect(fixture.sessions.acquireExecution).not.toHaveBeenCalled();
    expect(automation.construct).not.toHaveBeenCalled();
    expect(automation.observe).not.toHaveBeenCalled();
  });

  it.each(["recording", "paused", "interrupted"])(
    "B02 refuses authorization while the teaching session is %s",
    async (mode) => {
      const fixture = setup();
      fixture.setMode(mode);
      await expect(
        fixture.host.authorize({ threadId: "thread-1" }),
      ).rejects.toThrow("browser_finish_recording_first");
      expect(fixture.host.status("thread-1")).toBeNull();
      expect(automation.construct).not.toHaveBeenCalled();
    },
  );

  it("B02 rejects other threads, workspaces and model-selected sessions before DOM access", async () => {
    const fixture = setup();
    await fixture.host.authorize({ threadId: "thread-1" });
    fixture.authority.resolveRun.mockResolvedValue({
      ...runIdentity(),
      threadId: "thread-other",
    });
    expect(
      errorCode(await fixture.host.execute(command("crewon_browser_observe"))),
    ).toBe("browser_authorization_required");
    fixture.authority.resolveRun.mockResolvedValue({
      ...runIdentity(),
      workspaceBindingId: "workspace-other",
    });
    expect(
      errorCode(await fixture.host.execute(command("crewon_browser_observe"))),
    ).toBe("browser_workspace_mismatch");
    fixture.authority.resolveRun.mockResolvedValue(runIdentity());
    expect(
      errorCode(
        await fixture.host.execute(
          command("crewon_browser_observe", { sessionId: "session-other" }),
        ),
      ),
    ).toBe("browser_session_forbidden");
    expect(automation.construct).not.toHaveBeenCalled();
  });

  it("B04 refuses execution when authority returns after explicit revocation", async () => {
    const fixture = setup();
    await fixture.host.authorize({ threadId: "thread-1" });
    const authority = deferred<BrowserRunIdentity>();
    fixture.authority.resolveRun.mockReturnValueOnce(authority.promise);
    const pending = fixture.host.execute(command("crewon_browser_observe"));
    fixture.host.revoke("thread-1");
    authority.resolve(runIdentity());
    expect(errorCode(await pending)).toBe("browser_authorization_required");
    expect(automation.observe).not.toHaveBeenCalled();
    expect(fixture.sessions.acquireExecution).not.toHaveBeenCalled();
  });

  it.each(["revoke", "close"] as const)(
    "B04 does not resurrect a pending authorization after %s during authority await",
    async (action) => {
      const fixture = setup();
      const authority = deferred<void>();
      fixture.authority.checkThread.mockReturnValueOnce(authority.promise);
      const pending = fixture.host.authorize({ threadId: "thread-1" });
      const result = pending.then(
        () => "authorized",
        () => "rejected",
      );
      if (action === "revoke") fixture.host.revoke("thread-1");
      else fixture.host.close();
      authority.resolve(undefined);
      expect(await result).toBe("rejected");
      expect(fixture.host.status("thread-1")).toBeNull();
    },
  );

  it("B05 keeps a fresh observation through normal F02 lease release", async () => {
    const fixture = setup();
    await fixture.host.authorize({ threadId: "thread-1" });
    const observed = await observe(fixture.host);
    expect(fixture.sessions.releaseExecution).toHaveBeenCalledTimes(1);
    const result = await fixture.host.execute(
      command("crewon_browser_act", click(observed)),
    );
    expect(errorCode(result)).toBeNull();
    expect(automation.act).toHaveBeenCalledTimes(1);
  });

  it("B05 preserves the grant through navigation but rejects targets from the old generation", async () => {
    const fixture = setup();
    await fixture.host.authorize({ threadId: "thread-1" });
    const observed = await observe(fixture.host);
    const navigation: BrowserActInput = {
      ...observed,
      action: "navigate",
      url: `${origin}/next`,
    };
    const result = await fixture.host.execute(
      command("crewon_browser_act", navigation),
    );
    expect(errorCode(result)).toBeNull();
    expect(fixture.wc.loadURL).toHaveBeenCalledExactlyOnceWith(
      `${origin}/next`,
    );
    expect(fixture.host.status("thread-1")).not.toBeNull();
    const stale = await fixture.host.execute(
      command("crewon_browser_act", click(observed)),
    );
    expect(errorCode(stale)).toBe("browser_stale_observation");
    expect(automation.act).not.toHaveBeenCalled();
    const current = await observe(fixture.host);
    expect(current.generation).toBe(observed.generation + 1);
    expect(
      errorCode(
        await fixture.host.execute(
          command("crewon_browser_act", click(current)),
        ),
      ),
    ).toBeNull();
  });

  it("B05 resolves scoped stable target IDs only through the authorized original observation", async () => {
    const fixture = setup();
    await fixture.host.authorize({ threadId: "thread-1", scope: scoped() });
    const observed = await observe(fixture.host);
    const unknownTarget = await fixture.host.execute(
      command("crewon_browser_act_scoped", {
        ...click(observed),
        target: { targetId: "unobserved-target" },
      }),
    );
    expect(errorCode(unknownTarget)).toBe("requires_explicit_approval");
    expect(automation.act).not.toHaveBeenCalled();
    const result = await fixture.host.execute(
      command("crewon_browser_act_scoped", click(observed)),
    );
    expect(errorCode(result)).toBeNull();
    // Live role/name/tag change detection belongs to the real adapter's GUI probe.
    expect(automation.act.mock.calls[0]?.[0]).toMatchObject({
      target: { targetId: "target-export" },
    });
    expect(automation.act.mock.calls[0]?.[1]).toBe("target-export");
  });

  it("scoped actions require a fixed trusted Skill, matching parameters and reviewed target", async () => {
    const fixture = setup();
    await fixture.host.authorize({ threadId: "thread-1", scope: scoped() });
    const observed = await observe(fixture.host);
    const action: BrowserActInput = {
      ...observed,
      action: "fill",
      target: { targetId: "target-date" },
      value: "2026-09-14",
    };
    fixture.authority.resolveRun.mockResolvedValue({
      ...runIdentity(),
      skill: null,
    });
    expect(
      errorCode(
        await fixture.host.execute(
          command("crewon_browser_act_scoped", action),
        ),
      ),
    ).toBe("requires_explicit_approval");
    fixture.authority.resolveRun.mockResolvedValue(runIdentity());
    expect(
      errorCode(
        await fixture.host.execute(
          command("crewon_browser_act_scoped", {
            ...action,
            value: "2026-09-15",
          }),
        ),
      ),
    ).toBe("requires_explicit_approval");
    expect(automation.act).not.toHaveBeenCalled();
    expect(
      errorCode(
        await fixture.host.execute(
          command("crewon_browser_act_scoped", action),
        ),
      ),
    ).toBeNull();
    expect(automation.act).toHaveBeenCalledTimes(1);
  });

  it("scoped authorization permits the next periodic Run to navigate from yesterday's report to today's reviewed URL", async () => {
    const fixture = setup();
    const dates: Record<string, string> = {
      "run-1": "2026-09-14",
      "run-2": "2026-09-15",
    };
    fixture.authority.resolveRun.mockImplementation(async (runId) => ({
      ...runIdentity(),
      runId,
      skill: { ref, parameters: { date: dates[runId]! } },
    }));
    const scope = scoped();
    scope.rules.push({
      action: "navigate",
      urlTemplate: `${origin}/export?date={date}`,
    });
    const initialGrant = await fixture.host.authorize({
      threadId: "thread-1",
      scope,
    });
    for (const [runId, date] of Object.entries(dates)) {
      const before = await observe(fixture.host, runId);
      if (runId === "run-2") {
        const oldPageFill = await fixture.host.execute(
          command(
            "crewon_browser_act_scoped",
            {
              ...before,
              action: "fill",
              target: { targetId: "target-date" },
              value: date,
            },
            { runId },
          ),
        );
        expect(errorCode(oldPageFill)).toBe("requires_explicit_approval");
      }
      const navigation = await fixture.host.execute(
        command(
          "crewon_browser_act_scoped",
          {
            ...before,
            action: "navigate",
            url: `${origin}/export?date=${date}`,
          },
          { runId },
        ),
      );
      expect(errorCode(navigation), `navigation for ${date}`).toBeNull();
      const current = await observe(fixture.host, runId);
      const filled = await fixture.host.execute(
        command(
          "crewon_browser_act_scoped",
          {
            ...current,
            action: "fill",
            target: { targetId: "target-date" },
            value: date,
          },
          { runId },
        ),
      );
      expect(errorCode(filled), `fill for ${date}`).toBeNull();
    }
    expect(fixture.wc.getURL()).toBe(`${origin}/export?date=2026-09-15`);
    expect(fixture.host.status("thread-1")?.revision).toBe(
      initialGrant.revision,
    );
    expect(automation.act).toHaveBeenCalledTimes(2);
  });

  it("B06 reuses durable completion without running the same action again", async () => {
    const fixture = setup();
    await fixture.host.authorize({ threadId: "thread-1" });
    const observed = await observe(fixture.host);
    const request = command("crewon_browser_act", click(observed));
    const first = await fixture.host.execute(request);
    expect(errorCode(first)).toBeNull();
    expect(await fixture.host.execute(request)).toEqual(first);
    expect(await fixture.host.reconcile(request)).toEqual(first);
    expect(automation.act).toHaveBeenCalledTimes(1);
    fixture.host.revoke("thread-1");
    expect(await fixture.host.execute(request)).toEqual(first);
    expect(await fixture.host.reconcile(request)).toEqual(first);
    expect(automation.act).toHaveBeenCalledTimes(1);
    const conflicting = command(
      "crewon_browser_act",
      { ...click(observed), target: { role: "button", name: "其他操作" } },
      { executionId: request.executionId },
    );
    await expect(fixture.host.execute(conflicting)).rejects.toThrow();
    expect(automation.act).toHaveBeenCalledTimes(1);
  });

  it("B06 rejects conflicting reuse while the original execution still awaits authority", async () => {
    const fixture = setup();
    await fixture.host.authorize({ threadId: "thread-1" });
    const authority = deferred<BrowserRunIdentity>();
    fixture.authority.resolveRun.mockReturnValueOnce(authority.promise);
    const firstCommand = command("crewon_browser_observe");
    const first = fixture.host.execute(firstCommand);
    const duplicate = fixture.host.execute(firstCommand);
    const conflicting = fixture.host
      .execute(
        command(
          "crewon_browser_observe",
          { sessionId: "session-1" },
          { executionId: firstCommand.executionId },
        ),
      )
      .then(
        () => "accepted",
        () => "rejected",
      );
    authority.resolve(runIdentity());
    const result = await first;
    expect(await duplicate).toEqual(result);
    expect(await conflicting).toBe("rejected");
    expect(automation.observe).toHaveBeenCalledTimes(1);
  });

  it("B06 cannot cancel a pending execution through a conflicting Run identity", async () => {
    const fixture = setup();
    await fixture.host.authorize({ threadId: "thread-1" });
    const authority = deferred<BrowserRunIdentity>();
    fixture.authority.resolveRun.mockReturnValueOnce(authority.promise);
    const firstCommand = command("crewon_browser_observe");
    const pending = fixture.host.execute(firstCommand);
    const attemptedCancel = fixture.host
      .cancel(
        command(
          "crewon_browser_observe",
          {},
          { executionId: firstCommand.executionId, runId: "run-other" },
        ),
      )
      .then(
        () => "accepted",
        () => "rejected",
      );
    authority.resolve(runIdentity());
    const result = await pending;
    expect(await attemptedCancel).toBe("rejected");
    expect(errorCode(result)).toBeNull();
    expect(automation.observe).toHaveBeenCalledTimes(1);
  });

  it("B04/B06 cancellation aborts an in-flight action and keeps the unknown-outcome fence", async () => {
    const fixture = setup();
    await fixture.host.authorize({ threadId: "thread-1" });
    const observed = await observe(fixture.host);
    const started = deferred<AbortSignal>();
    automation.act.mockImplementation(
      (
        _input: unknown,
        _target: string,
        signal: AbortSignal,
        beforeEffect: () => void,
      ) => {
        beforeEffect();
        started.resolve(signal);
        return new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new Error("browser_execution_canceled")),
            { once: true },
          ),
        );
      },
    );
    const request = command("crewon_browser_act", click(observed));
    const pending = fixture.host.execute(request);
    const signal = await Promise.race([
      started.promise,
      pending.then((result) => {
        throw new Error(
          `Action finished before dispatch: ${errorCode(result)}`,
        );
      }),
    ]);
    const canceled = await fixture.host.cancel(request);
    expect(signal.aborted).toBe(true);
    expect(fixture.wc.stop).toHaveBeenCalledTimes(1);
    expect(canceled.status).toBe("unknownOutcome");
    const result = await pending;
    expect(result.status).toBe("unknownOutcome");
    expect(await fixture.host.execute(request)).toEqual(result);
    expect(automation.act).toHaveBeenCalledTimes(1);
    expect(fixture.sessions.releaseExecution).toHaveBeenCalledTimes(2);
  });

  it.each(["inactive", "workspace", "skill"] as const)(
    "B04 aborts in-flight effects when polling finds changed %s authority",
    async (changed) => {
      const fixture = setup();
      await fixture.host.authorize({ threadId: "thread-1" });
      const observed = await observe(fixture.host);
      const started = deferred<AbortSignal>();
      automation.act.mockImplementation(
        (
          _input: unknown,
          _target: string,
          signal: AbortSignal,
          beforeEffect: () => void,
        ) => {
          beforeEffect();
          started.resolve(signal);
          return new Promise<void>((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new Error("browser_execution_canceled")),
              { once: true },
            ),
          );
        },
      );
      const pending = fixture.host.execute(
        command("crewon_browser_act", click(observed)),
      );
      const signal = await Promise.race([
        started.promise,
        pending.then((result) => {
          throw new Error(
            `Action finished before dispatch: ${errorCode(result)}`,
          );
        }),
      ]);
      const updated = runIdentity();
      if (changed === "inactive") updated.active = false;
      if (changed === "workspace")
        updated.workspaceBindingId = "workspace-other";
      if (changed === "skill")
        updated.skill = {
          ref: { ...ref, versionId: "version-other" },
          parameters: { date: "2026-09-14" },
        };
      fixture.authority.resolveRun.mockResolvedValue(updated);
      expect((await pending).status).toBe("unknownOutcome");
      expect(signal.aborted).toBe(true);
      expect(fixture.wc.stop).toHaveBeenCalledTimes(1);
    },
  );

  it("B04 trusted user input revokes the grant and stops the pending action", async () => {
    const fixture = setup();
    await fixture.host.authorize({ threadId: "thread-1" });
    const observed = await observe(fixture.host);
    const started = deferred<void>();
    automation.act.mockImplementation(
      (
        _input: unknown,
        _target: string,
        signal: AbortSignal,
        beforeEffect: () => void,
      ) => {
        beforeEffect();
        started.resolve(undefined);
        return new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new Error("browser_execution_canceled")),
            { once: true },
          ),
        );
      },
    );
    const pending = fixture.host.execute(
      command("crewon_browser_act", click(observed)),
    );
    await Promise.race([
      started.promise,
      pending.then((result) => {
        throw new Error(
          `Action finished before dispatch: ${errorCode(result)}`,
        );
      }),
    ]);
    fixture.wc.emit("before-input-event", {}, { type: "keyDown" });
    expect((await pending).status).toBe("unknownOutcome");
    expect(fixture.host.status("thread-1")).toBeNull();
    expect(fixture.wc.stop).toHaveBeenCalledTimes(1);
  });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "crewon-browser-host-"));
  let generation = 1;
  let mode = "idle";
  let url = origin;
  let lease: { leaseId: string; abort: AbortController } | null = null;
  const listeners = new Set<(reason: string) => void>();
  const wc = Object.assign(new EventEmitter(), {
    id: resources.length + 1,
    getURL: vi.fn(() => url),
    stop: vi.fn(),
    loadURL: vi.fn(async (next: string) => {
      url = next;
      generation++;
      sessions.revokeExecution("page-generation-changed");
    }),
    session: new EventEmitter(),
  });
  const sessions = {
    getExecutionSession: vi.fn((sessionId?: string) =>
      sessionId === undefined || sessionId === "session-1"
        ? {
            sessionId: "session-1",
            generation,
            mode,
            webContents: wc as unknown as WebContents,
          }
        : null,
    ),
    acquireExecution: vi.fn(
      (input: {
        sessionId: string;
        ownerId: string;
        expectedGeneration: number;
      }) => {
        if (
          input.sessionId !== "session-1" ||
          input.expectedGeneration !== generation ||
          mode !== "idle"
        )
          throw new Error("recording_execution_unavailable");
        lease = {
          leaseId: `lease-${commandSequence}`,
          abort: new AbortController(),
        };
        mode = "executing";
        return {
          leaseId: lease.leaseId,
          sessionId: "session-1",
          generation,
          signal: lease.abort.signal,
        };
      },
    ),
    releaseExecution: vi.fn((leaseId: string) => {
      if (lease?.leaseId === leaseId) sessions.revokeExecution("released");
    }),
    revokeExecution: vi.fn((reason: string) => {
      lease?.abort.abort(reason);
      lease = null;
      if (mode === "executing") mode = "idle";
      for (const listener of listeners) listener(reason);
    }),
    subscribeExecutionRevoked: (listener: (reason: string) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } satisfies BrowserSessionAccess;
  const authority = {
    checkThread: vi
      .fn<(threadId: string) => Promise<void>>()
      .mockResolvedValue(undefined),
    resolveRun: vi
      .fn<(runId: string) => Promise<BrowserRunIdentity>>()
      .mockResolvedValue(runIdentity()),
  };
  const host = new BrowserExecutionHost({
    sessions,
    authority,
    dataDirectory: directory,
    inspectionBundle: "test adapter is mocked",
  });
  resources.push({ host, directory });
  return {
    host,
    sessions,
    authority,
    wc,
    setMode: (next: string) => {
      mode = next;
    },
  };
}
function runIdentity(): BrowserRunIdentity {
  return {
    runId: "run-1",
    threadId: "thread-1",
    active: true,
    workspaceBindingId: "workspace-1",
    skill: { ref, parameters: { date: "2026-09-14" } },
  };
}
function scoped(): BrowserGrantScope {
  return {
    skillVersionRef: ref,
    origins: [origin],
    rules: [
      { action: "click", target: { role: "button", name: "导出 CSV" } },
      {
        action: "fill",
        target: { role: "textbox", name: "日期" },
        value: { parameter: "date" },
      },
    ],
  };
}
type ObservationLocator = {
  sessionId: string;
  generation: number;
  observationId: string;
};
async function observe(
  host: BrowserExecutionHost,
  runId = "run-1",
): Promise<ObservationLocator> {
  const result = await host.execute(
    command("crewon_browser_observe", {}, { runId }),
  );
  expect(errorCode(result)).toBeNull();
  if (result.status !== "completed")
    throw new Error("Expected completed observation");
  const { sessionId, generation, observationId } = JSON.parse(
    result.result.output,
  ) as ObservationLocator;
  return { sessionId, generation, observationId };
}
function click(observed: ObservationLocator): BrowserActInput {
  return {
    ...observed,
    action: "click",
    target: { targetId: "target-export" },
  };
}
function errorCode(result: ToolExecutionResolution): string | null {
  if (result.status !== "completed") return result.status;
  return result.result.isError
    ? (JSON.parse(result.result.output) as { code: string }).code
    : null;
}
function command(
  name:
    | "crewon_browser_observe"
    | "crewon_browser_act"
    | "crewon_browser_act_scoped",
  value: unknown = {},
  options: {
    executionId?: string;
    runId?: string;
    workspaceBindingId?: string | null;
  } = {},
): ToolExecutionCommand {
  const executionId = options.executionId ?? `execution-${++commandSequence}`;
  const runId = options.runId ?? "run-1";
  const input = JSON.stringify(value);
  const actionIntent: ActionIntent = {
    schemaVersion: "crewon.action-intent.v0",
    ...browserHostPolicy(name),
    runId,
    segmentId: "segment-1",
    callId: `call-${executionId}`,
    tool: { kind: "function", name, inputDigest: digest(input) },
    policySnapshotId: "policy-1",
    workspaceBindingId:
      options.workspaceBindingId === undefined
        ? "workspace-1"
        : options.workspaceBindingId,
  };
  const actionDigest = digest(canonicalActionIntent(actionIntent));
  return {
    schemaVersion: "crewon.tool-invocation.v0",
    idempotencyKey: `key-${executionId}`,
    runId,
    segmentId: actionIntent.segmentId,
    callId: actionIntent.callId,
    kind: "function",
    name,
    input,
    executionId,
    actionDigest,
    actionIntent,
    executionLease: {
      workItemId: "work-item-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    approvalProof:
      actionIntent.approvalRequirement === "none"
        ? null
        : {
            schemaVersion: "crewon.tool-approval-proof.v0",
            approvalId: "approval-1",
            actionDigest,
            policySnapshotId: actionIntent.policySnapshotId,
            approvalRevision: 2,
            decidedAt: "2026-09-14T00:00:00.000Z",
          },
  };
}
function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
