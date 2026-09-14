import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  AutomationApplicationService,
  ThreadApplicationService,
  type SkillInvocationPort,
  type DomainStore,
  type AutomationStore,
} from "@crewon/application";
import {
  createSkillVersion,
  renderSkillInvocationContext,
  SkillError,
  type SkillInvocationSpec,
} from "@crewon/domain";
import {
  InMemoryRunStore,
  SqliteRunStore,
  SqliteDemonstratedSkillStore,
} from "@crewon/store";
export const actor = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  actorId: "actor-1",
  principalId: "principal-1",
};
export const digest = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
export const route = {
  authorityId: "authority",
  runtimeGeneration: "generation",
  agentVersionId: "agent-version",
  policySnapshotId: "policy",
  workspaceBindingId: null,
};
export const version = createSkillVersion(
  {
    skillId: "skill-1",
    versionId: "version-1",
    createdAt: "2026-09-14T00:00:00.000Z",
    source: {
      recordingId: "fixture-recording",
      revision: 1,
      contentDigest: digest.sha256("fixture"),
      provenance: "contract-fixture",
    },
    method: {
      name: "Weekly export",
      purpose: "Export previous complete week",
      steps: ["Use the provided dates; export and verify the row count."],
      parameters: [
        { name: "start", label: "Start", type: "string", required: true },
        { name: "end", label: "End", type: "string", required: true },
      ],
      requiredToolRefs: ["browser"],
      completionCriteria: ["Row count verified"],
      knownExceptions: ["Request login when unavailable"],
      runtimeRequirements: ["Authorized browser"],
    },
  },
  digest,
);
export const spec: SkillInvocationSpec = {
  schemaVersion: "crewon.skill-invocation.v1",
  skill: version.ref,
  parameters: { start: "2026-08-31", end: "2026-09-06" },
  requiredToolRefs: ["browser"],
};

export async function setup(
  context: TestContext,
  backend: "memory" | "sqlite" = "memory",
) {
  const directory = mkdtempSync(join(tmpdir(), "f04-skill-schedule-"));
  let store: DomainStore & AutomationStore =
    backend === "sqlite"
      ? new SqliteRunStore(join(directory, "state.sqlite"))
      : new InMemoryRunStore();
  context.after(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  if (backend === "sqlite") {
    const authority = new SqliteDemonstratedSkillStore(
      join(directory, "state.sqlite"),
      digest,
    );
    const record = {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      ownerActorId: actor.actorId,
      skillId: version.ref.skillId,
      revision: 1,
      draft: version.method,
      source: version.source,
      disabled: false,
      deleted: false,
      activatedVersionIds: [] as string[],
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
    };
    await authority.saveSkill(record, 0);
    await authority.putVersion(record, version);
    await authority.saveSkill(
      { ...record, revision: 2, activatedVersionIds: [version.ref.versionId] },
      1,
    );
    await authority.close();
  }
  let now = "2026-09-13T16:05:00.000Z";
  let failure: string | null = null;
  let corrupt = false;
  const calls: { purpose: string; invocation: SkillInvocationSpec }[] = [];
  const port: SkillInvocationPort = {
    resolveVersion: async () => version,
    admitInvocation: async (_actor, invocation, options) => {
      calls.push({
        purpose: options.purpose,
        invocation: structuredClone(invocation),
      });
      if (failure) throw new SkillError(failure);
      const context = renderSkillInvocationContext(version, invocation);
      return {
        invocation,
        version,
        context: corrupt ? `${context}\nchanged` : context,
        agentVersionId: route.agentVersionId,
      };
    },
  };
  let sequence = 0;
  const ids = { nextId: (kind: string) => `${kind}-${++sequence}` };
  const services = (
    skills: SkillInvocationPort | undefined = port,
    serviceStore: DomainStore & AutomationStore = store,
  ) => {
    const common = {
      store: serviceStore,
      clock: { now: () => now },
      digester: digest,
      ids,
      authorization: { authorize: async () => ({ outcome: "allow" as const }) },
    };
    return {
      threads: new ThreadApplicationService(common),
      automations: new AutomationApplicationService({
        ...common,
        skills,
        routeResolver: { resolveRoute: async () => route },
      }),
    };
  };
  const initial = services();
  const thread = await initial.threads.createThread(actor, {
    kind: "thread.create",
    idempotencyKey: "thread-create",
    title: null,
  });
  const command = {
    kind: "automation.create" as const,
    idempotencyKey: "schedule-create",
    threadId: thread.state.threadId,
    expectedThreadRevision: 1,
    title: "Weekly export",
    prompt: "Use the fixed Skill",
    requestedAgentVersionId: null,
    executionMode: "scheduled" as const,
    schedule: {
      scheduleType: "weekly" as const,
      nextRunAt: "2026-09-06T16:00:00.000Z",
      intervalSeconds: 604800,
      time: "00:00",
      weekday: 1,
      timezone: "Asia/Shanghai",
    },
    skillInvocation: spec,
    parameterBindings: {
      start: "previousWeekStart",
      end: "previousWeekEnd",
    } as const,
  };
  return {
    get store() {
      return store;
    },
    services,
    command,
    calls,
    setFailure(code: string | null) {
      failure = code;
    },
    setCorrupt() {
      corrupt = true;
    },
    setNow(value: string) {
      now = value;
    },
    async restart() {
      if (backend === "sqlite") {
        await store.close();
        store = new SqliteRunStore(join(directory, "state.sqlite"));
      }
    },
    now: () => now,
  };
}
