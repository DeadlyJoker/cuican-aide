import { readProjectContextScope } from "./project-context-service-read.ts";
import { createHash } from "node:crypto";
import {
  captureCreativeProjectRunCommitTransaction,
  deriveProjectToolMutationIdempotencyKey,
  parseProjectToolInstallationPin,
  type ActorContext,
  type CreativeProjectApplicationService,
  type CreativeProjectAuthorizationPort,
  type CreativeProjectCommitAuthority,
  type CreativeProjectRunCommitTransactionAuthority,
  type PluginInstallationStore,
  type ProjectTextApplicationService,
  type ProjectToolMutationOperation,
  type RunStore,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  extensionToolName,
  parsePluginTaskAdmission,
  validateCreativeProjectActor,
  type ExtensionManifest,
  type PluginTaskAdmission,
  type ProjectStageRunAdmission,
  type ProjectTextPlanRunAdmission,
  parseProjectTextPlanRunAdmission,
  assertProjectTextPlanOutlineEpisodes,
  parseProjectStageRunAdmission,
  assertProjectStageToolRequest,
} from "@crewon/domain";
import type { PluginHostService } from "@crewon/plugin-host";
import type { PluginToolRuntimeContext } from "@crewon/plugin-sdk/node";
import type { ToolExecutionCommand } from "@crewon/tool-broker";
import {
  CREWON_PROJECT_TOOLS_API_VERSION,
  CREWON_PROJECT_TOOLS_SERVICE,
  PROJECT_TOOL_OPERATIONS,
  MAX_PROJECT_TOOLS_RESPONSE_BYTES,
  type PluginProjectToolsService,
  type ProjectToolsMethod,
} from "@crewon/contracts/project-tools";
import {
  assertWorkerToolDispatchEvidence,
  type WorkerToolDispatchMethod,
} from "./worker-tool-dispatch-authority.ts";
import {
  parseProjectToolsRequest,
  type ProjectToolsRequests,
} from "./project-tools-service-request.ts";
import {
  boundedProjectToolsResponse,
  projectToolsProject,
  projectToolsBrief,
  projectToolsView,
  projectToolsRevision,
  projectToolsTextMutation,
  projectToolsBriefMutation,
  projectToolsContent,
} from "./project-tools-service-projection.ts";
import {
  CREWON_PROJECT_CONTEXT_SERVICE,
  CREWON_PROJECT_CONTEXT_API_VERSION,
  type PluginProjectContextService,
} from "@crewon/contracts/project-context";

export type ProjectToolsDispatchInvocation = Readonly<{
  command: ToolExecutionCommand;
  method: WorkerToolDispatchMethod;
  signal: AbortSignal;
}>;
export type ProjectToolsAuthorizationInvocation =
  ProjectToolsDispatchInvocation &
    Readonly<{
      operationId: string;
      projectId: string | null;
    }>;
export type ProjectToolsServiceOwnerDependencies = Readonly<{
  context: PluginToolRuntimeContext;
  admission: PluginTaskAdmission;
  stageAdmission?: ProjectStageRunAdmission | null;
  planAdmission?: ProjectTextPlanRunAdmission | null;
  tools: ExtensionManifest["tools"];
  projects: CreativeProjectApplicationService;
  texts: ProjectTextApplicationService;
  runs: Pick<RunStore, "loadRunInSpace">;
  installations: Pick<PluginInstallationStore, "loadSelection" | "loadPackage">;
  authorization: CreativeProjectAuthorizationPort;
  resolveActor(
    owner: Readonly<{ tenantId: string; spaceId: string; actorId: string }>,
    signal?: AbortSignal,
  ): Promise<ActorContext | null>;
  authorizeCurrent(
    invocation: ProjectToolsAuthorizationInvocation,
  ): Promise<void>;
  /** External identity/package policy only; must never borrow the committing Store's pool. */
  authorizeTransaction(
    invocation: ProjectToolsAuthorizationInvocation,
  ): Promise<void>;
  assertActive(): void;
  now?: () => Date;
}>;
type Invocation = ProjectToolsDispatchInvocation & {
  live: boolean;
  pending: Set<Promise<unknown>>;
};
const mutations = new Set<ProjectToolsMethod>([
  "createProject",
  "appendBrief",
  "saveOutlineCandidate",
  "saveScriptCandidate",
  "selectRevision",
  "setLocked",
]);
const digester = Object.freeze({
  sha256: (text: string) =>
    `sha256:${createHash("sha256").update(text).digest("hex")}`,
});

