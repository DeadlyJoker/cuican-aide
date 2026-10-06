import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  captureProjectMediaInputRunCommitTransaction,
  projectMediaInputRunCommand,
  parseProjectToolInstallationPin,
  ProjectMediaInputApplicationService,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  extensionToolName,
  parseProjectMediaInputStageRunAdmission,
  assertProjectMediaInputStageToolRequest,
  parsePluginTaskAdmission,
  validateCreativeProjectActor,
  type ProjectMediaInputStageRunAdmission,
  type PluginTaskAdmission,
} from "@crewon/domain";
import {
  PROJECT_MEDIA_INPUT_TOOLS_SERVICE,
  PROJECT_MEDIA_INPUT_TOOLS_API_VERSION,
  MEDIA_INPUT_TOOL_METHODS,
  parseMediaInputToolCommand,
  parseMediaInputToolRequest,
  parseMediaInputToolResponse,
  type PluginProjectMediaInputToolsService,
  type MediaInputToolMethod,
  type MediaInputToolCommand,
} from "@crewon/contracts/project-media-input-tools";
import type { PluginHostService } from "@crewon/plugin-host";
import type { ToolExecutionCommand } from "@crewon/tool-broker";
import { assertWorkerToolDispatchEvidence } from "./worker-tool-dispatch-authority.ts";
import type {
  ProjectToolsServiceOwnerDependencies,
  ProjectToolsDispatchInvocation,
} from "./project-tools-service-owner.ts";
import {
  mediaInputMetadata,
  mediaInputPromptChunk,
  proveMediaInputSaveAck,
} from "./project-media-input-tools-projection.ts";

export type ProjectMediaInputToolsServiceOwnerDependencies = Pick<
  ProjectToolsServiceOwnerDependencies,
  | "context"
  | "admission"
  | "tools"
  | "runs"
  | "installations"
  | "authorization"
  | "resolveActor"
  | "authorizeCurrent"
  | "authorizeTransaction"
  | "assertActive"
  | "now"
> &
  Readonly<{
    inputs: ProjectMediaInputApplicationService;
    mediaInputStageAdmission: ProjectMediaInputStageRunAdmission;
    stages: Pick<
      import("@crewon/application").ProjectMediaInputStageStore,
      "loadMediaInputStageAdmission" | "readRequiredMediaInputStageDigest"
    >;
    conversations: Pick<
      import("@crewon/application").ProjectConversationStore,
      "loadBinding"
    >;
    /** Independent deployment grant; UI and general execution grants cannot substitute. */
    authorizeMediaInputService(signal: AbortSignal): Promise<void>;
  }>;
