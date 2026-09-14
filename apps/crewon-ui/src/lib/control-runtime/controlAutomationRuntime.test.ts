import { describe, expect, it, vi } from "vitest";
import {
  ControlApiClient,
  ControlApiClientError,
} from "@crewon/control-client";
import type {
  AutomationView,
  RunView,
  SkillInvocationSpec,
} from "@crewon/contracts";

import { ControlAutomationRuntime } from "./controlAutomationRuntime";
import { scheduleSkillInvocation } from "../../components/app/automationSkill.test-support";

describe("ControlAutomationRuntime", () => {
  it("propagates the authority AbortSignal through paginated list requests", async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | null | undefined> = [];
    const runtime = new ControlAutomationRuntime({
      client: client(async (_input, init = {}) => {
        signals.push(init.signal);
        return json({ data: [], nextCursor: null });
      }),
      adopter: { adoptAutomationRun: async () => undefined },
    });

    await runtime.listAutomations({ signal: controller.signal });

    expect(signals).toEqual([controller.signal]);
  });

  it("retries an unknown run-now outcome with the same key and adopts its Run SSE", async () => {
    const requests: Array<{ url: string; key: string | null }> = [];
    let runAttempts = 0;
    const adopted: Array<{ automation: AutomationView; run: RunView }> = [];
    const runtime = new ControlAutomationRuntime({
      client: client(async (input, init = {}) => {
        const url = String(input);
        requests.push({
          url,
          key: new Headers(init.headers).get("idempotency-key"),
        });
        if (url.endsWith("/automations/automation-1")) {
          return json({ automation: automation() });
        }
        if (url.endsWith("/threads/thread-1")) {
          return json(threadResponse());
        }
        if (url.endsWith("/automations/automation-1:run-now")) {
          runAttempts += 1;
          if (runAttempts === 1) {
            throw new TypeError("connection reset after commit");
          }
          return json({
            disposition: "replayed",
            automation: automation(),
            invocation: { automationId: "automation-1", runId: "run-1" },
            run: run(),
          });
        }
        throw new Error(`unexpected request ${url}`);
      }),
      adopter: {
        async adoptAutomationRun(nextAutomation, nextRun) {
          adopted.push({ automation: nextAutomation, run: nextRun });
        },
      },
      idempotencyKey: () => "same-run-key",
    });

    const result = await runtime.runAutomationNow("automation-1");

    expect(result.disposition).toBe("replayed");
    expect(
      requests
        .filter(({ url }) => url.endsWith(":run-now"))
        .map(({ key }) => key),
    ).toEqual(["same-run-key", "same-run-key"]);
    expect(adopted).toEqual([{ automation: automation(), run: run() }]);
    expect(requests.some(({ url }) => url.includes("/runs?"))).toBe(false);
  });

  it("retries a malformed create success with the same key and accepts the receipt replay", async () => {
    const keys: Array<string | null> = [];
    let attempts = 0;
    const runtime = new ControlAutomationRuntime({
      client: client(async (input, init = {}) => {
        const url = String(input);
        if (url.endsWith("/threads/thread-1")) {
          return json(threadResponse());
        }
        if (url.endsWith("/automations")) {
          attempts += 1;
          keys.push(new Headers(init.headers).get("idempotency-key"));
          return json({
            disposition: attempts === 1 ? "committed" : "replayed",
            automation:
              attempts === 1
                ? { ...automation(), title: "substituted" }
                : automation(),
          });
        }
        throw new Error(`unexpected request ${url}`);
      }),
      adopter: { adoptAutomationRun: async () => undefined },
      idempotencyKey: () => "same-create-key",
    });

    await expect(
      runtime.createAutomation({
        threadId: "thread-1",
        title: "Review changes",
        prompt: "Review the current changes.",
        agentVersionId: "agent-version-1",
        schedule: null,
      }),
    ).resolves.toEqual(automation());
    expect(keys).toEqual(["same-create-key", "same-create-key"]);
  });

  it("retries a malformed run success with the same key and adopts only the valid replay", async () => {
    const keys: Array<string | null> = [];
    let attempts = 0;
    const adopter = { adoptAutomationRun: vi.fn(async () => undefined) };
    const runtime = new ControlAutomationRuntime({
      client: client(async (input, init = {}) => {
        const url = String(input);
        if (url.endsWith("/automations/automation-1")) {
          return json({ automation: automation() });
        }
        if (url.endsWith("/threads/thread-1")) {
          return json(threadResponse());
        }
        if (url.endsWith(":run-now")) {
          attempts += 1;
          keys.push(new Headers(init.headers).get("idempotency-key"));
          return json({
            disposition: attempts === 1 ? "committed" : "replayed",
            automation: automation(),
            invocation: {
              automationId: "automation-1",
              runId: attempts === 1 ? "run-substituted" : "run-1",
            },
            run: run(),
          });
        }
        throw new Error(`unexpected request ${url}`);
      }),
      adopter,
      idempotencyKey: () => "same-run-key",
    });

    await expect(runtime.runAutomationNow("automation-1")).resolves.toEqual({
      disposition: "replayed",
      automation: automation(),
      invocation: { automationId: "automation-1", runId: "run-1" },
      run: run(),
    });
    expect(keys).toEqual(["same-run-key", "same-run-key"]);
    expect(adopter.adoptAutomationRun).toHaveBeenCalledOnce();
  });

  it("rehydrates Automation and Thread on an explicit conflict", async () => {
    let automationReads = 0;
    let threadReads = 0;
    const runtime = new ControlAutomationRuntime({
      client: client(async (input) => {
        const url = String(input);
        if (url.endsWith("/automations/automation-1")) {
          automationReads += 1;
          return json({ automation: automation() });
        }
        if (url.endsWith("/threads/thread-1")) {
          threadReads += 1;
          return json(threadResponse());
        }
        if (url.endsWith("/automations/automation-1:run-now")) {
          return json(
            {
              error: {
                category: "conflict",
                code: "thread_revision_conflict",
                message: "conflict",
                requestId: "request-1",
              },
            },
            409,
          );
        }
        throw new Error(`unexpected request ${url}`);
      }),
      adopter: { adoptAutomationRun: async () => undefined },
      idempotencyKey: () => "conflict-key",
    });

    await expect(runtime.runAutomationNow("automation-1")).rejects.toEqual(
      expect.objectContaining<Partial<ControlApiClientError>>({
        status: 409,
        category: "conflict",
      }),
    );
    expect({ automationReads, threadReads }).toEqual({
      automationReads: 2,
      threadReads: 2,
    });
  });

  it("lists only Automation definitions and rejects injected public fields", async () => {
    const urls: string[] = [];
    const runtime = new ControlAutomationRuntime({
      client: client(async (input) => {
        urls.push(String(input));
        return json({
          data: [{ ...automation(), routeDigest: "private" }],
          nextCursor: null,
        });
      }),
      adopter: { adoptAutomationRun: async () => undefined },
    });

    await expect(runtime.listAutomations()).rejects.toThrow(
      "control_automation_view_invalid",
    );
    expect(urls).toEqual([
      "https://control.example/api/v1/automations?limit=100",
    ]);
  });

  it.each([1_000, 1_001])(
    "continues safe cursor pagination across %i Automation definitions",
    async (total) => {
      const definitions = Array.from({ length: total }, (_, index) =>
        automation({ automationId: `automation-${index + 1}` }),
      );
      const controlClient = client(async () => {
        throw new Error("unexpected network request");
      });
      Object.assign(controlClient, {
        listAutomations: vi.fn(async (query: { cursor?: string }) => {
          const page =
            query.cursor === undefined
              ? 0
              : Number(query.cursor.slice("cursor_".length));
          const start = page * 100;
          const end = Math.min(start + 100, definitions.length);
          return {
            data: definitions.slice(start, end),
            nextCursor: end - start === 100 ? `cursor_${page + 1}` : null,
          };
        }),
      });
      const runtime = new ControlAutomationRuntime({
        client: controlClient,
        adopter: { adoptAutomationRun: async () => undefined },
      });

      await expect(runtime.listAutomations()).resolves.toHaveLength(total);
      expect(controlClient.listAutomations).toHaveBeenCalledTimes(11);
    },
  );

  it("fails closed on a repeated Automation cursor", async () => {
    const controlClient = client(async () => {
      throw new Error("unexpected network request");
    });
    Object.assign(controlClient, {
      listAutomations: vi.fn(async () => ({
        data: [automation()],
        nextCursor: "cursor_repeat",
      })),
    });
    const runtime = new ControlAutomationRuntime({
      client: controlClient,
      adopter: { adoptAutomationRun: async () => undefined },
    });

    await expect(runtime.listAutomations()).rejects.toMatchObject({
      code: "control_automation_list_cursor_repeated",
    });
  });

  it("fails closed on a Thread snapshot cursor mismatch before Automation mutation", async () => {
    const controlClient = client(async (input) => {
      const url = String(input);
      if (url.endsWith("/automations/automation-1")) {
        return json({ automation: automation() });
      }
      throw new Error(`unexpected request ${url}`);
    });
    Object.assign(controlClient, {
      getThread: async () => ({
        ...threadResponse(),
        eventSequence: 1,
      }),
    });
    const adopter = { adoptAutomationRun: vi.fn(async () => undefined) };
    const runtime = new ControlAutomationRuntime({
      client: controlClient,
      adopter,
    });

    await expect(runtime.runAutomationNow("automation-1")).rejects.toThrow(
      "control_automation_thread_response_invalid",
    );
    expect(adopter.adoptAutomationRun).not.toHaveBeenCalled();
  });
});

