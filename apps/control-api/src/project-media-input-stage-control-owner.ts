import {
  ApplicationError,
  ProjectMediaInputStageApplicationService,
  type ActorContext,
  type PluginInstallationStore,
  type PluginUiAuthorizationPort,
  type ProjectMediaInputStageCommitAuthority,
  type ProjectConversationStore,
  type ProjectToolInstallationPin,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parseInstalledPluginPackage,
  parsePluginSelection,
  parsePluginTaskAdmissionPin,
} from "@crewon/domain";
import {
  loadInstalledPluginBusinessRegistration,
  verifyLocalPluginPackage,
  verifyInstalledProjectActionDeclaration,
  type PluginActivationCandidate,
} from "@crewon/plugin-host";
import {
  PROJECT_MEDIA_INPUT_STAGES_METHOD_ACTIONS as actions,
  parseProjectMediaInputStagesActionRequest,
  type ProjectMediaInputStageRequest,
} from "@crewon/contracts/project-media-input-stages";
import { join } from "node:path";
import type { ControlApiRequestContext } from "./control-api-ports.ts";
import type { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import type { InstalledPluginTaskActionOwnerDependencies } from "./installed-plugin-task-action-owner.ts";
import type { ProjectMediaInputStageConfiguration } from "./project-media-input-stage-composition.ts";
export type ProjectMediaInputStageControlDependencies = Readonly<{
  service: ProjectMediaInputStageApplicationService;
  conversations: Pick<ProjectConversationStore, "loadBinding">;
  configuration: ProjectMediaInputStageConfiguration;
  installations: Pick<PluginInstallationStore, "loadSelection" | "loadPackage">;
  requests: InstalledPluginRequestOwner;
  installRoot: string;
  authorization: PluginUiAuthorizationPort;
  authorizePackage: InstalledPluginTaskActionOwnerDependencies["authorizePackage"];
  assertExternal(actor: ActorContext): void;
}>;
const genuineOwners = new WeakSet<object>();
export function isProjectMediaInputStageControlOwner(
  input: unknown,
): input is ProjectMediaInputStageControlOwner {
  return (
    input !== null && typeof input === "object" && genuineOwners.has(input)
  );
}
/** Original Composer admission. Explicit host publication plus installed media tools; no implicit UI service or generation permission. */
export class ProjectMediaInputStageControlOwner {
  readonly #input: ProjectMediaInputStageControlDependencies;
  readonly #physical = new Set<Promise<unknown>>();
  #closed = false;
  #closing: Promise<void> | undefined;
  constructor(input: ProjectMediaInputStageControlDependencies) {
    if (
      !(input.service instanceof ProjectMediaInputStageApplicationService) ||
      input.configuration.version !== "crewon.project-media-input-stages.v1"
    )
      throw new Error("project_media_input_stage_service_required");
    this.#input = Object.freeze({
      ...input,
      configuration: Object.freeze({
        version: input.configuration.version,
        publications: Object.freeze(
          input.configuration.publications.map((p) => Object.freeze({ ...p })),
        ),
      }),
      installations: Object.freeze({
        loadSelection: input.installations.loadSelection.bind(
          input.installations,
        ),
        loadPackage: input.installations.loadPackage.bind(input.installations),
      }),
      conversations: Object.freeze({
        loadBinding: input.conversations.loadBinding.bind(input.conversations),
      }),
      authorization: Object.freeze({
        authorize: input.authorization.authorize.bind(input.authorization),
      }),
      authorizePackage: input.authorizePackage.bind(input),
      assertExternal: input.assertExternal.bind(input),
    });
    genuineOwners.add(this);
  }
  supportsAction(action: string) {
    return action === actions.startStage;
  }
  assertAvailable() {
    if (this.#closed) unavailable();
  }
  close(): Promise<void> {
    this.#closed = true;
    return (this.#closing ??= Promise.allSettled([...this.#physical]).then(
      () => {},
    ));
  }
  runAuthenticatedRequest<T>(
    request: ControlApiRequestContext,
    actor: ActorContext,
    action: string,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    this.assertAvailable();
    if (!this.supportsAction(action)) unavailable();
    return this.#input.requests.run({ request, actor, signal }, work);
  }
  getAvailability(
    request: ControlApiRequestContext,
    actor: ActorContext,
    threadId: string,
    signal?: AbortSignal,
  ) {
    return this.#track(() =>
      this.#input.requests.run(
        { request, actor, signal, preparation: "configuration" },
        async () => {
          await this.#input.requests.assertCurrent();
          const b = await this.#input.conversations.loadBinding({
            actor,
            profileId: this.#input.requests.currentScope().profileId,
            threadId,
          });
          if (
            b === null ||
            !this.#input.configuration.publications.some(
              (p) =>
                p.pluginId === b.currentInstallation.pluginId &&
                p.packageDigest === b.currentInstallation.packageDigest,
            )
          )
            return { available: false };
          const q = await this.#issue(actor, b.currentInstallation);
          return {
            available: await this.#input.service.isAvailable(
              actor,
              threadId,
              q,
            ),
          };
        },
      ),
    );
  }
  startStage(
    request: ControlApiRequestContext,
    actor: ActorContext,
    input: ProjectMediaInputStageRequest,
    signal?: AbortSignal,
  ) {
    return this.#track(() =>
      this.runAuthenticatedRequest(
        request,
        actor,
        actions.startStage,
        signal,
        async () => {
          const parsed = parseProjectMediaInputStagesActionRequest({
            action: actions.startStage,
            input,
          });
          await this.#input.requests.assertCurrent();
          const b = await this.#input.conversations.loadBinding({
            actor,
            profileId: this.#input.requests.currentScope().profileId,
            threadId: parsed.input.threadId,
          });
          if (b === null || b.projectId !== parsed.input.projectId) denied();
          const q = await this.#issue(actor, b.currentInstallation);
          return this.#input.service.startStage(actor, parsed.input, q);
        },
      ),
    );
  }
  async #issue(
    actor: ActorContext,
    expected: ProjectToolInstallationPin,
  ): Promise<ProjectMediaInputStageCommitAuthority> {
    this.assertAvailable();
    await this.#input.requests.assertCurrent();
    const scope = this.#input.requests.currentScope();
    if (
      !same(actor, this.#input.requests.currentActor()) ||
      expected.tenantId !== scope.tenantId ||
      expected.spaceId !== scope.spaceId ||
      expected.profileId !== scope.profileId
    )
      denied();
    const selectionRaw = await this.#input.installations.loadSelection({
      scope,
      pluginId: expected.pluginId,
    });
    if (selectionRaw === null) denied();
    const selection = parsePluginSelection(selectionRaw);
    if (
      selection.state !== "enabled" ||
      selection.selectedPackageDigest !== expected.packageDigest ||
      selection.revision !== expected.selectionRevision ||
      selection.publisherId !== expected.publisherId
    )
      denied();
    const packageRaw = await this.#input.installations.loadPackage({
      scope,
      packageDigest: expected.packageDigest,
    });
    if (packageRaw === null) denied();
    const pkg = parseInstalledPluginPackage(packageRaw);
    if (
      pkg.pluginId !== expected.pluginId ||
      pkg.publisherId !== expected.publisherId ||
      pkg.version !== expected.version ||
      !same(scope, {
        tenantId: pkg.tenantId,
        spaceId: pkg.spaceId,
        profileId: pkg.profileId,
      })
    )
      denied();
    const publication = this.#input.configuration.publications.find(
      (entry) =>
        entry.pluginId === pkg.pluginId &&
        entry.packageDigest === pkg.packageDigest,
    );
    if (publication === undefined || publication.contributionId !== "workbench")
      denied();
    const signal = this.#input.requests.currentSignal();
    const candidate = await verifyLocalPluginPackage({
      directory: join(
        this.#input.installRoot,
        "packages",
        pkg.packageDigest.slice(7),
      ),
      signal,
    });
    const checked: PluginActivationCandidate = {
      descriptor: candidate.descriptor,
      packageDigest: candidate.packageDigest,
    };
    if (
      candidate.packageDigest !== pkg.packageDigest ||
      candidate.descriptor.pluginId !== pkg.pluginId ||
      candidate.descriptor.publisherId !== pkg.publisherId ||
      candidate.descriptor.version !== pkg.version ||
      candidate.descriptor.entrypoints.node === null ||
      !candidate.descriptor.contributions.some(
        (entry) =>
          entry.id === publication.contributionId &&
          entry.kind === "module" &&
          entry.slot === "main.content",
      ) ||
      candidate.descriptor.businessManifestPath === null ||
      !candidate.descriptor.requires.some(
        (entry) =>
          entry.service === "crewon.project-media-input-tools" &&
          entry.apiVersion === "1",
      )
    )
      denied();
    if (
      (await this.#input.authorizePackage(
        { actor, scope, candidate: checked, purpose: "read" },
        signal,
      )) !== "allow"
    )
      denied();
    const registration = await loadInstalledPluginBusinessRegistration({
      installRoot: this.#input.installRoot,
      expectedPluginId: pkg.pluginId,
      expectedPublisherId: pkg.publisherId,
      expectedVersion: pkg.version,
      expectedPackageDigest: pkg.packageDigest,
      signal,
      authorizeRead: async () =>
        this.#input.authorizePackage(
          { actor, scope, candidate: checked, purpose: "read" },
          signal,
        ),
    });
    if (
      registration.manifest.pluginId !== pkg.pluginId ||
      registration.manifest.version !== pkg.version ||
      !registration.manifest.tools.some(
        (tool) =>
          tool.operationId === "media_input" &&
          tool.adapterId === "crewon.project-media-input-tools" &&
          tool.capability === "project.media-input.write" &&
          tool.effect === "mutation" &&
          tool.recovery === "reconcilable",
      )
    )
      denied();
    const resource = {
      kind: "pluginUi" as const,
      ...scope,
      pluginId: pkg.pluginId,
      packageDigest: pkg.packageDigest,
      selectionRevision: selection.revision,
      contributionId: publication.contributionId,
    };
    const decision = await this.#input.authorization.authorize({
      actor,
      action: "invoke",
      resource,
    });
    if (decision.outcome !== "allow") denied();
    const pin = parsePluginTaskAdmissionPin({
      ...expected,
      principalId: actor.principalId,
      actorId: actor.actorId,
      contributionId: publication.contributionId,
      action: "project.execute",
      authorityEpoch: decision.authorityEpoch,
    });
    const assertActive = () => {
      this.assertAvailable();
      signal.throwIfAborted();
      this.#input.assertExternal(actor);
      if (
        !same(actor, this.#input.requests.currentActor()) ||
        !same(scope, this.#input.requests.currentScope())
      )
        denied();
    };
    const assertTransactionCurrent = async () => {
      assertActive();
      await this.#input.requests.assertCurrent();
      const current = await this.#input.authorization.authorize({
        actor,
        action: "invoke",
        resource,
      });
      if (
        current.outcome !== "allow" ||
        current.authorityEpoch !== pin.authorityEpoch
      )
        denied();
      if (
        (await this.#input.authorizePackage(
          { actor, scope, candidate: checked, purpose: "submit" },
          signal,
        )) !== "allow"
      )
        denied();
      assertActive();
    };
    const assertCurrent = async () => {
      await assertTransactionCurrent();
      const current = await this.#input.installations.loadSelection({
        scope,
        pluginId: pkg.pluginId,
      });
      const currentPackage = await this.#input.installations.loadPackage({
        scope,
        packageDigest: pkg.packageDigest,
      });
      if (
        current === null ||
        currentPackage === null ||
        !same(parsePluginSelection(current), selection) ||
        !same(parseInstalledPluginPackage(currentPackage), pkg)
      )
        denied();
      const currentBytes = await verifyLocalPluginPackage({
        directory: candidate.directory,
        signal,
      });
      if (
        currentBytes.packageDigest !== pkg.packageDigest ||
        !same(currentBytes.descriptor, candidate.descriptor)
      )
        denied();
      assertActive();
    };
    await assertCurrent();
    {
      await verifyInstalledProjectActionDeclaration({
        installRoot: this.#input.installRoot,
        pluginId: pkg.pluginId,
        packageDigest: pkg.packageDigest,
        contributionId: publication.contributionId,
        assertActive,
        assertCurrent: async (actual) => {
          await assertCurrent();
          if (
            actual.packageDigest !== pkg.packageDigest ||
            !same(actual.descriptor, candidate.descriptor) ||
            (await this.#input.authorizePackage(
              { actor, scope, candidate: actual, purpose: "submit" },
              signal,
            )) !== "allow"
          )
            denied();
          await assertCurrent();
        },
      });
      await assertCurrent();
    }
    return Object.freeze({
      version: "crewon.project-media-input-stage-commit.v1",
      actor,
      installation: expected,
      selection,
      package: pkg,
      pin,
      assertCurrent,
      assertTransactionCurrent,
      assertActive,
    });
  }
  #track<T>(work: () => Promise<T>): Promise<T> {
    this.assertAvailable();
    if (this.#physical.size >= 128) unavailable();
    const result = Promise.resolve().then(work);
    this.#physical.add(result);
    void result.then(
      () => this.#physical.delete(result),
      () => this.#physical.delete(result),
    );
    return result;
  }
}
function same(a: unknown, b: unknown) {
  return extensionCanonicalJson(a) === extensionCanonicalJson(b);
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "project_media_input_stage_authority_changed",
  );
}
function unavailable(): never {
  throw new ApplicationError(
    "conflict",
    "project_media_input_stage_unavailable",
  );
}