/** Per-resident host owner. Possessing the service during setup grants no project authority. */
export class ProjectToolsServiceOwner {
  readonly #dependencies: ProjectToolsServiceOwnerDependencies;
  readonly #admission: PluginTaskAdmission;
  readonly #stage: ProjectStageRunAdmission | null;
  readonly #plan: ProjectTextPlanRunAdmission | null;
  readonly #abort = new AbortController();
  readonly #invocations = new WeakMap<object, Invocation>();
  readonly #active = new Set<Invocation>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #service: PluginProjectToolsService;
  #closed = false;
  #closing: Promise<void> | undefined;
  constructor(dependencies: ProjectToolsServiceOwnerDependencies) {
    this.#dependencies = dependencies;
    this.#admission = parsePluginTaskAdmission(dependencies.admission);
    this.#plan =
      dependencies.planAdmission == null
        ? null
        : parseProjectTextPlanRunAdmission(
            dependencies.planAdmission,
            digester,
          );
    this.#stage =
      dependencies.stageAdmission == null
        ? null
        : parseProjectStageRunAdmission(dependencies.stageAdmission, digester);
    if (
      this.#stage !== null &&
      (this.#stage.runId !== this.#admission.runId ||
        this.#stage.threadId !== this.#admission.threadId ||
        this.#stage.extensionBindingDigest !==
          dependencies.context.run.bindingDigest ||
        this.#stage.userContentDigest !==
          dependencies.context.run.inputDigest ||
        this.#stage.requestDigest !== this.#admission.requestDigest ||
        this.#stage.idempotencyKey !== this.#admission.idempotencyKey ||
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
        ).some((k) => this.#stage!.installation[k] !== this.#admission[k]) ||
        (["tenantId", "spaceId", "principalId", "actorId"] as const).some(
          (k) => this.#stage!.actor[k] !== this.#admission[k],
        ) ||
        this.#stage.pluginTaskAdmissionDigest !==
          digester.sha256(extensionCanonicalJson(this.#admission)))
    )
      denied();
    if (this.#plan !== null) {
      const p = this.#plan,
        s = this.#stage;
      if (
        s === null ||
        p.stageAdmissionDigest !== s.contentDigest ||
        p.extensionBindingDigest !== dependencies.context.run.bindingDigest ||
        p.inputDigest !== dependencies.context.run.inputDigest ||
        p.configurationRevision !==
          dependencies.context.configuration.revision ||
        p.configurationDigest !==
          dependencies.context.configuration.contentDigest ||
        p.idempotencyKey !== this.#admission.idempotencyKey ||
        p.kind !== s.stage.kind ||
        p.episodeId !==
          (s.stage.kind === "script" ? s.stage.episodeId : null) ||
        extensionCanonicalJson(p.actor) !== extensionCanonicalJson(s.actor) ||
        extensionCanonicalJson(p.installation) !==
          extensionCanonicalJson(s.installation) ||
        extensionCanonicalJson(p.sources) !==
          extensionCanonicalJson(s.sources) ||
        (
          [
            "runId",
            "threadId",
            "projectId",
            "bindingId",
            "bindingRevision",
            "workspaceId",
          ] as const
        ).some((key) => p[key] !== s[key])
      )
        denied();
    }
    if (
      dependencies.context.run.source !== null ||
      this.#admission.runId !== dependencies.context.run.runId ||
      this.#admission.threadId !== dependencies.context.run.threadId ||
      this.#admission.extensionBindingDigest !==
        dependencies.context.run.bindingDigest ||
      (["tenantId", "spaceId", "profileId"] as const).some(
        (key) => this.#admission[key] !== dependencies.context.scope[key],
      ) ||
      (["pluginId", "version", "packageDigest"] as const).some(
        (key) => this.#admission[key] !== dependencies.context.identity[key],
      )
    )
      denied();
    this.#service = Object.freeze(
      Object.fromEntries(
        Object.keys(PROJECT_TOOL_OPERATIONS).map((method) => [
          method,
          (input: unknown) => this.#call(method as ProjectToolsMethod, input),
        ]),
      ),
    ) as unknown as PluginProjectToolsService;
  }
  hostService(): PluginHostService {
    return Object.freeze({
      service: CREWON_PROJECT_TOOLS_SERVICE,
      apiVersion: CREWON_PROJECT_TOOLS_API_VERSION,
      value: this.#service,
      bindForPlugin: (identity, lifetime) => {
        this.#assertActive();
        if (
          (["pluginId", "version", "packageDigest"] as const).some(
            (key) => identity[key] !== this.#dependencies.context.identity[key],
          )
        )
          denied();
        lifetime.onDispose(() => this.close());
        return this.#service;
      },
    });
  }
  contextHostService(): PluginHostService {
    const value: PluginProjectContextService = Object.freeze({
      readScope: (input: Readonly<{ command: unknown }>) =>
        this.#readScope(input),
    });
    return Object.freeze({
      service: CREWON_PROJECT_CONTEXT_SERVICE,
      apiVersion: CREWON_PROJECT_CONTEXT_API_VERSION,
      value,
      bindForPlugin: (identity, lifetime) => {
        this.#assertActive();
        if (
          (["pluginId", "version", "packageDigest"] as const).some(
            (k) => identity[k] !== this.#dependencies.context.identity[k],
          )
        )
          denied();
        lifetime.onDispose(() => this.close());
        return value;
      },
    });
  }
  async withInvocation<T>(
    input: ProjectToolsDispatchInvocation,
    delegate: () => Promise<T>,
  ): Promise<T> {
    this.#assertActive();
    assertWorkerToolDispatchEvidence(input);
    if (
      input.command.runId !== this.#dependencies.context.run.runId ||
      this.#invocations.has(input.command) ||
      this.#active.size >= 64
    )
      denied();
    const invocation: Invocation = { ...input, live: true, pending: new Set() };
    this.#invocations.set(input.command, invocation);
    this.#active.add(invocation);
    const task = Promise.resolve().then(() => {
      this.#check(invocation);
      if (this.#stage !== null) {
        const definition = this.#dependencies.tools.find(
          (t) =>
            extensionToolName(this.#admission.pluginId, t.operationId) ===
            input.command.name,
        );
        if (definition === undefined) denied();
        const method = (
          Object.keys(PROJECT_TOOL_OPERATIONS) as ProjectToolsMethod[]
        ).find((m) => PROJECT_TOOL_OPERATIONS[m] === definition.operationId);
        const request =
          definition.operationId === "project_context_read"
            ? JSON.parse(input.command.input)
            : method === undefined
              ? denied()
              : parseProjectToolsRequest(
                  method,
                  JSON.parse(input.command.input),
                );
        assertProjectStageToolRequest(
          this.#stage,
          definition.operationId,
          request as Readonly<Record<string, unknown>>,
        );
      }
      return delegate();
    });
    this.#pending.add(task);
    try {
      return await task;
    } finally {
      while (invocation.pending.size > 0)
        await Promise.allSettled([...invocation.pending]);
      invocation.live = false;
      this.#invocations.delete(input.command);
      this.#active.delete(invocation);
      this.#pending.delete(task);
    }
  }
  canRetire(): boolean {
    return this.#active.size === 0 && this.#pending.size === 0;
  }
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    this.#abort.abort(new Error("plugin_project_tools_owner_closed"));
    this.#closing = (async () => {
      while (this.#pending.size > 0 || this.#active.size > 0) {
        await Promise.allSettled([...this.#pending]);
        await Promise.allSettled(
          [...this.#active].flatMap((value) => [...value.pending]),
        );
      }
    })();
    return this.#closing;
  }
  #assertActive(): void {
    if (this.#closed) denied();
    this.#dependencies.assertActive();
  }
  #check(invocation: Invocation) {
    this.#assertActive();
    if (
      !invocation.live ||
      this.#invocations.get(invocation.command) !== invocation
    )
      denied();
    const evidence = assertWorkerToolDispatchEvidence(invocation);
    if (
      Math.min(
        Date.parse(evidence.claim.lease.expiresAt),
        Date.parse(invocation.command.executionLease.expiresAt),
      ) <= (this.#dependencies.now?.() ?? new Date()).getTime()
    )
      denied();
    return evidence;
  }
  #readScope(input: Readonly<{ command: unknown }>) {
    return readProjectContextScope(input, {
      invocations: this.#invocations,
      check: (invocation) => this.#check(invocation),
      ownerSignal: this.#abort.signal,
      dependencies: this.#dependencies,
      actor: (id, signal) => this.#actor(id, signal),
      admission: this.#admission,
      stage: this.#stage,
      pending: this.#pending,
    });
  }
  #call(method: ProjectToolsMethod, input: unknown): Promise<unknown> {
    try {
      this.#assertActive();
      const fields = Object.getOwnPropertyDescriptors(input ?? {});
      if (
        input === null ||
        typeof input !== "object" ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
        Reflect.ownKeys(input).length !== 2 ||
        !fields.command?.enumerable ||
        !("value" in fields.command) ||
        !fields.request?.enumerable ||
        !("value" in fields.request)
      )
        denied();
      const command: unknown = fields.command.value;
      if (command === null || typeof command !== "object") denied();
      const invocation = this.#invocations.get(command);
      if (
        invocation === undefined ||
        invocation.method === "cancel" ||
        invocation.pending.size >= 64
      )
        denied();
      this.#check(invocation);
      const operationId = PROJECT_TOOL_OPERATIONS[method];
      const mutation = mutations.has(method);
      const definition = this.#dependencies.tools.find(
        (tool) => tool.operationId === operationId,
      );
      if (
        definition === undefined ||
        definition.capability !==
          (mutation ? "project.write" : "project.read") ||
        definition.effect !== (mutation ? "mutation" : "readOnly") ||
        definition.recovery !== (mutation ? "reconcilable" : "replaySafe") ||
        invocation.command.name !==
          extensionToolName(this.#admission.pluginId, operationId) ||
        invocation.command.actionIntent.policySnapshotId !==
          this.#dependencies.context.target.policySnapshotId ||
        invocation.command.actionIntent.workspaceBindingId !==
          this.#dependencies.context.target.workspaceBindingId ||
        invocation.command.actionIntent.executionTarget.kind !== "control" ||
        invocation.command.actionIntent.limits.maxOutputBytes <
          MAX_PROJECT_TOOLS_RESPONSE_BYTES ||
        invocation.command.actionIntent.capability !== definition.capability ||
        invocation.command.actionIntent.effect !== definition.effect ||
        invocation.command.actionIntent.recovery !== definition.recovery
      )
        denied();
      const request = parseProjectToolsRequest(method, fields.request.value);
      const original = parseProjectToolsRequest(
        method,
        JSON.parse(invocation.command.input),
      );
      if (extensionCanonicalJson(request) !== extensionCanonicalJson(original))
        denied();
      const task = this.#execute(method, request, invocation);
      invocation.pending.add(task);
      this.#pending.add(task);
      void task
        .finally(() => {
          invocation.pending.delete(task);
          this.#pending.delete(task);
        })
        .catch(() => {});
      return task;
    } catch (error) {
      return Promise.reject(error);
    }
  }
  async #execute(
    method: ProjectToolsMethod,
    request: ProjectToolsRequests[ProjectToolsMethod],
    invocation: Invocation,
  ): Promise<unknown> {
    const projectId = "projectId" in request ? request.projectId : null;
    const authorization = {
      ...invocation,
      signal: AbortSignal.any([invocation.signal, this.#abort.signal]),
      operationId: PROJECT_TOOL_OPERATIONS[method],
      projectId,
    };
    await this.#dependencies.authorizeCurrent(authorization);
    this.#check(invocation);
    const run = await this.#dependencies.runs.loadRunInSpace({
      tenantId: this.#admission.tenantId,
      spaceId: this.#admission.spaceId,
      runId: this.#admission.runId,
    });
    if (
      run === null ||
      run.runId !== this.#admission.runId ||
      run.threadId !== this.#admission.threadId ||
      run.tenantId !== this.#admission.tenantId ||
      run.spaceId !== this.#admission.spaceId ||
      run.createdByActorId !== this.#admission.actorId ||
      run.cancelRequested ||
      (run.status !== "running" &&
        !(
          run.status === "reconciling" &&
          this.#check(invocation).receipt.status === "unknownOutcome" &&
          run.reconciliationReceiptId ===
            this.#check(invocation).receipt.receiptId
        )) ||
      (
        [
          "authorityId",
          "runtimeGeneration",
          "agentVersionId",
          "policySnapshotId",
          "workspaceBindingId",
        ] as const
      ).some((key) => run[key] !== this.#dependencies.context.target[key])
    )
      denied();
    const actor = await this.#actor(run.createdByActorId, authorization.signal);
    const scope = {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      profileId: this.#admission.profileId,
    };
    const [selection, pkg] = await Promise.all([
      this.#dependencies.installations.loadSelection({
        scope,
        pluginId: this.#admission.pluginId,
      }),
      this.#dependencies.installations.loadPackage({
        scope,
        packageDigest: this.#admission.packageDigest,
      }),
    ]);
    this.#check(invocation);
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
        ].map((key) => [
          key,
          this.#admission[key as keyof PluginTaskAdmission],
        ]),
      ),
    );
    if (
      selection === null ||
      pkg === null ||
      selection.state !== "enabled" ||
      selection.revision !== installation.selectionRevision ||
      selection.selectedPackageDigest !== installation.packageDigest ||
      (
        ["tenantId", "spaceId", "profileId", "pluginId", "publisherId"] as const
      ).some(
        (key) =>
          selection[key] !== installation[key] ||
          pkg[key] !== installation[key],
      ) ||
      pkg.version !== installation.version ||
      pkg.packageDigest !== installation.packageDigest
    )
      denied();
    const assertTransactionCurrent = async () => {
      this.#check(invocation);
      authorization.signal.throwIfAborted();
      await this.#dependencies.authorizeTransaction(authorization);
      await this.#actor(run.createdByActorId, authorization.signal);
      const decision = await this.#dependencies.authorization.authorize({
        actor,
        action:
          method === "createProject"
            ? "creativeProject:create"
            : "creativeProject:write",
        resource: {
          kind: "creativeProject",
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          projectId,
        },
      });
      if (decision.outcome !== "allow") denied();
      this.#check(invocation);
    };
    let authority: CreativeProjectCommitAuthority | undefined;
    let key: string | undefined;
    if (mutations.has(method)) {
      const evidence = this.#check(invocation);
      const transaction: CreativeProjectRunCommitTransactionAuthority =
        captureCreativeProjectRunCommitTransaction({
          version: "crewon.creative-project-run-commit.v1",
          actor,
          run,
          receipt: evidence.receipt,
          claim: evidence.claim,
          commandInput: invocation.command.input,
          operationId: PROJECT_TOOL_OPERATIONS[
            method
          ] as ProjectToolMutationOperation,
          installation,
          admission: this.#admission,
          ...(this.#stage === null
            ? {}
            : { projectStageAdmission: this.#stage }),
          ...(this.#plan === null
            ? {}
            : { projectTextPlanAdmission: this.#plan }),
          selection,
          package: pkg,
          assertCurrent: assertTransactionCurrent,
        });
      if (this.#plan !== null && method === "saveOutlineCandidate")
        assertProjectTextPlanOutlineEpisodes(
          this.#plan,
          (
            request as ProjectToolsRequests["saveOutlineCandidate"]
          ).content.episodes.map((episode) => episode.episodeId),
        );
      key = deriveProjectToolMutationIdempotencyKey(transaction, digester);
      authority = {
        runTransaction: transaction,
        assertActive: () => {
          this.#check(invocation);
        },
        assertCurrent: async () => {
          await this.#dependencies.authorizeCurrent(authorization);
          await assertTransactionCurrent();
        },
      };
    }
    if (this.#stage?.stage.kind === "script" && method === "readContent") {
      const read = request as ProjectToolsRequests["readContent"];
      if (read.source.kind === "text") {
        const revision = await this.#dependencies.texts.getRevision(actor, {
          projectId: read.projectId,
          artifactId: read.source.artifactId,
          contentRevision: read.source.contentRevision,
        });
        if (
          revision.kind === "script" &&
          revision.episodeId !== this.#stage.stage.episodeId
        )
          denied();
        this.#check(invocation);
      }
    }
    const value = await this.#invoke(method, request, actor, key, authority);
    await this.#dependencies.authorizeCurrent(authorization);
    await this.#actor(run.createdByActorId, authorization.signal);
    const decision = await this.#dependencies.authorization.authorize({
      actor,
      action:
        method === "listProjects"
          ? "creativeProject:list"
          : method === "createProject"
            ? "creativeProject:create"
            : mutations.has(method)
              ? "creativeProject:write"
              : "creativeProject:read",
      resource: {
        kind: "creativeProject",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        projectId,
      },
    });
    if (decision.outcome !== "allow") denied();
    this.#check(invocation);
    return boundedProjectToolsResponse(value);
  }
  async #actor(actorId: string, signal: AbortSignal): Promise<ActorContext> {
    const raw = await this.#dependencies.resolveActor(
      {
        tenantId: this.#admission.tenantId,
        spaceId: this.#admission.spaceId,
        actorId,
      },
      signal,
    );
    if (raw === null) denied();
    const actor = validateCreativeProjectActor(raw);
    if (
      (["tenantId", "spaceId", "actorId", "principalId"] as const).some(
        (key) => actor[key] !== this.#admission[key],
      )
    )
      denied();
    return actor;
  }
  async #invoke(
    method: ProjectToolsMethod,
    request: ProjectToolsRequests[ProjectToolsMethod],
    actor: ActorContext,
    idempotencyKey: string | undefined,
    authority: CreativeProjectCommitAuthority | undefined,
  ): Promise<unknown> {
    const projects = this.#dependencies.projects,
      texts = this.#dependencies.texts;
    const options = { authority };
    // Each branch reuses the original owned Application use case; no raw storage writes.
    switch (method) {
      case "listProjects": {
        const page = await projects.listProjects(
          actor,
          request as ProjectToolsRequests["listProjects"],
        );
        return {
          projects: page.projects.map(projectToolsProject),
          next: page.next,
        };
      }
      case "readProject": {
        const query = request as ProjectToolsRequests["readProject"];
        const project = await projects.getProject(actor, query);
        const brief =
          project.latestBriefRevision === 0
            ? null
            : await projects.getBrief(actor, {
                projectId: project.projectId,
                briefRevision: project.latestBriefRevision,
              });
        return {
          project: projectToolsProject(project),
          brief: brief === null ? null : projectToolsBrief(brief),
        };
      }
      case "createProject":
        return projectToolsBriefMutation(
          await projects.createProject(
            actor,
            {
              ...(request as ProjectToolsRequests["createProject"]),
              idempotencyKey: idempotencyKey!,
            },
            options,
          ),
        );
      case "appendBrief":
        return projectToolsBriefMutation(
          await projects.appendBrief(
            actor,
            {
              ...(request as ProjectToolsRequests["appendBrief"]),
              idempotencyKey: idempotencyKey!,
            },
            options,
          ),
        );
      case "readOutline":
        return {
          view: projectToolsView(
            await texts.getOutline(
              actor,
              request as ProjectToolsRequests["readOutline"],
            ),
          ),
        };
      case "readScript":
        return {
          view: projectToolsView(
            await texts.getScript(
              actor,
              request as ProjectToolsRequests["readScript"],
            ),
          ),
        };
      case "readContent": {
        const query = request as ProjectToolsRequests["readContent"];
        if (query.source.kind === "brief") {
          const brief = await projects.getBrief(actor, {
            projectId: query.projectId,
            briefRevision: query.source.briefRevision,
          });
          return projectToolsContent(
            brief.contentDigest,
            "text",
            brief.text,
            query.offset,
          );
        }
        const revision = await texts.getRevision(actor, {
          projectId: query.projectId,
          artifactId: query.source.artifactId,
          contentRevision: query.source.contentRevision,
        });
        return projectToolsContent(
          revision.contentDigest,
          "canonical-json",
          extensionCanonicalJson(revision.content),
          query.offset,
        );
      }
      case "listRevisions": {
        const page = await texts.listRevisions(
          actor,
          request as ProjectToolsRequests["listRevisions"],
        );
        return {
          revisions: page.revisions.map(projectToolsRevision),
          nextContentRevision: page.nextContentRevision,
        };
      }
      case "saveOutlineCandidate":
        return projectToolsTextMutation(
          await texts.saveOutlineCandidate(
            actor,
            {
              ...(request as ProjectToolsRequests["saveOutlineCandidate"]),
              idempotencyKey: idempotencyKey!,
            },
            options,
          ),
        );
      case "saveScriptCandidate":
        return projectToolsTextMutation(
          await texts.saveScriptCandidate(
            actor,
            {
              ...(request as ProjectToolsRequests["saveScriptCandidate"]),
              idempotencyKey: idempotencyKey!,
            },
            options,
          ),
        );
      case "selectRevision":
        return projectToolsTextMutation(
          await texts.selectRevision(
            actor,
            {
              ...(request as ProjectToolsRequests["selectRevision"]),
              idempotencyKey: idempotencyKey!,
            },
            options,
          ),
        );
      case "setLocked":
        return projectToolsTextMutation(
          await texts.setLocked(
            actor,
            {
              ...(request as ProjectToolsRequests["setLocked"]),
              idempotencyKey: idempotencyKey!,
            },
            options,
          ),
        );
    }
  }
}
function denied(): never {
  throw new Error("plugin_project_tools_authority_denied");
}