describe("ControlAutomationRuntime Skill schedule compatibility", () => {
  it("reads prompt-only and fixed-version definitions in the same list", async () => {
    const skill = automation({
      automationId: "automation-skill",
      skillInvocation: scheduleSkillInvocation(),
      parameterBindings: { date: "previousWeekStart" },
    });
    const runtime = new ControlAutomationRuntime({
      client: client(async () =>
        json({ data: [automation(), skill], nextCursor: null }),
      ),
      adopter: { adoptAutomationRun: async () => undefined },
    });
    await expect(runtime.listAutomations()).resolves.toEqual([
      automation(),
      skill,
    ]);
  });

  it.each([
    { skillInvocation: null },
    { skillInvocation: { ...scheduleSkillInvocation(), unexpected: true } },
    {
      skillInvocation: {
        ...scheduleSkillInvocation(),
        parameters: { nested: { secret: true } },
      },
    },
    {
      skillInvocation: {
        ...scheduleSkillInvocation(),
        skill: { ...scheduleSkillInvocation().skill, versionId: "latest" },
      },
    },
    {
      skillInvocation: {
        ...scheduleSkillInvocation(),
        deliveryTarget: {
          ...scheduleSkillInvocation().deliveryTarget,
          threadId: "other-thread",
        },
      },
    },
    { parameterBindings: { date: "runDate" } },
    {
      skillInvocation: scheduleSkillInvocation(),
      parameterBindings: { count: "runDate" },
    },
    {
      skillInvocation: scheduleSkillInvocation(),
      parameterBindings: { date: "tomorrow" },
    },
    { skillReadiness: { state: "ready", code: null } },
    {
      skillInvocation: scheduleSkillInvocation(),
      skillReadiness: { state: "ready", code: "skill_access_denied" },
    },
    {
      skillInvocation: scheduleSkillInvocation(),
      skillReadiness: { state: "blocked", code: null },
    },
    {
      skillInvocation: scheduleSkillInvocation(),
      skillReadiness: {
        state: "blocked",
        code: "skill_access_denied",
        privateContext: "hidden",
      },
    },
  ])("rejects malformed Skill schedule transport %#", async (invalid) => {
    const runtime = new ControlAutomationRuntime({
      client: client(async () =>
        json({ data: [{ ...automation(), ...invalid }], nextCursor: null }),
      ),
      adopter: { adoptAutomationRun: async () => undefined },
    });
    await expect(runtime.listAutomations()).rejects.toThrow(
      "control_automation_view_invalid",
    );
  });

  it("sends a fixed snapshot and retries a substituted binding with the same receipt key", async () => {
    const invocation = scheduleSkillInvocation();
    const original = structuredClone(invocation);
    const commands: unknown[] = [];
    const keys: (string | null)[] = [];
    const runtime = new ControlAutomationRuntime({
      client: client(async (input, init = {}) => {
        if (String(input).endsWith("/threads/thread-1")) {
          invocation.skill.versionId = "version-2";
          return json(threadResponse());
        }
        commands.push(JSON.parse(String(init.body)));
        keys.push(new Headers(init.headers).get("idempotency-key"));
        return json({
          disposition: commands.length === 1 ? "committed" : "replayed",
          automation: automation({
            skillInvocation: original,
            parameterBindings: {
              date: commands.length === 1 ? "runDate" : "previousWeekStart",
            },
          }),
        });
      }),
      adopter: { adoptAutomationRun: async () => undefined },
      idempotencyKey: () => "same-skill-key",
    });
    await expect(
      runtime.createAutomation({
        threadId: "thread-1",
        title: "Review changes",
        prompt: "Review the current changes.",
        agentVersionId: "agent-version-1",
        schedule: null,
        skillInvocation: invocation,
        parameterBindings: { date: "previousWeekStart" },
      }),
    ).resolves.toMatchObject({
      skillInvocation: original,
      parameterBindings: { date: "previousWeekStart" },
    });
    expect(keys).toEqual(["same-skill-key", "same-skill-key"]);
    expect(commands).toEqual([
      expect.objectContaining({ skillInvocation: original }),
      expect.objectContaining({ skillInvocation: original }),
    ]);
  });

  it("freezes the explicit approval mode across Thread preparation and mismatched receipt retry", async () => {
    const intent = {
      threadId: "thread-1",
      title: "Review changes",
      prompt: "Review the current changes.",
      agentVersionId: "agent-version-1",
      schedule: null,
      skillInvocation: scheduleSkillInvocation(),
      toolPermissionMode: "approveForMe" as const,
    };
    const commands: unknown[] = [];
    const keys: Array<string | null> = [];
    const runtime = new ControlAutomationRuntime({
      client: client(async (input, init = {}) => {
        if (String(input).endsWith("/threads/thread-1")) {
          Object.assign(intent, { toolPermissionMode: "requestApproval" });
          return json(threadResponse());
        }
        commands.push(JSON.parse(String(init.body)));
        keys.push(new Headers(init.headers).get("idempotency-key"));
        return json({
          disposition: commands.length === 1 ? "committed" : "replayed",
          automation: automation({
            skillInvocation: scheduleSkillInvocation(),
            toolPermissionMode:
              commands.length === 1 ? "requestApproval" : "approveForMe",
          }),
        });
      }),
      adopter: { adoptAutomationRun: async () => undefined },
      idempotencyKey: () => "mode-key",
    });
    await expect(runtime.createAutomation(intent)).resolves.toMatchObject({
      toolPermissionMode: "approveForMe",
    });
    expect(keys).toEqual(["mode-key", "mode-key"]);
    expect(commands).toEqual([
      expect.objectContaining({ toolPermissionMode: "approveForMe" }),
      expect.objectContaining({ toolPermissionMode: "approveForMe" }),
    ]);
  });

  it.each(["fullAccess", null, undefined])(
    "rejects invalid explicit approval mode %s before network access",
    async (mode) => {
      const fetch = vi.fn(async () => json(threadResponse()));
      const runtime = new ControlAutomationRuntime({
        client: client(fetch),
        adopter: { adoptAutomationRun: async () => undefined },
      });
      await expect(
        runtime.createAutomation({
          threadId: "thread-1",
          title: "Review changes",
          prompt: "Review changes",
          agentVersionId: null,
          schedule: null,
          skillInvocation: scheduleSkillInvocation(),
          toolPermissionMode: mode,
        } as unknown as Parameters<
          ControlAutomationRuntime["createAutomation"]
        >[0]),
      ).rejects.toThrow("control_automation_create_intent_invalid");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects approval mode on legacy prompt-only requests before network access", async () => {
    const fetch = vi.fn(async () => json(threadResponse()));
    const runtime = new ControlAutomationRuntime({
      client: client(fetch),
      adopter: { adoptAutomationRun: async () => undefined },
    });
    await expect(
      runtime.createAutomation({
        threadId: "thread-1",
        title: "Review changes",
        prompt: "Review changes",
        agentVersionId: null,
        schedule: null,
        toolPermissionMode: "approveForMe",
      }),
    ).rejects.toThrow("control_automation_create_intent_invalid");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["version", "parameter", "target", "binding", "permission"])(
    "never adopts a Run whose %s has drifted",
    async (drift) => {
      const pinned = automation({
        skillInvocation: scheduleSkillInvocation(),
        parameterBindings: { date: "runDate" },
      });
      const changed = structuredClone(pinned);
      const changedInvocation = changed.skillInvocation as SkillInvocationSpec;
      if (drift === "version") changedInvocation.skill.versionId = "version-2";
      if (drift === "parameter") changedInvocation.parameters.count = 100;
      if (drift === "target" && changedInvocation.deliveryTarget)
        changedInvocation.deliveryTarget.spaceId = "space-other";
      if (drift === "binding")
        changed.parameterBindings = { date: "previousWeekEnd" };
      if (drift === "permission") changed.toolPermissionMode = "approveForMe";
      const adopter = { adoptAutomationRun: vi.fn(async () => undefined) };
      const keys: (string | null)[] = [];
      const runtime = new ControlAutomationRuntime({
        client: client(async (input, init = {}) => {
          const url = String(input);
          if (url.endsWith("/automations/automation-1"))
            return json({ automation: pinned });
          if (url.endsWith("/threads/thread-1")) return json(threadResponse());
          keys.push(new Headers(init.headers).get("idempotency-key"));
          return json({
            disposition: "committed",
            automation: changed,
            invocation: { automationId: "automation-1", runId: "run-1" },
            run: run(),
          });
        }),
        adopter,
        idempotencyKey: () => "fixed-run-key",
      });
      await expect(runtime.runAutomationNow("automation-1")).rejects.toThrow(
        "control_automation_run_response_invalid",
      );
      expect(keys).toEqual(["fixed-run-key", "fixed-run-key"]);
      expect(adopter.adoptAutomationRun).not.toHaveBeenCalled();
    },
  );

  it("rejects a mismatched delivery thread before issuing any request", async () => {
    const fetch = vi.fn(async () => json(threadResponse()));
    const runtime = new ControlAutomationRuntime({
      client: client(fetch),
      adopter: { adoptAutomationRun: async () => undefined },
    });
    await expect(
      runtime.createAutomation({
        threadId: "thread-other",
        title: "Report",
        prompt: "Run Skill",
        agentVersionId: null,
        schedule: null,
        skillInvocation: scheduleSkillInvocation(),
      }),
    ).rejects.toThrow("control_automation_create_intent_invalid");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts a Run after readiness recovers while the fixed binding remains unchanged", async () => {
    const pinned = automation({
      skillInvocation: scheduleSkillInvocation(),
      skillReadiness: {
        state: "blocked",
        code: "skill_dependency_unavailable",
      },
    });
    const recovered = {
      ...pinned,
      skillReadiness: { state: "ready" as const, code: null },
    };
    const adopter = { adoptAutomationRun: vi.fn(async () => undefined) };
    const runtime = new ControlAutomationRuntime({
      client: client(async (input) => {
        const url = String(input);
        if (url.endsWith("/automations/automation-1"))
          return json({ automation: pinned });
        if (url.endsWith("/threads/thread-1")) return json(threadResponse());
        return json({
          disposition: "committed",
          automation: recovered,
          invocation: { automationId: "automation-1", runId: "run-1" },
          run: run(),
        });
      }),
      adopter,
    });
    await expect(
      runtime.runAutomationNow("automation-1"),
    ).resolves.toMatchObject({ automation: recovered });
    expect(adopter.adoptAutomationRun).toHaveBeenCalledOnce();
  });
});

function client(fetch: typeof globalThis.fetch): ControlApiClient {
  return new ControlApiClient({
    baseUrl: "https://control.example/",
    csrfToken: "csrf-token",
    fetch,
  });
}

function automation(overrides: Partial<AutomationView> = {}): AutomationView {
  return {
    automationId: "automation-1",
    threadId: "thread-1",
    title: "Review changes",
    prompt: "Review the current changes.",
    agentVersionId: "agent-version-1",
    executionMode: "manualOnly",
    automaticScheduling: false,
    schedule: {
      scheduleType: "once",
      nextRunAt: "9999-12-31T23:59:59Z",
      intervalSeconds: 0,
      time: "00:00",
      weekday: 0,
      timezone: "UTC",
    },
    revision: 1,
    createdAt: "2026-08-09T00:00:00Z",
    updatedAt: "2026-08-09T00:00:00Z",
    ...overrides,
  };
}

function run(): RunView {
  return {
    runId: "run-1",
    threadId: "thread-1",
    status: "queued",
    revision: 1,
    lastSequence: 1,
    cancelRequested: false,
    waitingApproval: null,
    collaborationMode: "default",
    purpose: "turn",
    workflowVersionBinding: null,
    goalBinding: null,
    outputRef: null,
    failure: null,
    createdAt: "2026-08-09T00:00:01Z",
    updatedAt: "2026-08-09T00:00:01Z",
    terminalAt: null,
  };
}

function threadResponse() {
  return {
    eventSequence: 2,
    thread: {
      threadId: "thread-1",
      status: "active" as const,
      revision: 2,
      title: "Review thread",
      lastMessageSequence: 0,
      forkedFromThreadId: null,
      forkedThroughHistorySequence: null,
      createdAt: "2026-08-09T00:00:00Z",
      updatedAt: "2026-08-09T00:00:00Z",
      archivedAt: null,
      deletedAt: null,
    },
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
