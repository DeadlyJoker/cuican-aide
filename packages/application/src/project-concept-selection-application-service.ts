import {
  parseProjectGenerationSelectionUiActionRequest,
  type ProjectGenerationSelectionUiInput,
} from "@crewon/contracts/plugins";
import {
  assertPluginTaskAdmission,
  creativeProjectTimestamp,
  extensionCanonicalJson,
  parseExtensionConfiguration,
  parsePluginTaskAdmission,
  parseProjectGenerationLink,
  type ConceptAsset,
  type CreativeProject,
  type ProjectGenerationLink,
  type ExtensionConfiguration,
  type OperationResultLink,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import type {
  ApplicationClock,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type {
  CreativeProjectCommitAuthority,
  CreativeProjectStore,
} from "./creative-project-store-port.ts";
import type { CreativeProjectAuthorizationPort } from "./creative-project-authorization-port.ts";
import {
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitCurrent,
  captureCreativeProjectCommitAuthority,
  captureCreativeProjectTransactionAuthority,
} from "./creative-project-commit-authority.ts";
import {
  checkedCreativeAsset,
  checkedCreativeProject,
  creativeActor,
  creativeInput,
  creativeOwner,
  creativeProjectUseCase,
  creativeStored,
} from "./creative-project-application-support.ts";
import {
  authorizeExtension,
  extensionScopeFor,
} from "./extension-application-support.ts";
import type { ExtensionStore } from "./extension-store-port.ts";
import type {
  ExternalOperationStore,
  ExternalOperation,
} from "./external-operation-store-port.ts";
import type { ProjectGenerationApplicationPorts } from "./project-generation-application-support.ts";
import {
  projectGenerationHostFields,
  type ProjectGenerationExecutionAuthority,
} from "./project-generation-execution-authority.ts";
import { ProjectGenerationReadApplicationService } from "./project-generation-read-application-service.ts";
import { readProjectGenerationReadinessSource } from "./project-generation-readiness-source.ts";
import {
  captureProjectGenerationImageResultVerifier,
  verifyProjectGenerationImage,
  type ProjectGenerationImageResultVerifier,
  type VerifiedProjectGenerationImage,
} from "./project-generation-image-result-verifier.ts";
import type {
  CommitProjectConceptSelectionResult,
  CurrentConceptSelectionReadResult,
  ProjectConceptSelectionStore,
  ProjectConceptSelectionCommandSource,
} from "./project-concept-selection-store-port.ts";
import {
  assertSelectionScope,
  captureConceptSelectionCommandSource,
  checkedConceptSelectionResult,
  checkedCurrentConceptSelection,
  checkedSelectionOperation,
  conceptOperationResultLink,
  conceptSelectionReceipt,
  selectionCommand,
  selectionMethod,
} from "./project-concept-selection-support.ts";

export type ProjectConceptSelectionApplicationDependencies = Readonly<{
  projects: ProjectGenerationApplicationPorts;
  generationReads: ProjectGenerationReadApplicationService;
  extensions: Pick<ExtensionStore, "loadPluginTaskAdmission">;
  operations: Pick<ExternalOperationStore, "loadExternalOperation">;
  selections: ProjectConceptSelectionStore;
  authorization: AuthorizationPort;
  verifier: ProjectGenerationImageResultVerifier;
  clock: ApplicationClock;
  digester: ContentDigester;
}>;
export type SelectProjectConceptImageOptions = Readonly<{
  authority: ProjectGenerationExecutionAuthority;
  source: ProjectConceptSelectionCommandSource;
}>;
export type GetProjectConceptSelectionQuery = Readonly<{
  projectId: string;
  assetId: string;
}>;
export type ProjectConceptSelectionReadResult = Readonly<{
  selectionRevision: number;
  current:
    | null
    | (NonNullable<CurrentConceptSelectionReadResult["current"]> &
        Readonly<{
          project: CreativeProject;
          asset: ConceptAsset;
          requiresConfirmation: boolean;
        }>);
}>;
type Metadata = Readonly<{ project: CreativeProject; asset: ConceptAsset }>;
type Proof = Readonly<{
  generationLink: ProjectGenerationLink;
  configuration: ExtensionConfiguration;
  operation: ExternalOperation;
  image: VerifiedProjectGenerationImage;
  resultLink: OperationResultLink;
}>;

/** Explicit result selection only. This service cannot create a Run, submit to a provider or reserve credits. */
export class ProjectConceptSelectionApplicationService {
  readonly #writeEnabled: boolean;
  readonly #projects: ProjectGenerationApplicationPorts;
  readonly #getGeneration: ProjectGenerationReadApplicationService["getConceptGeneration"];
  readonly #loadAdmission: NonNullable<
    ExtensionStore["loadPluginTaskAdmission"]
  >;
  readonly #loadOperation: ExternalOperationStore["loadExternalOperation"];
  readonly #loadReceipt: ProjectConceptSelectionStore["loadConceptSelectionReceipt"];
  readonly #loadCurrent: ProjectConceptSelectionStore["loadCurrentConceptSelection"];
  readonly #commit: ProjectConceptSelectionStore["commitConceptImageSelection"];
  readonly #authorization: AuthorizationPort;
  readonly #verifier: ProjectGenerationImageResultVerifier;
  readonly #clock: ApplicationClock;
  readonly #digester: ContentDigester;

  constructor(dependencies: ProjectConceptSelectionApplicationDependencies) {
    const value = projectGenerationHostFields(dependencies, [
      "projects",
      "generationReads",
      "extensions",
      "operations",
      "selections",
      "authorization",
      "verifier",
      "clock",
      "digester",
    ]);
    const reads = value.generationReads;
    const selections = value.selections as ProjectConceptSelectionStore;
    if (
      !(reads instanceof ProjectGenerationReadApplicationService) ||
      selections === null ||
      typeof selections !== "object" ||
      selections.projectConceptSelectionReadVersion !==
        "crewon.project-concept-selection-read.v1"
    )
      throw new ApplicationError("internal", "concept_selection_unavailable");
    this.#writeEnabled =
      selections.projectConceptSelectionVersion ===
      "crewon.project-concept-selection.v1";
    const projects = projectGenerationHostFields(value.projects, [
      "store",
      "authorization",
    ]);
    // The readiness helper accesses only these four read ports; no mutation port is retained.
    const store = Object.freeze({
      loadProject: selectionMethod<CreativeProjectStore["loadProject"]>(
        projects.store,
        "loadProject",
      ),
      loadConceptAsset: selectionMethod<
        CreativeProjectStore["loadConceptAsset"]
      >(projects.store, "loadConceptAsset"),
      loadConceptRevision: selectionMethod<
        CreativeProjectStore["loadConceptRevision"]
      >(projects.store, "loadConceptRevision"),
      loadBrief: selectionMethod<CreativeProjectStore["loadBrief"]>(
        projects.store,
        "loadBrief",
      ),
    });
    this.#projects = Object.freeze({
      store: store as CreativeProjectStore,
      authorization: Object.freeze({
        authorize: selectionMethod<
          CreativeProjectAuthorizationPort["authorize"]
        >(projects.authorization, "authorize"),
      }),
    });
    this.#getGeneration = selectionMethod(reads, "getConceptGeneration");
    this.#loadAdmission = selectionMethod(
      value.extensions,
      "loadPluginTaskAdmission",
    );
    this.#loadOperation = selectionMethod(
      value.operations,
      "loadExternalOperation",
    );
    this.#loadReceipt = selectionMethod(
      selections,
      "loadConceptSelectionReceipt",
    );
    this.#loadCurrent = selectionMethod(
      selections,
      "loadCurrentConceptSelection",
    );
    this.#commit = selectionMethod(selections, "commitConceptImageSelection");
    this.#authorization = Object.freeze({
      authorize: selectionMethod<AuthorizationPort["authorize"]>(
        value.authorization,
        "authorize",
      ),
    });
    this.#verifier = captureProjectGenerationImageResultVerifier(
      value.verifier as ProjectGenerationImageResultVerifier,
    );
    this.#clock = Object.freeze({
      now: selectionMethod<ApplicationClock["now"]>(value.clock, "now"),
    });
    this.#digester = Object.freeze({
      sha256: selectionMethod<ContentDigester["sha256"]>(
        value.digester,
        "sha256",
      ),
    });
  }

  selectConceptImage(
    actorInput: ActorContext,
    input: ProjectGenerationSelectionUiInput,
    options: SelectProjectConceptImageOptions,
  ): Promise<CommitProjectConceptSelectionResult> {
    return this.#useCase(async () => {
      if (!this.#writeEnabled)
        throw new ApplicationError("conflict", "concept_selection_unavailable");
      const actor = creativeActor(actorInput),
        command = selectionCommand(input);
      const fields = projectGenerationHostFields(options, [
        "authority",
        "source",
      ]);
      const origin = creativeInput(() =>
        captureConceptSelectionCommandSource(
          fields.source as ProjectConceptSelectionCommandSource,
        ),
      );
      if (
        origin.kind === "installed-plugin-ui" &&
        (["tenantId", "spaceId", "principalId", "actorId"] as const).some(
          (key) => origin.publication.sourcePin[key] !== actor[key],
        )
      )
        throw new ApplicationError(
          "authorization",
          "concept_selection_actor_mismatch",
        );
      const authority = captureCreativeProjectTransactionAuthority(
        fields.authority as ProjectGenerationExecutionAuthority,
      );
      const active = () => {
        assertCreativeProjectCommitActive(authority.preflight);
        assertCreativeProjectCommitActive(authority.transaction);
      };
      const preflight = async () => {
        active();
        await assertCreativeProjectCommitCurrent(authority.preflight);
        active();
      };
      const receipt = conceptSelectionReceipt(
        actor,
        command,
        origin,
        this.#digester,
      );
      await preflight();
      await this.#authorizeProject(actor, command.reference.projectId, "write");
      active();
      const previous = await this.#loadReceipt({ actor, receipt });
      active();
      let proof: Proof;
      if (previous !== null) {
        const saved = checkedConceptSelectionResult(
          previous,
          actor,
          command,
          this.#digester,
        );
        proof = await this.#readSelectionProof(
          actor,
          command.reference,
          command.operationId,
          command.expectedOperationRevision,
          command.resultIndex,
        );
        this.#assertResultLink(saved, proof);
      } else {
        const source = await readProjectGenerationReadinessSource({
          actor,
          reference: command.reference,
          projects: this.#projects,
          digester: this.#digester,
        });
        active();
        proof = await this.#readSelectionProof(
          actor,
          command.reference,
          command.operationId,
          command.expectedOperationRevision,
          command.resultIndex,
        );
        active();
        if (
          proof.generationLink.assetContentDigest !==
            source.assetRevision.contentDigest ||
          proof.generationLink.briefRevision !== source.brief.briefRevision ||
          proof.generationLink.briefContentDigest !== source.brief.contentDigest
        )
          throw new ApplicationError(
            "internal",
            "concept_selection_source_mismatch",
          );
      }
      const transaction: CreativeProjectCommitAuthority = Object.freeze({
        assertCurrent: async () => {
          active();
          await this.#authorize(
            actor,
            command.reference.projectId,
            "write",
            proof,
          );
          await assertCreativeProjectCommitCurrent(authority.transaction);
          active();
        },
        assertActive: active,
      });
      await preflight();
      await transaction.assertCurrent();
      active();
      const at = creativeProjectTimestamp(this.#clock.now());
      const raw = await this.#commit(
        {
          actor,
          reference: command.reference,
          operationId: command.operationId,
          expectedOperationRevision: command.expectedOperationRevision,
          resultIndex: command.resultIndex,
          expectedSelectionRevision: command.expectedSelectionRevision,
          receipt,
          at,
        },
        { authority: transaction, source: origin },
      );
      // Confirmed COMMIT is sticky. Only immutable result validation follows, never current policy or CAS.
      const result = checkedConceptSelectionResult(
        raw,
        actor,
        command,
        this.#digester,
      );
      this.#assertResultLink(result, proof);
      if (
        result.disposition === "committed" &&
        result.pointer.selectedAt !== at
      )
        throw new ApplicationError(
          "internal",
          "concept_selection_receipt_mismatch",
        );
      return result;
    });
  }

  getConceptSelection(
    actorInput: ActorContext,
    input: GetProjectConceptSelectionQuery,
    options?: Readonly<{ authority?: CreativeProjectCommitAuthority }>,
  ): Promise<ProjectConceptSelectionReadResult> {
    return this.#useCase(async () => {
      const actor = creativeActor(actorInput);
      const query = creativeInput(() => {
        const request = parseProjectGenerationSelectionUiActionRequest({
          action: "crewon.project-generation-selections.v1.getConceptSelection",
          input,
        });
        if (
          request.action !==
          "crewon.project-generation-selections.v1.getConceptSelection"
        )
          throw new ApplicationError(
            "validation",
            "concept_selection_query_invalid",
          );
        return request.input;
      });
      const authority = captureCreativeProjectCommitAuthority(options);
      const fence = async () => {
        assertCreativeProjectCommitActive(authority);
        await assertCreativeProjectCommitCurrent(authority);
        assertCreativeProjectCommitActive(authority);
      };
      await fence();
      await this.#authorizeProject(actor, query.projectId, "read");
      await this.#metadata(actor, query);
      const current = checkedCurrentConceptSelection(
        await this.#loadCurrent({ owner: creativeOwner(actor), ...query }),
        actor,
        query,
        this.#digester,
      );
      if (current.current === null) {
        await this.#authorizeProject(actor, query.projectId, "read");
        await fence();
        return Object.freeze({ selectionRevision: 0, current: null });
      }
      const { pointer, resultLink } = current.current;
      const proof = await this.#readSelectionProof(
        actor,
        resultLink.reference,
        resultLink.operationId,
        resultLink.operationRevision,
        resultLink.image.resultIndex,
      );
      this.#assertResultLink(current.current, proof);
      const metadata = await this.#metadata(actor, query);
      await this.#authorize(actor, query.projectId, "read", proof);
      await fence();
      return Object.freeze({
        selectionRevision: current.selectionRevision,
        current: Object.freeze({
          pointer,
          resultLink,
          ...metadata,
          requiresConfirmation:
            resultLink.reference.assetRevision !==
              metadata.asset.latestAssetRevision ||
            proof.generationLink.briefRevision !==
              metadata.project.latestBriefRevision,
        }),
      });
    });
  }

  /** Internal source proof; method identity is captured by this service, never supplied by browser JSON. */
  async #readSelectionProof(
    actor: ActorContext,
    reference: Readonly<{
      projectId: string;
      assetId: string;
      assetRevision: number;
    }>,
    operationId: string,
    expectedRevision: number,
    resultIndex: number,
  ) {
    const source = await this.#getGeneration(actor, {
      projectId: reference.projectId,
      assetId: reference.assetId,
      assetRevision: reference.assetRevision,
    });
    if (source === null)
      throw new ApplicationError(
        "notFound",
        "concept_selection_generation_not_found",
      );
    const generationLink = creativeStored(() =>
      parseProjectGenerationLink(source.link, this.#digester),
    );
    const configuration = creativeStored(() =>
      parseExtensionConfiguration(source.task.configuration, this.#digester),
    );
    const admissionRaw = await this.#loadAdmission({
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      runId: generationLink.binding.runId,
    });
    if (admissionRaw === null)
      throw new ApplicationError(
        "internal",
        "concept_selection_paid_admission_missing",
      );
    const admission = creativeStored(() => {
      const value = parsePluginTaskAdmission(admissionRaw);
      assertPluginTaskAdmission(
        {
          admission: value,
          binding: generationLink.binding,
          receipt: generationLink.receipt,
        },
        this.#digester,
      );
      if (
        value.principalId !== actor.principalId ||
        generationLink.ownerPrincipalId !== actor.principalId ||
        value.version !== configuration.pluginVersion
      )
        throw new Error("concept_selection_paid_admission_mismatch");
      return value;
    });
    const operation = checkedSelectionOperation(
      await this.#loadOperation({
        tenantId: actor.tenantId,
        runId: generationLink.binding.runId,
        bindingDigest: generationLink.binding.bindingDigest,
        operationId,
      }),
      generationLink,
      operationId,
      expectedRevision,
    );
    const image = verifyProjectGenerationImage(this.#verifier, {
      generationLink,
      configuration,
      operation,
      resultIndex,
    });
    const resultLink = creativeStored(() =>
      conceptOperationResultLink(
        {
          actor,
          generationLink,
          configuration,
          packageDigest: admission.packageDigest,
          operation,
          image,
        },
        this.#digester,
      ),
    );
    return Object.freeze({
      generationLink,
      configuration,
      operation,
      image,
      resultLink,
    });
  }

  async #metadata(
    actor: ActorContext,
    query: GetProjectConceptSelectionQuery,
  ): Promise<Metadata> {
    const owner = creativeOwner(actor);
    const raw = await this.#projects.store.loadProject({
      owner,
      projectId: query.projectId,
    });
    if (raw === null)
      throw new ApplicationError("notFound", "creative_project_not_found");
    const project = checkedCreativeProject(raw, owner, query.projectId);
    const assetRaw = await this.#projects.store.loadConceptAsset({
      owner,
      ...query,
    });
    if (assetRaw === null)
      throw new ApplicationError(
        "notFound",
        "creative_project_asset_not_found",
      );
    return Object.freeze({
      project,
      asset: checkedCreativeAsset(assetRaw, project, query.assetId),
    });
  }
  async #authorizeProject(
    actor: ActorContext,
    projectId: string,
    mode: "read" | "write",
  ) {
    if (
      (
        await this.#projects.authorization.authorize({
          actor,
          action:
            mode === "write" ? "creativeProject:write" : "creativeProject:read",
          resource: {
            kind: "creativeProject",
            tenantId: actor.tenantId,
            spaceId: actor.spaceId,
            projectId,
          },
        })
      ).outcome !== "allow"
    )
      throw new ApplicationError("authorization", "authorization_denied");
  }
  async #authorize(
    actor: ActorContext,
    projectId: string,
    mode: "read" | "write",
    proof: Proof,
  ) {
    await this.#authorizeProject(actor, projectId, mode);
    await authorizeExtension(
      this.#authorization,
      actor,
      "extension:query",
      extensionScopeFor(actor, proof.generationLink.binding.pluginId),
    );
    if (
      (
        await this.#authorization.authorize({
          actor,
          action: "run:read",
          resource: {
            kind: "run",
            tenantId: actor.tenantId,
            spaceId: actor.spaceId,
            runId: proof.generationLink.binding.runId,
            threadId: proof.generationLink.binding.threadId,
          },
        })
      ).outcome !== "allow"
    )
      throw new ApplicationError("authorization", "authorization_denied");
  }
  #assertResultLink(
    result: Pick<CommitProjectConceptSelectionResult, "pointer" | "resultLink">,
    proof: Proof,
  ) {
    creativeStored(() => {
      assertSelectionScope(
        {
          tenantId: proof.generationLink.tenantId,
          spaceId: proof.generationLink.spaceId,
          principalId: proof.generationLink.ownerPrincipalId,
          actorId: result.pointer.selectedByActorId,
        },
        proof.generationLink.reference,
        result,
      );
      if (
        extensionCanonicalJson(result.resultLink) !==
        extensionCanonicalJson(proof.resultLink)
      )
        throw new Error("concept_selection_result_link_mismatch");
    });
  }
  async #useCase<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await creativeProjectUseCase(work);
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        error.category === "internal" &&
        error.cause instanceof Error &&
        [
          "concept_selection_revision_conflict",
          "concept_selection_receipt_conflict",
          "concept_selection_idempotency_conflict",
          "concept_selection_operation_revision_conflict",
          "concept_selection_operation_not_succeeded",
        ].includes(error.cause.message)
      )
        throw new ApplicationError("conflict", error.cause.message, {
          cause: error.cause,
        });
      throw error;
    }
  }
}
