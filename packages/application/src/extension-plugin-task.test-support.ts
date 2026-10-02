import { createHash } from "node:crypto";
import {
  createExtensionConfiguration,
  extensionCanonicalJson,
  parseExtensionManifest,
  reduceRunLifecycleEvent,
  reduceThreadLifecycleEvent,
  type ExtensionRunBinding,
  type PluginTaskAdmission,
  type PluginTaskAdmissionPin,
  type ThreadState,
} from "@crewon/domain";
import { extensionManifestFixture } from "../../domain/src/extension-manifest.test-support.ts";
import {
  ExtensionTaskApplicationService,
  type CreateExtensionTaskCommand,
} from "./extension-task-application-service.ts";
import type {
  CommitExtensionTurnInput,
  CommitExtensionTurnResult,
} from "./extension-store-port.ts";
import type { AuthorizationAction } from "./authorization-port.ts";

export const taskDigester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
export const taskActor = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  actorId: "actor-1",
  principalId: "principal-1",
};
export const taskPin: PluginTaskAdmissionPin = {
  ...taskActor,
  profileId: "profile-1",
  pluginId: "example.video",
  publisherId: "example.publisher",
  version: "1.0.0",
  packageDigest: taskDigester.sha256("independent-package"),
  selectionRevision: 2,
  contributionId: "workbench",
  action: "generate",
  authorityEpoch: "epoch-1",
};
export const taskCommand: CreateExtensionTaskCommand = {
  pluginId: taskPin.pluginId,
  threadId: "thread-1",
  expectedThreadRevision: 1,
  idempotencyKey: "user-intent-1",
  intent: { kind: "generate", input: { prompt: "A quiet city" } },
};
const at = "2026-10-02T00:00:00.000Z";
const target = {
  executionAuthority: "crewonKernel" as const,
  agentVersionId: "agent-1",
  agentVersionContentDigest: taskDigester.sha256("agent"),
  materializationDigest: taskDigester.sha256("materialization"),
  authorityId: "authority-1",
  runtimeGeneration: "runtime-1",
  policySnapshotId: "policy-1",
  workspaceBindingId: null,
};
const initialThread: ThreadState = {
  threadId: taskCommand.threadId,
  tenantId: taskActor.tenantId,
  spaceId: taskActor.spaceId,
  createdByActorId: taskActor.actorId,
  title: null,
  status: "active",
  revision: 1,
  lastEventSequence: 1,
  lastMessageSequence: 0,
  forkedFromThreadId: null,
  forkedThroughHistorySequence: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  deletedAt: null,
  deletedByActorId: null,
};
type Deps = ConstructorParameters<typeof ExtensionTaskApplicationService>[0];