type Invocation = ProjectToolsDispatchInvocation & {
  live: boolean;
  pending: Set<Promise<unknown>>;
};
const sha = Object.freeze({
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
});
/** One resident service for preparing shared logical inputs. It cannot upload, generate or adopt media. */
export class ProjectMediaInputToolsServiceOwner {
  readonly #d: ProjectMediaInputToolsServiceOwnerDependencies;
  readonly #stage: ProjectMediaInputStageRunAdmission;
  readonly #inputs: ProjectMediaInputApplicationService;
  readonly #service: PluginProjectMediaInputToolsService;
  readonly #invocations = new WeakMap<object, Invocation>();
  readonly #active = new Set<Invocation>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #abort = new AbortController();
  #closed = false;
  #closing: Promise<void> | undefined;
  constructor(input: ProjectMediaInputToolsServiceOwnerDependencies) {
    if (
      !(input.inputs instanceof ProjectMediaInputApplicationService) ||
      types.isProxy(input.inputs) ||
      typeof input.authorizeMediaInputService !== "function"
    )
      denied();
    const admission = parsePluginTaskAdmission(input.admission);
    this.#d = Object.freeze({
      ...input,
      admission,
      resolveActor: input.resolveActor.bind(input),
      authorizeCurrent: input.authorizeCurrent.bind(input),
      authorizeTransaction: input.authorizeTransaction.bind(input),
      authorizeMediaInputService: input.authorizeMediaInputService.bind(input),
      assertActive: input.assertActive.bind(input),
      stages: Object.freeze({
        loadMediaInputStageAdmission: bound(
          input.stages,
          "loadMediaInputStageAdmission",
        ) as ProjectMediaInputToolsServiceOwnerDependencies["stages"]["loadMediaInputStageAdmission"],
        readRequiredMediaInputStageDigest: bound(
          input.stages,
          "readRequiredMediaInputStageDigest",
        ) as ProjectMediaInputToolsServiceOwnerDependencies["stages"]["readRequiredMediaInputStageDigest"],
      }),
      conversations: Object.freeze({
        loadBinding: bound(
          input.conversations,
          "loadBinding",
        ) as ProjectMediaInputToolsServiceOwnerDependencies["conversations"]["loadBinding"],
      }),
      runs: Object.freeze({
        loadRunInSpace: bound(
          input.runs,
          "loadRunInSpace",
        ) as ProjectMediaInputToolsServiceOwnerDependencies["runs"]["loadRunInSpace"],
      }),
      installations: Object.freeze({
        loadSelection: bound(
          input.installations,
          "loadSelection",
        ) as ProjectMediaInputToolsServiceOwnerDependencies["installations"]["loadSelection"],
        loadPackage: bound(
          input.installations,
          "loadPackage",
        ) as ProjectMediaInputToolsServiceOwnerDependencies["installations"]["loadPackage"],
      }),
      authorization: Object.freeze({
        authorize: bound(
          input.authorization,
          "authorize",
        ) as ProjectMediaInputToolsServiceOwnerDependencies["authorization"]["authorize"],
      }),
    });
    this.#inputs = input.inputs;
    this.#stage = parseProjectMediaInputStageRunAdmission(
      input.mediaInputStageAdmission,
      sha,
    );
    if (
      this.#stage !== null &&
      (this.#stage.runId !== input.admission.runId ||
        this.#stage.threadId !== input.admission.threadId ||
        this.#stage.pluginTaskAdmissionDigest !==
          sha.sha256(extensionCanonicalJson(input.admission)) ||
        this.#stage.extensionBindingDigest !==
          input.context.run.bindingDigest ||
        this.#stage.userContentDigest !== input.context.run.inputDigest)
    )
      denied();
    if (
      input.context.run.source !== null ||
      admission.runId !== input.context.run.runId ||
      admission.threadId !== input.context.run.threadId ||
      admission.extensionBindingDigest !== input.context.run.bindingDigest ||
      (["tenantId", "spaceId", "profileId"] as const).some(
        (k) => admission[k] !== input.context.scope[k],
      ) ||
      (["pluginId", "version", "packageDigest"] as const).some(
        (k) => admission[k] !== input.context.identity[k],
      )
    )
      denied();
    if (
      this.#stage !== null &&
      (admission.action !== "project.execute" ||
        this.#stage.requestDigest !== admission.requestDigest ||
        this.#stage.idempotencyKey !== admission.idempotencyKey ||
        (["tenantId", "spaceId", "principalId", "actorId"] as const).some(
          (k) => this.#stage!.actor[k] !== admission[k],
        ) ||
        (
          [
            "tenantId",
            "spaceId",
            "profileId",
            "pluginId",
            "publisherId",
            "version",
            "packageDigest",
            "selectionRevision",
          ] as const
        ).some((k) => this.#stage!.installation[k] !== admission[k]))
    )
      denied();
    this.#service = Object.freeze(
      Object.fromEntries(
        MEDIA_INPUT_TOOL_METHODS.map((method) => [
          method,
          (input: unknown) => this.#call(method, input),
        ]),
      ),
    ) as PluginProjectMediaInputToolsService;
  }
  hostServices(): readonly PluginHostService[] {
    return Object.freeze([
      Object.freeze({
        service: PROJECT_MEDIA_INPUT_TOOLS_SERVICE,
        apiVersion: PROJECT_MEDIA_INPUT_TOOLS_API_VERSION,
        value: this.#service,
        bindForPlugin: (
          identity: Parameters<
            NonNullable<PluginHostService["bindForPlugin"]>
          >[0],
          lifetime: Parameters<
            NonNullable<PluginHostService["bindForPlugin"]>
          >[1],
        ) => {
          this.#open();
          if (
            (["pluginId", "version", "packageDigest"] as const).some(
              (k) => identity[k] !== this.#d.context.identity[k],
            )
          )
            denied();
          lifetime.onDispose(() => this.close());
          return this.#service;
        },
      }),
    ]);
  }
  async withInvocation<T>(
    input: ProjectToolsDispatchInvocation,
    delegate: () => Promise<T>,
  ): Promise<T> {
    this.#open();
    assertWorkerToolDispatchEvidence(input);
    if (
      input.command.runId !== this.#d.admission.runId ||
      this.#invocations.has(input.command) ||
      this.#active.size >= 64
    )
      denied();
    const invocation: Invocation = { ...input, live: true, pending: new Set() };
    this.#invocations.set(input.command, invocation);
    this.#active.add(invocation);
    const task = Promise.resolve().then(() => {
      this.#check(invocation);
      this.#guardCommand(input.command);
      return delegate();
    });
    this.#pending.add(task);
    try {
      return await task;
    } finally {
      while (invocation.pending.size)
        await Promise.allSettled([...invocation.pending]);
      invocation.live = false;
      this.#invocations.delete(input.command);
      this.#active.delete(invocation);
      this.#pending.delete(task);
    }
  }
  canRetire() {
    return this.#active.size === 0 && this.#pending.size === 0;
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#abort.abort(new Error("plugin_project_media_input_owner_closed"));
    return (this.#closing = (async () => {
      while (this.#pending.size || this.#active.size)
        await Promise.allSettled([
          ...this.#pending,
          ...[...this.#active].flatMap((v) => [...v.pending]),
        ]);
    })());
  }
  #open() {
    if (this.#closed) denied();
    this.#d.assertActive();
  }
  #check(invocation: Invocation) {
    this.#open();
    if (
      !invocation.live ||
      this.#invocations.get(invocation.command) !== invocation
    )
      denied();
    const e = assertWorkerToolDispatchEvidence(invocation);
    if (
      Math.min(
        Date.parse(e.claim.lease.expiresAt),
        Date.parse(invocation.command.executionLease.expiresAt),
      ) <= (this.#d.now?.() ?? new Date()).getTime()
    )
      denied();
    return e;
  }
  #invocation(command: unknown): Invocation {
    if (command === null || typeof command !== "object") denied();
    const invocation = this.#invocations.get(command);
    if (
      !invocation ||
      invocation.method === "cancel" ||
      invocation.pending.size >= 64
    )
      denied();
    this.#check(invocation);
    return invocation;
  }
  #track<T>(invocation: Invocation, task: Promise<T>): Promise<T> {
    invocation.pending.add(task);
    this.#pending.add(task);
    void task
      .finally(() => {
        invocation.pending.delete(task);
        this.#pending.delete(task);
      })
      .catch(() => {});
    return task;
  }
  #guardCommand(command: ToolExecutionCommand): MediaInputToolCommand {
    const definition = this.#d.tools.find(
        (t) => t.operationId === "media_input",
      ),
      action = command.actionIntent;
    if (
      !definition ||
      command.name !==
        extensionToolName(this.#d.admission.pluginId, "media_input") ||
      definition.capability !== "project.media-input.write" ||
      definition.effect !== "mutation" ||
      definition.recovery !== "reconcilable" ||
      action.capability !== definition.capability ||
      action.effect !== definition.effect ||
      action.recovery !== definition.recovery ||
      action.executionTarget.kind !== "control" ||
      action.policySnapshotId !== this.#d.context.target.policySnapshotId ||
      action.workspaceBindingId !== this.#d.context.target.workspaceBindingId ||
      action.limits.maxOutputBytes < 8192
    )
      denied();
    const parsed = parseMediaInputToolCommand(JSON.parse(command.input));
    assertProjectMediaInputStageToolRequest(this.#stage, "media_input", {
      method: parsed.method,
      ...parsed.request,
    });
    return parsed;
  }
  #call(method: MediaInputToolMethod, input: unknown): Promise<unknown> {
    try {
      const v = data(input, ["command", "request"]),
        i = this.#invocation(v.command),
        original = this.#guardCommand(i.command);
      const request = parseMediaInputToolRequest(method, v.request);
      if (
        original.method !== method ||
        extensionCanonicalJson(original.request) !==
          extensionCanonicalJson(request)
      )
        denied();
      return this.#track(i, this.#execute(original, i));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  async #execute(parsed: MediaInputToolCommand, i: Invocation) {
    const signal = AbortSignal.any([i.signal, this.#abort.signal]),
      projectId = this.#stage.projectId;
    const operation = { ...i, signal, operationId: "media_input", projectId };
    await this.#d.authorizeMediaInputService(signal);
    await this.#d.authorizeCurrent(operation);
    this.#check(i);
    const run = await this.#run(i),
      actor = await this.#actor(signal);
    await this.#scopeCurrent(i);
    await this.#policy(actor, projectId, parsed.method === "saveInput");
    const scope = {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      profileId: this.#d.admission.profileId,
    };
    const installation = parseProjectToolInstallationPin(
      Object.fromEntries(
        [
          "tenantId",
          "spaceId",
          "profileId",
          "pluginId",
          "publisherId",
          "version",
          "packageDigest",
          "selectionRevision",
        ].map((k) => [k, this.#d.admission[k as keyof PluginTaskAdmission]]),
      ),
    );
    const [selection, pkg] = await Promise.all([
      this.#d.installations.loadSelection({
        scope,
        pluginId: installation.pluginId,
      }),
      this.#d.installations.loadPackage({
        scope,
        packageDigest: installation.packageDigest,
      }),
    ]);
    this.#check(i);
    if (
      selection === null ||
      pkg === null ||
      selection.state !== "enabled" ||
      selection.revision !== installation.selectionRevision ||
      selection.selectedPackageDigest !== installation.packageDigest ||
      pkg.version !== installation.version ||
      pkg.packageDigest !== installation.packageDigest ||
      (
        ["tenantId", "spaceId", "profileId", "pluginId", "publisherId"] as const
      ).some(
        (k) => selection[k] !== installation[k] || pkg[k] !== installation[k],
      )
    )
      denied();
    let result: unknown;
    switch (parsed.method) {
      case "getContext": {
        const s = this.#stage;
        result = {
          projectId,
          runId: s.runId,
          threadId: s.threadId,
          workspaceId: s.workspaceId,
          bindingRevision: s.bindingRevision,
          workflowId: s.stage.workflowId,
          configurationRevision: s.stage.configurationRevision,
          briefRevision: s.stage.briefRevision,
          script: s.stage.script,
        };
        break;
      }
      case "getOptions":
        // Pinned task directory only. This response does not attest current execution readiness.
        result = {
          configuration: {
            revision: this.#stage.stage.configurationRevision,
            workflows: [this.#stage.stage.workflowId],
          },
        };
        break;
      case "listInputs":
        result =
          await ProjectMediaInputApplicationService.prototype.listInputs.call(
            this.#inputs,
            actor,
            parsed.request,
          );
        break;
      case "getInput": {
        const state =
          await ProjectMediaInputApplicationService.prototype.loadInput.call(
            this.#inputs,
            actor,
            parsed.request,
          );
        result = {
          state:
            state === null
              ? null
              : {
                  input: mediaInputMetadata(state.input),
                  latestInputRevision: state.latestInputRevision,
                },
        };
        break;
      }
      case "readPrompt": {
        const { offset: _offset, ...query } = parsed.request;
        const state =
          await ProjectMediaInputApplicationService.prototype.loadInput.call(
            this.#inputs,
            actor,
            query,
          );
        if (state === null) throw new Error("project_media_input_not_found");
        result = mediaInputPromptChunk(parsed.request, state.input);
        break;
      }
      case "saveInput": {
        proveMediaInputSaveAck(parsed.request);
        const current = async () => {
          this.#check(i);
          await this.#d.authorizeMediaInputService(signal);
          await this.#d.authorizeTransaction(operation);
          await this.#actor(signal);
          await this.#policy(actor, projectId, true);
          this.#check(i);
        };
        const evidence = this.#check(i),
          tx = captureProjectMediaInputRunCommitTransaction({
            version: "crewon.project-media-input-run-commit.v1",
            actor,
            run,
            receipt: evidence.receipt,
            claim: evidence.claim,
            commandInput: i.command.input,
            operationId: "media_input",
            installation,
            admission: this.#d.admission,
            mediaInputStageAdmission: this.#stage,
            selection,
            package: pkg,
            assertCurrent: current,
            assertActive: () => {
              this.#check(i);
            },
          });
        const saved =
          await ProjectMediaInputApplicationService.prototype.saveInput.call(
            this.#inputs,
            actor,
            projectMediaInputRunCommand(tx, sha),
            { runTransaction: tx },
          );
        result = {
          disposition: saved.disposition,
          input: mediaInputMetadata(saved.input),
        };
        // No post-COMMIT withdrawal can disguise a known committed result as a failed write.
        break;
      }
    }
    if (parsed.method !== "saveInput") {
      await this.#d.authorizeMediaInputService(signal);
      await this.#d.authorizeCurrent(operation);
      await this.#actor(signal);
      await this.#scopeCurrent(i);
      await this.#policy(actor, projectId, false);
      this.#check(i);
    }
    return parseMediaInputToolResponse(parsed.method, parsed.request, result);
  }
  async #scopeCurrent(i: Invocation) {
    const s = this.#stage,
      locator = {
        tenantId: s.actor.tenantId,
        spaceId: s.actor.spaceId,
        runId: s.runId,
      };
    const [original, digest, binding] = await Promise.all([
      this.#d.stages.loadMediaInputStageAdmission(locator),
      this.#d.stages.readRequiredMediaInputStageDigest(locator),
      this.#d.conversations.loadBinding({
        actor: s.actor,
        profileId: s.installation.profileId,
        threadId: s.threadId,
      }),
    ]);
    this.#check(i);
    if (
      digest !== s.contentDigest ||
      extensionCanonicalJson(original) !== extensionCanonicalJson(s) ||
      binding === null ||
      binding.state !== "active" ||
      binding.bindingId !== s.bindingId ||
      binding.revision !== s.bindingRevision ||
      binding.projectId !== s.projectId ||
      binding.workspaceId !== s.workspaceId ||
      extensionCanonicalJson(binding.owner) !==
        extensionCanonicalJson(s.actor) ||
      extensionCanonicalJson(binding.currentInstallation) !==
        extensionCanonicalJson(s.installation)
    )
      denied();
  }
  async #policy(
    actor: import("@crewon/application").ActorContext,
    projectId: string,
    write: boolean,
  ) {
    const value = await this.#d.authorization.authorize({
      actor,
      action: write ? "creativeProject:write" : "creativeProject:read",
      resource: {
        kind: "creativeProject",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        projectId,
      },
    });
    if (data(value, ["outcome"]).outcome !== "allow") denied();
  }
  async #actor(signal: AbortSignal) {
    const a = this.#d.admission,
      raw = await this.#d.resolveActor(
        { tenantId: a.tenantId, spaceId: a.spaceId, actorId: a.actorId },
        signal,
      );
    if (raw === null) denied();
    const actor = validateCreativeProjectActor(raw);
    if (
      (["tenantId", "spaceId", "actorId", "principalId"] as const).some(
        (k) => actor[k] !== a[k],
      )
    )
      denied();
    return actor;
  }
  async #run(i: Invocation) {
    const a = this.#d.admission,
      run = await this.#d.runs.loadRunInSpace({
        tenantId: a.tenantId,
        spaceId: a.spaceId,
        runId: a.runId,
      });
    this.#check(i);
    if (
      run === null ||
      run.threadId !== a.threadId ||
      run.createdByActorId !== a.actorId ||
      run.cancelRequested ||
      (run.status !== "running" &&
        !(
          run.status === "reconciling" &&
          this.#check(i).receipt.status === "unknownOutcome" &&
          run.reconciliationReceiptId === this.#check(i).receipt.receiptId
        )) ||
      (
        [
          "authorityId",
          "runtimeGeneration",
          "agentVersionId",
          "policySnapshotId",
          "workspaceBindingId",
        ] as const
      ).some((k) => run[k] !== this.#d.context.target[k])
    )
      denied();
    return run;
  }
}
function data(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== keys.length
  )
    denied();
  const v: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (
      typeof key !== "string" ||
      !keys.includes(key) ||
      !d?.enumerable ||
      !("value" in d)
    )
      denied();
    v[key] = d.value;
  }
  return v;
}
function denied(): never {
  throw new Error("plugin_project_media_input_tools_authority_denied");
}
function bound(input: object, key: string): (...args: never[]) => unknown {
  for (
    let owner: object | null = input, depth = 0;
    owner !== null && depth < 16;
    owner = Object.getPrototypeOf(owner), depth++
  ) {
    const d = Object.getOwnPropertyDescriptor(owner, key);
    if (!d) continue;
    if (!("value" in d) || typeof d.value !== "function") denied();
    return d.value.bind(input);
  }
  return denied();
}
