import {
  assertProjectQueryReplay,
  extensionCanonicalJson,
  parseProjectQueryReference,
  parseProjectQueryLink,
  parsePluginTaskAdmissionPin,
  type PluginQueryTaskAdmission,
  type ProjectQueryLink,
  type ExtensionRunBinding,
  type ProjectGenerationLink,
  type ProjectQueryReference,
  CreativeProjectError,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import {
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitCurrent,
  captureCreativeProjectTransactionAuthority,
} from "./creative-project-commit-authority.ts";
import type { CreativeProjectCommitAuthority } from "./creative-project-store-port.ts";
import {
  creativeInput,
  creativeStored,
  creativeProjectUseCase,
} from "./creative-project-application-support.ts";
import {
  authorizeExtension,
  extensionScopeFor,
} from "./extension-application-support.ts";
import type {
  CreateExtensionTaskCommand,
  ExtensionTaskApplicationDependencies,
} from "./extension-task-application-service.ts";
import type { ExtensionMutationReceipt } from "./extension-store-port.ts";
import { projectGenerationHostFields } from "./project-generation-execution-authority.ts";
import { ProjectGenerationReadApplicationService } from "./project-generation-read-application-service.ts";
import {
  captureProjectQueryExecutionPublication,
  type CreatePublishedProjectQueryTaskInput,
  type ProjectQueryExecutionPublication,
} from "./project-query-execution-authority.ts";
import { projectQueryTaskReceipt } from "./project-query-task-receipt.ts";
import type { PluginQuerySource } from "./plugin-query-source.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import { queryAdmissionPin } from "./plugin-query-task-support.ts";

export type CapturedProjectQueryTask = Readonly<{
  reference: ProjectQueryReference;
  publication: ProjectQueryExecutionPublication;
  preflight: CreativeProjectCommitAuthority;
  transaction: CreativeProjectCommitAuthority;
}>;

export function capturePublishedProjectQueryTask(
  input: CreatePublishedProjectQueryTaskInput,
) {
  const value = projectGenerationHostFields(input, [
    "actor",
    "command",
    "reference",
    "publication",
    "sourcePin",
    "executionPin",
    "authority",
  ]);
  const publication = captureProjectQueryExecutionPublication({
    publication:
      value.publication as CreatePublishedProjectQueryTaskInput["publication"],
    sourcePin:
      value.sourcePin as CreatePublishedProjectQueryTaskInput["sourcePin"],
    executionPin:
      value.executionPin as CreatePublishedProjectQueryTaskInput["executionPin"],
  });
  const authority = captureCreativeProjectTransactionAuthority(
    value.authority as CreatePublishedProjectQueryTaskInput["authority"],
  );
  return Object.freeze({
    actor: value.actor as ActorContext,
    command: value.command as CreateExtensionTaskCommand,
    executionPin: publication.executionPin,
    captured: Object.freeze({
      reference: creativeInput(() =>
        parseProjectQueryReference(value.reference),
      ),
      publication,
      preflight: authority.preflight,
      transaction: authority.transaction,
    }) satisfies CapturedProjectQueryTask,
  });
}

/** Opt-in qualification around the original query Turn; no new generation admission or quote. */
export async function prepareProjectQueryTask(
  input: Readonly<{
    captured: CapturedProjectQueryTask;
    dependencies: ExtensionTaskApplicationDependencies;
    actor: ActorContext;
    command: CreateExtensionTaskCommand;
  }>,
) {
  const { captured, dependencies: d, actor, command } = input;
  const reads = d.projectGenerationReads;
  const projects = d.creativeProjects;
  if (
    !(reads instanceof ProjectGenerationReadApplicationService) ||
    projects === undefined ||
    d.extensions.projectQueryVersion !== "crewon.project-query-link.v1" ||
    d.extensions.projectQueryPublicationVersion !==
      "crewon.project-query-publication.v1" ||
    typeof d.extensions.loadProjectQueryLink !== "function"
  )
    throw new ApplicationError("conflict", "project_query_unavailable");
  const getSource = reads.getConceptGeneration.bind(reads);
  const loadQuery = d.extensions.loadProjectQueryLink.bind(d.extensions);
  const projectPolicy = projects.authorization.authorize.bind(
    projects.authorization,
  );
  const reference = captured.reference;
  const active = () => {
    assertCreativeProjectCommitActive(captured.preflight);
    assertCreativeProjectCommitActive(captured.transaction);
  };
  active();
  await assertCreativeProjectCommitCurrent(captured.preflight);
  active();
  const original = await getSource(actor, reference);
  active();
  if (original === null)
    throw new ApplicationError(
      "notFound",
      "project_query_generation_not_found",
    );
  const generationLink = original.link;
  if (
    command.intent.kind !== "query" ||
    command.intent.sourceRunId !== generationLink.binding.runId ||
    command.pluginId !== generationLink.binding.pluginId ||
    generationLink.ownerPrincipalId !== actor.principalId
  )
    throw new ApplicationError(
      "authorization",
      "project_query_source_mismatch",
    );
  const sidecar = Object.freeze({
    reference,
    generationLinkDigest: generationLink.contentDigest,
  });

  async function policy() {
    active();
    if (
      (
        await projectPolicy({
          actor,
          action: "creativeProject:read",
          resource: {
            kind: "creativeProject",
            tenantId: actor.tenantId,
            spaceId: actor.spaceId,
            projectId: reference.projectId,
          },
        })
      ).outcome !== "allow"
    )
      throw new ApplicationError("authorization", "authorization_denied");
    await authorizeExtension(
      d.authorization,
      actor,
      "extension:query",
      extensionScopeFor(actor, command.pluginId),
    );
    for (const request of [
      {
        actor,
        action: "run:read" as const,
        resource: {
          kind: "run" as const,
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          runId: generationLink.binding.runId,
          threadId: generationLink.binding.threadId,
        },
      },
      {
        actor,
        action: "thread:message:append" as const,
        resource: {
          kind: "thread" as const,
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          threadId: command.threadId,
        },
      },
      {
        actor,
        action: "run:create" as const,
        resource: {
          kind: "run" as const,
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          threadId: command.threadId,
          runId: null,
        },
      },
    ])
      if ((await d.authorization.authorize(request)).outcome !== "allow")
        throw new ApplicationError("authorization", "authorization_denied");
    await assertCreativeProjectCommitCurrent(captured.transaction);
    active();
  }
  const transaction: CreativeProjectCommitAuthority = Object.freeze({
    assertCurrent: policy,
    assertActive: active,
  });
  await policy();
  return Object.freeze({
    sidecar,
    commitOptions: Object.freeze({
      projectQueryAuthority: transaction,
      projectQueryPublication: captured.publication,
    }),
    receipt: (base: ExtensionMutationReceipt) =>
      projectQueryTaskReceipt(base, sidecar, d.digester),
    assertSource(source: PluginQuerySource) {
      assertPaidGenerationSource(source, generationLink);
    },
    async assertCurrent() {
      await assertCreativeProjectCommitCurrent(captured.preflight);
      active();
      await policy();
      const latest = await getSource(actor, reference);
      active();
      if (
        latest === null ||
        extensionCanonicalJson(latest.link) !==
          extensionCanonicalJson(generationLink)
      )
        throw new ApplicationError("conflict", "project_query_source_changed");
      await assertCreativeProjectCommitCurrent(captured.preflight);
      active();
    },
    async assertSaved(
      binding: ExtensionRunBinding,
      receipt: ExtensionMutationReceipt,
      historicalAdmission: PluginQueryTaskAdmission | null = null,
    ) {
      const saved = await loadQuery({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        runId: binding.runId,
      });
      if (saved === null)
        throw new ApplicationError("internal", "project_query_link_missing");
      creativeStored(() => {
        const publication = projectQueryReplayPublication({
          link: saved,
          current: captured.publication,
          historicalAdmission,
          digester: d.digester,
        });
        assertProjectQueryReplay(
          {
            link: saved,
            reference,
            generationLinkDigest: generationLink.contentDigest,
            actor,
            binding,
            receipt,
            ...publication,
          },
          d.digester,
        );
      });
    },
  });
}

/** Only a verified receipt admission permits historical epochs from the actual saved link. */
export function projectQueryReplayPublication(
  input: Readonly<{
    link: ProjectQueryLink;
    current: ProjectQueryExecutionPublication;
    historicalAdmission: PluginQueryTaskAdmission | null;
    digester: ContentDigester;
  }>,
): ProjectQueryExecutionPublication {
  const current = captureProjectQueryExecutionPublication(input.current);
  if (input.historicalAdmission === null) return current;
  const link = parseProjectQueryLink(input.link, input.digester);
  const admission = input.historicalAdmission;
  const sourcePin = parsePluginTaskAdmissionPin({
    ...current.sourcePin,
    authorityEpoch: link.sourcePin.authorityEpoch,
  });
  const executionPin = parsePluginTaskAdmissionPin({
    ...current.executionPin,
    authorityEpoch: link.executionPin.authorityEpoch,
  });
  if (
    extensionCanonicalJson(sourcePin) !==
      extensionCanonicalJson(link.sourcePin) ||
    extensionCanonicalJson(executionPin) !==
      extensionCanonicalJson(link.executionPin) ||
    extensionCanonicalJson(queryAdmissionPin(admission)) !==
      extensionCanonicalJson(link.executionPin) ||
    extensionCanonicalJson(current.publication) !==
      extensionCanonicalJson(link.publication) ||
    admission.runId !== link.binding.runId ||
    admission.threadId !== link.binding.threadId ||
    admission.extensionBindingDigest !== link.binding.bindingDigest ||
    admission.operationId !== link.operationId ||
    admission.idempotencyKey !== link.receipt.idempotencyKey ||
    admission.requestDigest !== link.receipt.requestDigest
  )
    throw new ApplicationError("conflict", "project_query_replay_mismatch");
  return Object.freeze({
    publication: current.publication,
    sourcePin,
    executionPin,
  });
}

function assertPaidGenerationSource(
  source: PluginQuerySource,
  link: ProjectGenerationLink,
) {
  if (
    extensionCanonicalJson(source.binding) !==
      extensionCanonicalJson(link.binding) ||
    source.admission.principalId !== link.ownerPrincipalId ||
    extensionCanonicalJson({
      actorId: source.admission.actorId,
      idempotencyKey: source.admission.idempotencyKey,
      requestDigest: source.admission.requestDigest,
    }) !== extensionCanonicalJson(link.receipt)
  )
    throw new ApplicationError("conflict", "project_query_source_mismatch");
}

/** Keep optional project-query conflicts scoped; ordinary query error behavior remains unchanged. */
export async function commitProjectQueryTask<T>(
  commit: () => Promise<T>,
): Promise<T> {
  try {
    return await commit();
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    if (error instanceof CreativeProjectError)
      return creativeProjectUseCase(async () => {
        throw error;
      });
    const code = error instanceof Error ? error.message : "";
    if (
      [
        "project_query_unavailable",
        "project_query_source_mismatch",
        "project_query_source_configuration_mismatch",
        "project_query_receipt_conflict",
        "plugin_task_admission_conflict",
      ].includes(code)
    )
      throw new ApplicationError("conflict", code, { cause: error });
    throw error;
  }
}
