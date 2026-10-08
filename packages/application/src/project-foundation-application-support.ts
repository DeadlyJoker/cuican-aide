import {
  creativeProjectBriefText,
  creativeProjectDigest,
  creativeProjectOpaqueId,
  creativeProjectRevision,
  creativeProjectTitle,
  extensionCanonicalJson,
  parseProjectSource,
  validateProjectCreationParameters,
  validateProjectFoundation,
  validateProjectProposal,
  type CreativeProject,
  type ProjectFoundation,
  type ProjectProposal,
  type ProjectSource,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import {
  checkedCreativeBrief,
  checkedCreativeProject,
  creativeInput,
  creativeOwner,
} from "./creative-project-application-support.ts";
import type {
  CreateProjectFoundationCommand,
  ProjectFoundationMutationCommand,
  ProjectSourceUploadReference,
} from "./project-foundation-commands.ts";
import type {
  ProjectFoundationMutationKind,
  ProjectFoundationMutationResult,
} from "./project-foundation-store-port.ts";

export function foundationFailure(
  code = "project_foundation_store_result_invalid",
): never {
  throw new Error(code);
}
/** Commands are small JSON values. Arrays are copied through their descriptors, never getters. */
export function foundationRecord(input: unknown, fields: readonly string[]) {
  let nodes = 0,
    bytes = 0;
  const ancestors = new WeakSet<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 1_024 || depth > 8)
      throw new Error("project_foundation_command_limit");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      bytes += new TextEncoder().encode(value).length;
      if (bytes > 65_536) throw new Error("project_foundation_command_limit");
      return value;
    }
    if (value === null || typeof value !== "object" || ancestors.has(value))
      throw new Error("project_foundation_command_invalid");
    const array = Array.isArray(value);
    if (
      array
        ? Object.getPrototypeOf(value) !== Array.prototype
        : ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      throw new Error("project_foundation_command_invalid");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string") ||
      Object.values(descriptors).some((item) => !Object.hasOwn(item, "value"))
    )
      throw new Error("project_foundation_command_invalid");
    ancestors.add(value);
    let result: unknown;
    if (array) {
      const length = descriptors.length?.value;
      if (
        !Number.isInteger(length) ||
        length > 256 ||
        keys.length !== length + 1
      )
        throw new Error("project_foundation_command_invalid");
      result = Array.from({ length }, (_, index) => {
        const item = descriptors[String(index)];
        if (item === undefined || !item.enumerable)
          throw new Error("project_foundation_command_invalid");
        return visit(item.value, depth + 1);
      });
    } else {
      if (
        keys.length > 32 ||
        Object.values(descriptors).some((item) => !item.enumerable)
      )
        throw new Error("project_foundation_command_invalid");
      result = Object.fromEntries(
        (keys as string[])
          .sort()
          .map((key) => [key, visit(descriptors[key]!.value, depth + 1)]),
      );
    }
    ancestors.delete(value);
    return Object.freeze(result);
  };
  const copied = visit(input, 0);
  if (
    copied === null ||
    typeof copied !== "object" ||
    Array.isArray(copied) ||
    Object.keys(copied).sort().join("\0") !== [...fields].sort().join("\0") ||
    new TextEncoder().encode(JSON.stringify(copied)).length > 65_536
  )
    throw new Error("project_foundation_command_invalid");
  return copied as Record<string, unknown>;
}
export function foundationLimit(value: unknown, maximum = 50) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  )
    throw new Error("project_foundation_limit_invalid");
  return value;
}
function sourceReference(input: unknown): ProjectSourceUploadReference {
  const value = foundationRecord(input, ["uploadId", "fileDigest"]);
  return Object.freeze({
    uploadId: creativeProjectOpaqueId(value.uploadId),
    fileDigest: creativeProjectDigest(value.fileDigest),
  });
}
function startMode(input: unknown): "confirm-plan" | "direct-script" {
  if (input !== "confirm-plan" && input !== "direct-script")
    throw new Error("project_foundation_start_mode_invalid");
  return input;
}
export function foundationCommand(
  kind: ProjectFoundationMutationKind,
  input: unknown,
): ProjectFoundationMutationCommand {
  return creativeInput(() => {
    const base = ["projectId", "expectedFoundationRevision", "idempotencyKey"];
    const fields = {
      "create-project": [
        "title",
        "briefText",
        "origin",
        "parameters",
        "creativeStartMode",
        "sourceUpload",
        "idempotencyKey",
      ],
      "update-parameters": [...base, "parameters"],
      "append-source": [...base, "sourceUpload"],
      "save-proposal": [...base, "expectedProposalRevision", "kind", "text"],
      "confirm-proposal": [...base, "proposalRevision", "proposalDigest"],
      "choose-direct-script": [...base, "creativeStartMode"],
    }[kind];
    const value = foundationRecord(input, fields);
    const idempotencyKey = creativeProjectOpaqueId(value.idempotencyKey);
    if (kind === "create-project") {
      if (value.origin !== "creative" && value.origin !== "novel")
        throw new Error("project_foundation_origin_invalid");
      if (
        value.origin === "novel" &&
        (value.sourceUpload === null || value.creativeStartMode !== null)
      )
        throw new Error("project_foundation_novel_creation_invalid");
      return Object.freeze({
        title: creativeProjectTitle(value.title),
        briefText: creativeProjectBriefText(value.briefText),
        origin: value.origin,
        parameters: validateProjectCreationParameters(
          value.parameters,
          value.origin,
        ),
        creativeStartMode:
          value.origin === "creative"
            ? startMode(value.creativeStartMode)
            : null,
        sourceUpload:
          value.sourceUpload === null
            ? null
            : sourceReference(value.sourceUpload),
        idempotencyKey,
      });
    }
    const common = {
      projectId: creativeProjectOpaqueId(value.projectId),
      expectedFoundationRevision: creativeProjectRevision(
        value.expectedFoundationRevision,
      ),
      idempotencyKey,
    };
    switch (kind) {
      case "update-parameters": {
        const parameters = foundationRecord(value.parameters, [
          "genre",
          "episodeMode",
          "episodeCount",
          "episodeDurationSeconds",
          "aspectRatio",
          "visualStyle",
          "needsCharacters",
          "needsArt",
          "adaptation",
        ]);
        return Object.freeze({
          ...common,
          parameters: validateProjectCreationParameters(
            parameters,
            parameters.adaptation === null ? "creative" : "novel",
          ),
        });
      }
      case "append-source":
        return Object.freeze({
          ...common,
          sourceUpload: sourceReference(value.sourceUpload),
        });
      case "save-proposal": {
        if (value.kind !== "creative-plan" && value.kind !== "novel-adaptation")
          throw new Error("project_proposal_kind_invalid");
        return Object.freeze({
          ...common,
          expectedProposalRevision: creativeProjectRevision(
            value.expectedProposalRevision,
            { minimum: 0 },
          ),
          kind: value.kind,
          text: creativeProjectBriefText(value.text),
        });
      }
      case "confirm-proposal":
        return Object.freeze({
          ...common,
          proposalRevision: creativeProjectRevision(value.proposalRevision),
          proposalDigest: creativeProjectDigest(value.proposalDigest),
        });
      case "choose-direct-script":
        return Object.freeze({
          ...common,
          creativeStartMode: startMode(value.creativeStartMode),
        });
    }
  });
}
export function foundationStored<T>(work: () => T): T {
  try {
    return work();
  } catch (cause) {
    throw new ApplicationError(
      "internal",
      "project_foundation_store_result_invalid",
      { cause },
    );
  }
}
export function foundationEqual(left: unknown, right: unknown) {
  if (extensionCanonicalJson(left) !== extensionCanonicalJson(right))
    foundationFailure();
}
export function checkedFoundation(
  input: unknown,
  project: CreativeProject,
): ProjectFoundation {
  return foundationStored(() => {
    const value = validateProjectFoundation(input);
    checkScope(value, project);
    if (value.ownerPrincipalId !== project.ownerPrincipalId)
      foundationFailure();
    return value;
  });
}
export function checkedSource(
  input: unknown,
  project: CreativeProject,
  revision?: number,
): ProjectSource {
  return foundationStored(() => {
    const value = parseProjectSource(input);
    checkScope(value, project);
    if (revision !== undefined && value.revision !== revision)
      foundationFailure();
    return value;
  });
}
export function checkedProposal(
  input: unknown,
  project: CreativeProject,
  digester: ContentDigester,
  revision?: number,
): ProjectProposal {
  return foundationStored(() => {
    const value = validateProjectProposal(input);
    checkScope(value, project);
    if (
      value.ownerPrincipalId !== project.ownerPrincipalId ||
      (revision !== undefined && value.revision !== revision)
    )
      foundationFailure();
    const { contentDigest, ...body } = value;
    if (contentDigest !== digester.sha256(extensionCanonicalJson(body)))
      foundationFailure();
    return value;
  });
}
function checkScope(
  value: { tenantId: string; spaceId: string; projectId: string },
  project: CreativeProject,
) {
  if (
    value.tenantId !== project.tenantId ||
    value.spaceId !== project.spaceId ||
    value.projectId !== project.projectId
  )
    foundationFailure();
}
export function checkedFoundationResult(
  input: unknown,
  actor: ActorContext,
  kind: ProjectFoundationMutationKind,
  command: ProjectFoundationMutationCommand,
  digester: ContentDigester,
): ProjectFoundationMutationResult {
  return foundationStored(() => {
    const value = foundationRecord(input, [
      "kind",
      "disposition",
      "project",
      "foundation",
      "brief",
      "source",
      "proposal",
    ]);
    if (
      value.kind !== kind ||
      (value.disposition !== "committed" && value.disposition !== "replayed")
    )
      foundationFailure();
    const project = checkedCreativeProject(
      value.project,
      creativeOwner(actor),
      "projectId" in command ? command.projectId : undefined,
    );
    const foundation = checkedFoundation(value.foundation, project);
    const source =
      value.source === null ? null : checkedSource(value.source, project);
    const proposal =
      value.proposal === null
        ? null
        : checkedProposal(value.proposal, project, digester);
    const brief =
      value.brief === null
        ? null
        : checkedCreativeBrief(value.brief, project, digester, 1);
    if (kind === "create-project") {
      const requested = command as CreateProjectFoundationCommand;
      if (
        project.title !== requested.title ||
        project.state !== "active" ||
        project.revision !== 2 ||
        project.latestBriefRevision !== 1 ||
        brief === null ||
        brief.text !== requested.briefText ||
        foundation.origin !== requested.origin ||
        foundation.revision !== 1 ||
        foundation.parametersRevision !== 1 ||
        foundation.confirmedProposal !== null ||
        foundation.creativeStartMode !== requested.creativeStartMode ||
        proposal !== null ||
        project.createdByActorId !== actor.actorId ||
        brief.createdByActorId !== actor.actorId ||
        foundation.createdByActorId !== actor.actorId ||
        foundation.updatedByActorId !== actor.actorId ||
        foundation.createdAt !== project.createdAt ||
        foundation.updatedAt !== project.createdAt ||
        brief.createdAt !== project.createdAt
      )
        foundationFailure();
      foundationEqual(foundation.parameters, requested.parameters);
      if (
        requested.sourceUpload === null
          ? source !== null || foundation.source !== null
          : source === null ||
            source.revision !== 1 ||
            source.fileDigest !== requested.sourceUpload.fileDigest
      )
        foundationFailure();
    } else {
      const requested = command as Exclude<
        ProjectFoundationMutationCommand,
        CreateProjectFoundationCommand
      >;
      if (
        brief !== null ||
        foundation.revision < requested.expectedFoundationRevision ||
        foundation.revision > requested.expectedFoundationRevision + 1
      )
        foundationFailure();
      if ("parameters" in requested) {
        foundationEqual(foundation.parameters, requested.parameters);
        if (
          source !== null ||
          proposal !== null ||
          (foundation.revision > requested.expectedFoundationRevision &&
            foundation.confirmedProposal !== null)
        )
          foundationFailure();
      } else if ("sourceUpload" in requested) {
        if (
          source === null ||
          source.fileDigest !== requested.sourceUpload.fileDigest ||
          foundation.revision !== requested.expectedFoundationRevision + 1 ||
          foundation.confirmedProposal !== null ||
          proposal !== null
        )
          foundationFailure();
      } else if ("text" in requested) {
        if (
          foundation.revision !== requested.expectedFoundationRevision ||
          source !== null ||
          proposal === null ||
          proposal.revision !== requested.expectedProposalRevision + 1 ||
          proposal.text !== requested.text ||
          proposal.kind !== requested.kind ||
          proposal.foundationRevision !== foundation.revision ||
          proposal.parametersRevision !== foundation.parametersRevision ||
          proposal.createdByActorId !== actor.actorId
        )
          foundationFailure();
        foundationEqual(proposal.source, foundation.source);
      } else if ("proposalRevision" in requested) {
        if (
          source !== null ||
          proposal === null ||
          proposal.revision !== requested.proposalRevision ||
          proposal.contentDigest !== requested.proposalDigest ||
          proposal.foundationRevision !== foundation.revision - 1 ||
          proposal.parametersRevision !== foundation.parametersRevision
        )
          foundationFailure();
        foundationEqual(foundation.confirmedProposal, {
          revision: proposal.revision,
          digest: proposal.contentDigest,
        });
        foundationEqual(proposal.source, foundation.source);
      } else if (
        foundation.creativeStartMode !== requested.creativeStartMode ||
        foundation.origin !== "creative" ||
        source !== null ||
        proposal !== null ||
        (foundation.revision > requested.expectedFoundationRevision &&
          foundation.confirmedProposal !== null)
      )
        foundationFailure();
    }
    if (source !== null) {
      foundationEqual(foundation.source, {
        revision: source.revision,
        digest: source.digest,
      });
      if (
        source.createdByActorId !== actor.actorId ||
        source.createdAt !== foundation.updatedAt
      )
        foundationFailure();
    }
    return Object.freeze({
      kind,
      disposition: value.disposition,
      project,
      foundation,
      brief,
      source,
      proposal,
    });
  });
}
export async function foundationUseCase<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof ApplicationError) throw cause;
    const code =
      cause instanceof Error
        ? "code" in cause && typeof cause.code === "string"
          ? cause.code
          : cause.message
        : "";
    if (/owner_mismatch|scope_mismatch/u.test(code))
      throw new ApplicationError("authorization", code, { cause });
    if (
      /^project_proposal_kind_mismatch$|^project_foundation_(?:adaptation_not_applicable|novel_parameters_required|start_mode_invalid)$/u.test(
        code,
      )
    )
      throw new ApplicationError("validation", code, { cause });
    if (/not_found|source_required|proposal_required/u.test(code))
      throw new ApplicationError("notFound", code, { cause });
    if (
      /conflict|stale|archived|revision_exhausted|proposal_binding|proposal_unconfirmed/u.test(
        code,
      )
    )
      throw new ApplicationError("conflict", code, { cause });
    throw new ApplicationError(
      "internal",
      "project_foundation_service_unavailable",
      { cause },
    );
  }
}
