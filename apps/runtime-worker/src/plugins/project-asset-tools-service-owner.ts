import { assertProjectAssetStageDispatch } from "./project-stage-dispatch-scope.ts";
import {
  issuePluginProjectAssetRunMutationReadScope,
  issuePluginProjectAssetRunReadScope,
  captureProjectAssetRunReadAuthority,
} from "@crewon/application/host-project-workspaces";
import {
  captureMediaInputReadScope,
  mediaInputStageReadCommand,
} from "./project-media-input-read-scope.ts";
import {
  assertProjectMediaInputStageToolRequest,
  type ProjectMediaInputStageRunAdmission,
} from "@crewon/domain";
import {
  projectAssetToolHead as head,
  projectAssetToolRevision as revision,
  proveProjectAssetToolMetadataAckBudget as proveMetadataAckBudget,
} from "./project-asset-tools-service-projection.ts";
import { createHash } from "node:crypto";
import {
  captureProjectAssetRunCommitTransaction,
  projectAssetRunMutationCommand,
  parseProjectToolInstallationPin,
  ProjectAssetApplicationService,
  isProjectAssetApplicationService,
  type ProjectAssetCommitAuthority,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  extensionToolName,
  parseProjectAssetStageRunAdmission,
  assertProjectAssetStageToolRequest,
  parsePluginTaskAdmission,
  validateCreativeProjectActor,
  type ProjectAssetStageRunAdmission,
  type PluginTaskAdmission,
} from "@crewon/domain";
import {
  CREWON_PROJECT_ASSET_TOOLS_SERVICE,
  CREWON_PROJECT_ASSET_CONTEXT_SERVICE,
  CREWON_PROJECT_ASSET_TOOLS_API_VERSION,
  PROJECT_ASSET_TOOL_OPERATIONS,
  projectAssetToolsCodec,
  parseProjectAssetToolCommand,
  type PluginProjectAssetToolsService,
  type PluginProjectAssetContextService,
  type ProjectAssetToolMethod,
  type ProjectAssetToolsRequests,
} from "@crewon/contracts/project-asset-tools";
import type { PluginHostService } from "@crewon/plugin-host";
import type { ToolExecutionCommand } from "@crewon/tool-broker";
import { assertWorkerToolDispatchEvidence } from "./worker-tool-dispatch-authority.ts";
import type {
  ProjectToolsServiceOwnerDependencies,
  ProjectToolsDispatchInvocation,
} from "./project-tools-service-owner.ts";

export type ProjectAssetToolsServiceOwnerDependencies = Omit<
  ProjectToolsServiceOwnerDependencies,
  "assets"
> &
  Readonly<{
    assets: ProjectAssetApplicationService;
    assetStageAdmission: ProjectAssetStageRunAdmission | null;
    /** Independent deployment grant; the conversation/text service grant cannot substitute. */
    authorizeAssetService(signal: AbortSignal): Promise<void>;
  }>;
