import {
  createCurrentConceptSelection,
  extensionCanonicalJson,
  validateProjectGenerationSource,
  type CurrentConceptSelection,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import {
  ProjectConceptSelectionApplicationService,
  type ProjectConceptSelectionApplicationDependencies,
} from "./project-concept-selection-application-service.ts";
import type {
  CommitProjectConceptSelectionResult,
  ProjectConceptSelectionCommitOptions,
  ProjectConceptSelectionStore,
} from "./project-concept-selection-store-port.ts";
import { conceptOperationResultLink } from "./project-concept-selection-support.ts";
import type { ExternalOperation } from "./external-operation-store-port.ts";
import {
  taskActor,
  taskDigester,
  taskPin,
} from "./extension-plugin-task.test-support.ts";
import { committedProjectGenerationFixture } from "./plugin-ui-committed-project-generation.test-support.ts";
import { committedTaskContext } from "./plugin-ui-committed-task-support.ts";
import { projectGenerationReadFixture } from "./project-generation-read-application-service.test-support.ts";
import {
  verifyProjectGenerationImage,
  type ProjectGenerationImageResultVerifier,
} from "./project-generation-image-result-verifier.ts";

/** Actual Application readers and selection service over memory ports. SQL atomicity belongs to the Store integration suite. */
export async function projectConceptSelectionFixture() {
  const saved = await projectGenerationReadFixture({ generated: false });
  const generated = await saved.f
    .create()
    .createProjectTaskFromPlugin(
      taskActor,
      saved.f.command,
      { ...taskPin, version: "0.1.0" },
      saved.f.reference,
      saved.f.authority,
    );
  saved.state.run = generated.run.state;
  const original = (await saved.read())!;
  const operationId = "11111111-1111-4111-8111-111111111111";
  const state = {
    operation: {
      schemaVersion: "crewon.external-operation.v0",
      tenantId: taskActor.tenantId,
      runId: generated.binding.runId,
      bindingDigest: generated.binding.bindingDigest,
      operationId,
      executionId: "image-execution-1",
      idempotencyKey: "original-supplier-intent",
      actionDigest: taskDigester.sha256("original-image-action"),
      requestDigest: taskDigester.sha256("original-saved-input"),
      correlationId: "original-correlation",
      providerOperationId: "provider-operation-1",
      status: "succeeded",
      resultJson: extensionCanonicalJson({
        pictures: ["first.webp", "second.webp"],
      }),
      revision: 3,
      createdAt: generated.run.state.createdAt,
      updatedAt: generated.run.state.createdAt,
    } as ExternalOperation | null,
    receipts: new Map<
      string,
      { digest: string; result: CommitProjectConceptSelectionResult }
    >(),
    current: null as CommitProjectConceptSelectionResult | null,
    commitOptions: [] as ProjectConceptSelectionCommitOptions[],
    receiptReads: 0,
    currentReads: 0,
    exactOperationReads: 0,
    verificationCalls: 0,
    alive: true,
    currentPin: true,
    readEnabled: true,
    writeEnabled: true,
    versionReads: { read: 0, write: 0 },
    fullChecks: 0,
    transactionChecks: 0,
    activeChecks: 0,
    transactionProjectReads: [] as Array<readonly [number, number]>,
    beforeReceipt: null as (() => void | Promise<void>) | null,
    beforeCommit: null as (() => void | Promise<void>) | null,
    afterCommit: null as (() => void) | null,
    returnedResult: undefined as unknown,
  };
  const verifier: ProjectGenerationImageResultVerifier = {
    verifyImage(input) {
      state.verificationCalls++;
      if (
        input.configuration.contentDigest !==
          original.task.configuration.contentDigest ||
        input.configuration.pluginVersion !== "0.1.0"
      )
        throw new Error("historical_provider_configuration_required");
      const parsed = JSON.parse(input.operation.resultJson!) as {
        pictures: string[];
      };
      if (
        !Array.isArray(parsed.pictures) ||
        parsed.pictures.length > 16 ||
        typeof parsed.pictures[input.resultIndex] !== "string"
      )
        throw new Error("provider_picture_reference_invalid");
      const filename = parsed.pictures[input.resultIndex]!;
      return {
        filename,
        url: `https://image.example.test/render/${encodeURIComponent(filename)}`,
        resultIndex: input.resultIndex,
        providerReferenceJson: extensionCanonicalJson({ picture: filename }),
      };
    },
  };
  const assertActive = () => {
    state.activeChecks++;
    if (!state.alive)
      throw new ApplicationError("authorization", "selection_owner_withdrawn");
  };
  const authority = {
    async assertCurrent() {
      state.fullChecks++;
      assertActive();
    },
    async assertTransactionCurrent() {
      state.transactionChecks++;
      assertActive();
    },
    assertActive,
  };
  const selections: ProjectConceptSelectionStore = {
    get projectConceptSelectionReadVersion() {
      state.versionReads.read++;
      return state.readEnabled
        ? "crewon.project-concept-selection-read.v1"
        : undefined;
    },
    get projectConceptSelectionVersion() {
      state.versionReads.write++;
      return state.writeEnabled
        ? "crewon.project-concept-selection.v1"
        : undefined;
    },
    async loadConceptSelectionReceipt(input) {
      state.receiptReads++;
      await state.beforeReceipt?.();
      const previous = state.receipts.get(input.receipt.idempotencyKey);
      if (!previous) return null;
      if (previous.digest !== input.receipt.requestDigest)
        throw new Error("concept_selection_idempotency_conflict");
      return { ...structuredClone(previous.result), disposition: "replayed" };
    },
    async loadCurrentConceptSelection() {
      state.currentReads++;
      return {
        selectionRevision: state.current?.pointer.selectionRevision ?? 0,
        current:
          state.current === null
            ? null
            : {
                pointer: structuredClone(state.current.pointer),
                resultLink: structuredClone(state.current.resultLink),
              },
      };
    },
    async commitConceptImageSelection(input, options) {
      state.commitOptions.push(options);
      await state.beforeCommit?.();
      const reads = saved.f.state.projectReads.length;
      await options.authority.assertCurrent();
      options.authority.assertActive();
      state.transactionProjectReads.push([
        reads,
        saved.f.state.projectReads.length,
      ]);
      if (options.source.kind === "installed-plugin-ui" && !state.currentPin)
        throw new Error("concept_selection_publication_mismatch");
      const operation = state.operation;
      if (
        !operation ||
        operation.operationId !== input.operationId ||
        operation.runId !== original.link.binding.runId ||
        operation.bindingDigest !== original.link.binding.bindingDigest
      )
        throw new Error("original_operation_identity_required");
      if (operation.status !== "succeeded")
        throw new Error("concept_selection_operation_not_succeeded");
      if (operation.revision !== input.expectedOperationRevision)
        throw new Error("concept_selection_operation_revision_conflict");
      const image = verifyProjectGenerationImage(verifier, {
        generationLink: original.link,
        configuration: original.task.configuration,
        operation,
        resultIndex: input.resultIndex,
      });
      const resultLink = conceptOperationResultLink(
        {
          actor: input.actor,
          generationLink: original.link,
          configuration: original.task.configuration,
          packageDigest: taskPin.packageDigest,
          operation,
          image,
        },
        taskDigester,
      );
      const previous = state.receipts.get(input.receipt.idempotencyKey);
      if (previous) {
        if (
          previous.digest !== input.receipt.requestDigest ||
          previous.result.resultLink.contentDigest !== resultLink.contentDigest
        )
          throw new Error("concept_selection_idempotency_conflict");
        return { ...structuredClone(previous.result), disposition: "replayed" };
      }
      const revision = saved.f.state.revisions.get(
        input.reference.assetRevision,
      )!;
      validateProjectGenerationSource(
        {
          actor: input.actor,
          reference: input.reference,
          project: saved.f.state.project,
          asset: saved.f.state.asset,
          assetRevision: revision,
          brief: saved.f.state.briefs.get(revision.briefRevision)!,
        },
        taskDigester,
      );
      const pointer: CurrentConceptSelection = createCurrentConceptSelection(
        {
          actor: input.actor,
          resultLink,
          previous: state.current?.pointer ?? null,
          expectedSelectionRevision: input.expectedSelectionRevision,
          at: input.at,
        },
        taskDigester,
      );
      options.authority.assertActive();
      const result = { disposition: "committed" as const, pointer, resultLink };
      state.current = structuredClone(result);
      state.receipts.set(input.receipt.idempotencyKey, {
        digest: input.receipt.requestDigest,
        result: structuredClone(result),
      });
      state.afterCommit?.();
      return state.returnedResult === undefined
        ? result
        : (state.returnedResult as CommitProjectConceptSelectionResult);
    },
  };
  const operations = {
    async loadExternalOperation() {
      state.exactOperationReads++;
      return structuredClone(state.operation);
    },
  };
  const business = committedProjectGenerationFixture();
  const context = {
    ...business.detachedContext(),
    action: "crewon.project-generation-selections.v1.selectConceptImage",
  };
  const uiSource = {
    kind: "installed-plugin-ui" as const,
    publication: {
      publication: { source: business.publication.source },
      sourcePin: committedTaskContext(context).pin,
      selection: context.selection,
      package: context.package,
    },
  };
  const source = { kind: "authenticated-project-command" as const };
  const dependencies: ProjectConceptSelectionApplicationDependencies = {
    projects: saved.f.projects,
    generationReads: saved.service,
    extensions: saved.extensions,
    operations,
    selections,
    authorization: saved.f.base.dependencies.authorization,
    verifier,
    clock: saved.f.base.dependencies.clock,
    digester: taskDigester,
  };
  const create = (
    patch: Partial<ProjectConceptSelectionApplicationDependencies> = {},
  ) =>
    new ProjectConceptSelectionApplicationService({
      ...dependencies,
      ...patch,
    });
  const service = create();
  const command = {
    reference: saved.f.reference,
    operationId,
    expectedOperationRevision: 3,
    resultIndex: 1,
    expectedSelectionRevision: 0,
    idempotencyKey: "selected-second-picture",
  };
  const query = {
    projectId: saved.query.projectId,
    assetId: saved.query.assetId,
  };
  return {
    saved,
    original,
    generated,
    state,
    verifier,
    authority,
    source,
    uiSource,
    dependencies,
    service,
    create,
    command,
    query,
    select: (
      input = command,
      origin: typeof source | typeof uiSource = source,
    ) =>
      service.selectConceptImage(taskActor, input, {
        authority,
        source: origin,
      }),
    read: () => service.getConceptSelection(taskActor, query),
    currentReference: () => ({
      ...saved.query,
      expectedProjectRevision: saved.f.state.project.revision,
      expectedAssetMetadataRevision: saved.f.state.asset.revision,
    }),
  };
}