/** Application-only doubles: this does not prove SQL atomicity, a real Worker, supplier execution or pricing policy. */
export function pluginTaskFixture() {
  const manifest = parseExtensionManifest(
    extensionManifestFixture(taskPin.pluginId),
  );
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: taskActor.tenantId,
      spaceId: taskActor.spaceId,
      pluginId: taskPin.pluginId,
      revision: 1,
      pluginVersion: manifest.version,
      manifestDigest: taskDigester.sha256(extensionCanonicalJson(manifest)),
      implementationDigest: taskDigester.sha256("existing-runtime"),
      parameters: { format: "mp4" },
      credentialBindings: [
        { slotId: "provider", credentialBindingId: "provider-1" },
      ],
      createdByActorId: taskActor.actorId,
      createdAt: at,
    },
    taskDigester,
  );
  const state = {
    permissions: [] as AuthorizationAction[],
    denied: null as AuthorizationAction | null,
    commits: [] as CommitExtensionTurnInput[],
    receipts: new Map<
      string,
      { digest: string; result: CommitExtensionTurnResult }
    >(),
    admissions: new Map<string, PluginTaskAdmission>(),
    ids: 0,
    clocks: 0,
    quoteCalls: 0,
    receiptReads: 0,
    admissionReads: 0,
    configurationReads: 0,
    onQuote: null as null | (() => void | Promise<void>),
    onReceipt: null as null | (() => void | Promise<void>),
    quote: {
      poolId: "personal-plugin-pool",
      priceRevision: 1,
      quotedCredits: "3",
    },
    commitError: null as Error | null,
  };
  const replay = (
    saved: CommitExtensionTurnResult,
  ): CommitExtensionTurnResult => ({
    ...structuredClone(saved),
    turn: { ...structuredClone(saved.turn), disposition: "replayed" },
    run: { ...structuredClone(saved.run), disposition: "replayed" },
  });
  const store = {
    async loadThreadInSpace() {
      return structuredClone(initialThread);
    },
    async loadThread() {
      return structuredClone(initialThread);
    },
    async listThreads() {
      return [];
    },
    async listThreadEvents() {
      return [];
    },
    async listMessages() {
      return [];
    },
    async commitThread(): Promise<never> {
      throw new Error("unused");
    },
    async loadThreadGoal() {
      return null;
    },
    async loadModelHistoryHead() {
      return {
        tenantId: taskActor.tenantId,
        threadId: taskCommand.threadId,
        lastSequence: 0,
      };
    },
    async listModelHistoryItems() {
      return [];
    },
    async loadTurnStartReceipt() {
      return null;
    },
    async commitTurnStart(): Promise<never> {
      throw new Error("unbound-turn-forbidden");
    },
    async loadRunInSpace() {
      return null;
    },
  } satisfies Deps["store"];
  const extensions = {
    pluginAdmissionVersion: "crewon.plugin-task-admission.v1" as const,
    creditAdmissionVersion: "crewon.extension-credit-admission.v0" as const,
    async loadExtensionTurnReceipt(input) {
      state.receiptReads++;
      await state.onReceipt?.();
      const previous = state.receipts.get(input.receipt.idempotencyKey);
      if (!previous) return null;
      if (previous.digest !== input.receipt.requestDigest)
        throw new Error("extension_idempotency_conflict");
      return replay(previous.result);
    },
    async loadPluginTaskAdmission(input) {
      state.admissionReads++;
      return structuredClone(state.admissions.get(input.runId) ?? null);
    },
    async loadExtensionActivation() {
      return {
        schemaVersion: "crewon.extension-activation.v0" as const,
        tenantId: taskActor.tenantId,
        spaceId: taskActor.spaceId,
        pluginId: taskPin.pluginId,
        revision: 1,
        configurationRevision: 1,
        configurationDigest: configuration.contentDigest,
        state: "enabled" as const,
        target,
        updatedByActorId: taskActor.actorId,
        updatedAt: at,
      };
    },
    async loadExtensionConfiguration() {
      state.configurationReads++;
      return configuration;
    },
    async commitExtensionTurn(input) {
      state.commits.push(structuredClone(input));
      if (state.commitError) throw state.commitError;
      const previous = state.receipts.get(input.receipt.idempotencyKey);
      if (previous) {
        if (previous.digest !== input.receipt.requestDigest)
          throw new Error("extension_idempotency_conflict");
        return replay(previous.result);
      }
      let thread: ThreadState | null = initialThread;
      for (const event of input.turn.thread.events)
        thread = reduceThreadLifecycleEvent(thread, event);
      let run = null;
      for (const event of input.turn.run.events)
        run = reduceRunLifecycleEvent(run, event);
      if (!thread || !run) throw new Error("invalid-test-events");
      const turn = {
        disposition: "committed" as const,
        threadState: thread,
        runState: run,
        goalState: null,
        threadEvents: input.turn.thread.events,
        messages: input.turn.thread.messages,
        historyItems: input.turn.thread.history.items,
        runEvents: input.turn.run.events,
        outbox: input.turn.run.outbox,
        workItems: input.turn.run.workItems,
      };
      const result: CommitExtensionTurnResult = {
        schemaVersion: "crewon.extension-turn-admission.v0",
        turn,
        run: {
          disposition: "committed",
          state: run,
          events: turn.runEvents,
          outbox: turn.outbox,
          workItems: turn.workItems,
        },
        binding: input.binding,
        ...(input.creditAdmission === undefined
          ? {}
          : { creditAdmission: input.creditAdmission }),
      };
      if (input.pluginAdmission)
        state.admissions.set(
          input.binding.runId,
          structuredClone(input.pluginAdmission),
        );
      state.receipts.set(input.receipt.idempotencyKey, {
        digest: input.receipt.requestDigest,
        result,
      });
      return result;
    },
    async loadExtensionRunBinding(): Promise<ExtensionRunBinding | null> {
      return null;
    },
    async loadLatestExtensionConfiguration() {
      return null;
    },
    async loadExtensionConfigurationReceipt() {
      return null;
    },
    async loadExtensionActivationReceipt() {
      return null;
    },
    async loadExtensionRunReceipt() {
      return null;
    },
    async saveExtensionConfiguration(): Promise<never> {
      throw new Error("unused");
    },
    async saveExtensionActivation(): Promise<never> {
      throw new Error("unused");
    },
    async commitExtensionRun(): Promise<never> {
      throw new Error("unused");
    },
  } satisfies Deps["extensions"];
  const dependencies: Deps = {
    store,
    extensions,
    operations: {
      async loadExternalOperation() {
        return null;
      },
      async reserveExternalOperation(): Promise<never> {
        throw new Error("unused");
      },
      async advanceExternalOperation(): Promise<never> {
        throw new Error("unused");
      },
    },
    authorization: {
      async authorize(request) {
        state.permissions.push(request.action);
        return request.action === state.denied
          ? { outcome: "deny", reasonCode: "denied" }
          : { outcome: "allow" };
      },
    },
    catalog: {
      list: () => [],
      resolve: () => ({
        manifest,
        manifestDigest: configuration.manifestDigest,
        implementationDigest: configuration.implementationDigest,
      }),
    },
    host: {
      async validateConfiguration() {},
      async evaluate() {
        return { outcome: "ready", target };
      },
    },
    clock: {
      now() {
        state.clocks++;
        return at;
      },
    },
    ids: {
      nextId(kind) {
        return `${kind}-${++state.ids}`;
      },
    },
    digester: taskDigester,
    creditQuotes: {
      async quoteGeneration() {
        state.quoteCalls++;
        await state.onQuote?.();
        return structuredClone(state.quote);
      },
    },
  };
  return {
    state,
    dependencies,
    extensions,
    create: (patch: Partial<Deps> = {}) =>
      new ExtensionTaskApplicationService({ ...dependencies, ...patch }),
  };
}