type Invocation = ProjectToolsDispatchInvocation & {
  live: boolean;
  pending: Set<Promise<unknown>>;
};
const sha = Object.freeze({
  sha256: (x: string) =>
    `sha256:${createHash("sha256").update(x).digest("hex")}`,
});
/** The resident's independent asset capability, checked against the actual Worker command on every call. */
export class ProjectAssetToolsServiceOwner {
  readonly #d: ProjectAssetToolsServiceOwnerDependencies;
  readonly #stage: ProjectAssetStageRunAdmission | null;
  readonly #mediaInputStage: ProjectMediaInputStageRunAdmission | null;
  readonly #invocations = new WeakMap<object, Invocation>();
  readonly #active = new Set<Invocation>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #abort = new AbortController();
  readonly #service: PluginProjectAssetToolsService;
  readonly #assets: ProjectAssetApplicationService;
  #closed = false;
  #closing: Promise<void> | undefined;
  constructor(input: ProjectAssetToolsServiceOwnerDependencies) {
    if (
      !isProjectAssetApplicationService(input.assets) ||
      typeof input.authorizeAssetService !== "function"
    )
      denied();
    const admission = parsePluginTaskAdmission(input.admission);
    this.#mediaInputStage = captureMediaInputReadScope(
      input.mediaInputStageAdmission,
      input.context,
      admission,
    );
    if (
      this.#mediaInputStage &&
      (input.assetStageAdmission || input.stageAdmission || input.planAdmission)
    )
      denied();
    this.#d = Object.freeze({
      ...input,
      admission,
      resolveActor: input.resolveActor.bind(input),
      authorizeCurrent: input.authorizeCurrent.bind(input),
      authorizeTransaction: input.authorizeTransaction.bind(input),
      authorizeAssetService: input.authorizeAssetService.bind(input),
      assertActive: input.assertActive.bind(input),
      runs: Object.freeze({
        loadRunInSpace: bound(
          input.runs,
          "loadRunInSpace",
        ) as ProjectAssetToolsServiceOwnerDependencies["runs"]["loadRunInSpace"],
      }),
      installations: Object.freeze({
        loadSelection: bound(
          input.installations,
          "loadSelection",
        ) as ProjectAssetToolsServiceOwnerDependencies["installations"]["loadSelection"],
        loadPackage: bound(
          input.installations,
          "loadPackage",
        ) as ProjectAssetToolsServiceOwnerDependencies["installations"]["loadPackage"],
      }),
      authorization: Object.freeze({
        authorize: bound(
          input.authorization,
          "authorize",
        ) as ProjectAssetToolsServiceOwnerDependencies["authorization"]["authorize"],
      }),
    });
    this.#assets = input.assets;
    this.#stage =
      input.assetStageAdmission === null
        ? null
        : parseProjectAssetStageRunAdmission(input.assetStageAdmission, sha);
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
        Object.keys(PROJECT_ASSET_TOOL_OPERATIONS).map((method) => [
          method,
          (input: unknown) =>
            this.#call(method as ProjectAssetToolMethod, input),
        ]),
      ),
    ) as PluginProjectAssetToolsService;
  }
  hostServices(): readonly PluginHostService[] {
    const context: PluginProjectAssetContextService = Object.freeze({
      readScope: (input: Readonly<{ command: unknown }>) => this.#scope(input),
    });
    return Object.freeze([
      this.#host(CREWON_PROJECT_ASSET_TOOLS_SERVICE, this.#service),
      this.#host(CREWON_PROJECT_ASSET_CONTEXT_SERVICE, context),
    ]);
  }
  #host(service: string, value: object): PluginHostService {
    return Object.freeze({
      service,
      apiVersion: CREWON_PROJECT_ASSET_TOOLS_API_VERSION,
      value,
      bindForPlugin: (identity, lifetime) => {
        this.#open();
        if (
          (["pluginId", "version", "packageDigest"] as const).some(
            (k) => identity[k] !== this.#d.context.identity[k],
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
      if (this.#mediaInputStage !== null)
        mediaInputStageReadCommand({
          stage: this.#mediaInputStage,
          command: input.command,
          tools: this.#d.tools,
          context: this.#d.context,
        });
      if (this.#stage !== null)
        assertProjectAssetStageDispatch(
          this.#stage,
          this.#d.tools,
          this.#d.admission.pluginId,
          input.command,
        );
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
    this.#abort.abort(new Error("plugin_project_asset_owner_closed"));
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
  #scope(
    input: Readonly<{ command: unknown }>,
  ): Promise<
    import("@crewon/contracts/project-asset-tools").ProjectAssetContextResponse
  > {
    try {
      const v = data(input, ["command"]),
        i = this.#invocation(v.command);
      return this.#track(
        i,
        (async () => {
          const signal = AbortSignal.any([i.signal, this.#abort.signal]);
          await this.#d.authorizeAssetService(signal);
          await this.#d.authorizeCurrent({
            ...i,
            signal,
            operationId: "asset_context_read",
            projectId:
              (this.#stage ?? this.#mediaInputStage)?.projectId ?? null,
          });
          this.#check(i);
          const actor = await this.#actor(signal);
          const run = await this.#run(i);
          const project = this.#stage ?? this.#mediaInputStage;
          if (project !== null)
            await this.#policy(actor, project.projectId, false);
          this.#check(i);
          await this.#d.authorizeCurrent({
            ...i,
            signal,
            operationId: "asset_context_read",
            projectId:
              (this.#stage ?? this.#mediaInputStage)?.projectId ?? null,
          });
          const s = this.#stage;
          const result = projectAssetToolsCodec.parseContextResponse({
            scope:
              s === null
                ? null
                : {
                    version: "crewon.project-asset-runtime-scope.v1",
                    runId: run.runId,
                    threadId: run.threadId,
                    projectId: s.projectId,
                    bindingId: s.bindingId,
                    bindingRevision: s.bindingRevision,
                    workspaceId: s.workspaceId,
                    stage: s.stage,
                    sources: s.sources,
                    allowedOperations: s.allowedOperations,
                    admissionDigest: s.contentDigest,
                  },
          });
          this.#check(i);
          return result;
        })(),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }
  #call(method: ProjectAssetToolMethod, input: unknown): Promise<unknown> {
    try {
      const v = data(input, ["command", "request"]),
        i = this.#invocation(v.command);
      if (this.#stage === null && this.#mediaInputStage === null) denied();
      const request = projectAssetToolsCodec.parseRequest(method, v.request),
        original = parseProjectAssetToolCommand(
          method,
          JSON.parse(i.command.input),
        );
      if (extensionCanonicalJson(request) !== extensionCanonicalJson(original))
        denied();
      const operation = PROJECT_ASSET_TOOL_OPERATIONS[method],
        write = method === "saveCandidate",
        definition = this.#d.tools.find((t) => t.operationId === operation),
        action = i.command.actionIntent;
      if (
        !definition ||
        i.command.name !==
          extensionToolName(this.#d.admission.pluginId, operation) ||
        definition.capability !==
          (write ? "project.asset.write" : "project.asset.read") ||
        definition.effect !== (write ? "mutation" : "readOnly") ||
        definition.recovery !== (write ? "reconcilable" : "replaySafe") ||
        action.capability !== definition.capability ||
        action.effect !== definition.effect ||
        action.recovery !== definition.recovery ||
        action.executionTarget.kind !== "control" ||
        action.policySnapshotId !== this.#d.context.target.policySnapshotId ||
        action.workspaceBindingId !==
          this.#d.context.target.workspaceBindingId ||
        action.limits.maxOutputBytes < 8192
      )
        denied();
      if (this.#mediaInputStage !== null)
        assertProjectMediaInputStageToolRequest(
          this.#mediaInputStage,
          operation,
          request as Readonly<Record<string, unknown>>,
        );
      else
        assertProjectAssetStageToolRequest(
          this.#stage!,
          operation,
          request as Readonly<Record<string, unknown>>,
        );
      return this.#track(i, this.#execute(method, request, i));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  async #execute(
    method: ProjectAssetToolMethod,
    request: ProjectAssetToolsRequests[ProjectAssetToolMethod],
    i: Invocation,
  ) {
    const signal = AbortSignal.any([i.signal, this.#abort.signal]),
      operation = {
        ...i,
        signal,
        operationId: PROJECT_ASSET_TOOL_OPERATIONS[method],
        projectId: request.projectId,
      };
    await this.#d.authorizeAssetService(signal);
    await this.#d.authorizeCurrent(operation);
    this.#check(i);
    const run = await this.#run(i),
      actor = await this.#actor(signal);
    await this.#policy(actor, request.projectId, method === "saveCandidate");
    const scope = {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        profileId: this.#d.admission.profileId,
      },
      installation = parseProjectToolInstallationPin(
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
    let readAssets = this.#assets;
    if (method !== "saveCandidate" && this.#stage !== null) {
      const current = async () => {
        this.#check(i);
        await this.#d.authorizeAssetService(signal);
        await this.#d.authorizeCurrent(operation);
        await this.#actor(signal);
        await this.#policy(actor, request.projectId, false);
        this.#check(i);
      };
      const evidence = this.#check(i);
      const authority = captureProjectAssetRunReadAuthority({
        version: "crewon.project-asset-run-read.v1",
        actor,
        run,
        receipt: evidence.receipt,
        claim: evidence.claim,
        commandInput: i.command.input,
        operationId: PROJECT_ASSET_TOOL_OPERATIONS[method],
        installation,
        admission: this.#d.admission,
        assetStageAdmission: this.#stage,
        selection,
        package: pkg,
        assertCurrent: current,
      });
      readAssets = await this.#assets.bindRunProjectReads(
        await issuePluginProjectAssetRunReadScope({
          authority,
          assertActive: () => {
            this.#check(i);
          },
        }),
      );
    }
    let value: unknown;
    if (method === "saveCandidate") {
      proveMetadataAckBudget(
        request as ProjectAssetToolsRequests["saveCandidate"],
      );
      const txCurrent = async () => {
        this.#check(i);
        await this.#d.authorizeAssetService(signal);
        await this.#d.authorizeTransaction(operation);
        await this.#actor(signal);
        await this.#policy(actor, request.projectId, true);
        this.#check(i);
      };
      const evidence = this.#check(i),
        tx = captureProjectAssetRunCommitTransaction({
          version: "crewon.project-asset-run-commit.v1",
          actor,
          run,
          receipt: evidence.receipt,
          claim: evidence.claim,
          commandInput: i.command.input,
          operationId: "asset_save",
          installation,
          admission: this.#d.admission,
          assetStageAdmission: this.#stage!,
          selection,
          package: pkg,
          assertCurrent: txCurrent,
        });
      const authority: ProjectAssetCommitAuthority = Object.freeze({
        assertActive: () => {
          this.#check(i);
        },
        assertCurrent: async () => {
          await this.#d.authorizeCurrent(operation);
          await txCurrent();
        },
        assertTransactionCurrent: txCurrent,
        runTransaction: tx,
      });
      const readScope = await issuePluginProjectAssetRunMutationReadScope({
        authority: tx,
        assertActive: authority.assertActive,
      });
      const scopedAssets = await this.#assets.bindRunMutationReads(readScope);
      const result =
        await ProjectAssetApplicationService.prototype.saveCandidate.call(
          scopedAssets,
          actor,
          projectAssetRunMutationCommand(tx, sha),
          { authority },
        );
      value = {
        kind: result.kind,
        disposition: result.disposition,
        asset: head(result.asset),
        contentRevision: revision(result.contentRevision!),
      };
      // Metadata ACK is known to fit before COMMIT; there is no whole-body echo or late withdrawal here.
    } else if (method === "listAssets") {
      const page =
        await ProjectAssetApplicationService.prototype.listAssets.call(
          readAssets,
          actor,
          request as ProjectAssetToolsRequests["listAssets"],
        );
      const assets = page.assets.map(head);
      let next = page.nextAssetId;
      while (true) {
        try {
          value = projectAssetToolsCodec.parseResponse(
            method,
            request as never,
            { assets, nextAssetId: next },
          );
          break;
        } catch (error) {
          if (assets.length === 0) throw error;
          assets.pop();
          next = assets.at(-1)?.assetId ?? null;
          if (assets.length === 0) throw error;
        }
      }
    } else if (method === "getAsset") {
      const view = await ProjectAssetApplicationService.prototype.getAsset.call(
        readAssets,
        actor,
        request as ProjectAssetToolsRequests["getAsset"],
      );
      if (
        this.#stage !== null &&
        view !== null &&
        view.asset.kind !== this.#stage.stage.assetKind
      )
        denied();
      value = {
        view:
          view === null
            ? null
            : {
                asset: head(view.asset),
                selectedRevision:
                  view.selectedRevision === null
                    ? null
                    : revision(view.selectedRevision),
                dependencyState: view.dependencyState,
                staleReasons: view.staleReasons,
                referenceState: view.referenceState,
              },
      };
    } else if (method === "listRevisions") {
      const q = request as ProjectAssetToolsRequests["listRevisions"];
      await this.#sameKind(actor, q.projectId, q.assetId, readAssets);
      const page =
          await ProjectAssetApplicationService.prototype.listRevisions.call(
            readAssets,
            actor,
            q,
          ),
        revisions = page.revisions.map(revision);
      let next = page.nextContentRevision;
      while (true) {
        try {
          value = projectAssetToolsCodec.parseResponse(method, q, {
            revisions,
            nextContentRevision: next,
          });
          break;
        } catch (error) {
          if (revisions.length === 0) throw error;
          revisions.pop();
          next = revisions.at(-1)?.contentRevision ?? null;
          if (revisions.length === 0) throw error;
        }
      }
    } else {
      const q = request as ProjectAssetToolsRequests["readContent"];
      const record =
        await ProjectAssetApplicationService.prototype.getRevision.call(
          readAssets,
          actor,
          {
            projectId: q.projectId,
            assetId: q.assetId,
            contentRevision: q.contentRevision,
          },
        );
      if (this.#stage !== null && record.kind !== this.#stage.stage.assetKind)
        denied();
      const points = Array.from(extensionCanonicalJson(record.content));
      if (q.offset > points.length) denied();
      const end = Math.min(points.length, q.offset + 1024);
      value = {
        contentDigest: record.contentDigest,
        format: "canonical-json",
        offset: q.offset,
        nextOffset: end === points.length ? null : end,
        totalCodePoints: points.length,
        text: points.slice(q.offset, end).join(""),
      };
    }
    if (method !== "saveCandidate") {
      await this.#d.authorizeAssetService(signal);
      await this.#d.authorizeCurrent(operation);
      await this.#actor(signal);
      await this.#policy(actor, request.projectId, false);
      this.#check(i);
    }
    return projectAssetToolsCodec.parseResponse(
      method,
      request as never,
      value,
    );
  }
  async #sameKind(
    actor: import("@crewon/application").ActorContext,
    projectId: string,
    assetId: string,
    assets = this.#assets,
  ) {
    const view = await ProjectAssetApplicationService.prototype.getAsset.call(
      assets,
      actor,
      { projectId, assetId },
    );
    if (
      view === null ||
      (this.#stage !== null && view.asset.kind !== this.#stage.stage.assetKind)
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
  throw new Error("plugin_project_asset_tools_authority_denied");
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
