import {
  pluginInstallationDigest,
  pluginInstallationNamespaceId,
  pluginInstallationRecord,
} from "./plugin-installation-validation.ts";
import {
  parsePluginTaskAdmissionPin,
  type PluginTaskAdmissionPin,
} from "./plugin-task-admission.ts";

/** Explicit deployment mapping. It neither proves an installed selection nor grants permission. */
export type ProjectGenerationPublication = Readonly<{
  source: Readonly<{
    pluginId: string;
    packageDigest: string;
    contributionId: string;
  }>;
  target: Readonly<{
    pluginId: string;
    packageDigest: string;
    contributionId: string;
    action: string;
  }>;
}>;

export class ProjectGenerationPublicationError extends Error {
  readonly code: string;
  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "ProjectGenerationPublicationError";
    this.code = code;
  }
}

function checked<T>(code: string, read: () => T): T {
  try {
    return read();
  } catch (cause) {
    if (cause instanceof ProjectGenerationPublicationError) throw cause;
    throw new ProjectGenerationPublicationError(code, { cause });
  }
}

export function parseProjectGenerationPublication(
  input: unknown,
): ProjectGenerationPublication {
  return checked("project_generation_publication_invalid", () => {
    const publication = pluginInstallationRecord(input, ["source", "target"]);
    const source = pluginInstallationRecord(publication.source, [
      "pluginId",
      "packageDigest",
      "contributionId",
    ]);
    const target = pluginInstallationRecord(publication.target, [
      "pluginId",
      "packageDigest",
      "contributionId",
      "action",
    ]);
    return Object.freeze({
      source: Object.freeze({
        pluginId: pluginInstallationNamespaceId(source.pluginId),
        packageDigest: pluginInstallationDigest(source.packageDigest),
        contributionId: pluginInstallationNamespaceId(source.contributionId),
      }),
      target: Object.freeze({
        pluginId: pluginInstallationNamespaceId(target.pluginId),
        packageDigest: pluginInstallationDigest(target.packageDigest),
        contributionId: pluginInstallationNamespaceId(target.contributionId),
        action: pluginInstallationNamespaceId(target.action),
      }),
    });
  });
}

/** Capture each exact source once, before asynchronous package or policy preparation begins. */
export function captureProjectGenerationPublications(
  input: unknown,
): readonly ProjectGenerationPublication[] {
  return checked("project_generation_publications_invalid", () => {
    if (
      !Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Array.prototype
    )
      throw new Error("array_required");
    const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > 32 ||
      Reflect.ownKeys(input).length !== length + 1
    )
      throw new Error("array_fields_invalid");
    const sources = new Set<string>();
    const publications: ProjectGenerationPublication[] = [];
    for (let index = 0; index < length; index++) {
      const item = Object.getOwnPropertyDescriptor(input, String(index));
      if (!item?.enumerable || !Object.hasOwn(item, "value"))
        throw new Error("array_fields_invalid");
      const publication = parseProjectGenerationPublication(item.value);
      const source = JSON.stringify(publication.source);
      if (sources.has(source))
        throw new ProjectGenerationPublicationError(
          "project_generation_publication_source_duplicate",
        );
      sources.add(source);
      publications.push(publication);
    }
    return Object.freeze(publications);
  });
}

/** Identity compatibility only. Both live owners must separately prove their current authorities. */
export function assertProjectGenerationExecutionPublication(
  input: Readonly<{
    publication: ProjectGenerationPublication;
    sourcePin: PluginTaskAdmissionPin;
    executionPin: PluginTaskAdmissionPin;
  }>,
): void {
  checked("project_generation_execution_publication_mismatch", () => {
    const value = pluginInstallationRecord(input, [
      "publication",
      "sourcePin",
      "executionPin",
    ]);
    const publication = parseProjectGenerationPublication(value.publication);
    const source = parsePluginTaskAdmissionPin(value.sourcePin);
    const execution = parsePluginTaskAdmissionPin(value.executionPin);
    if (
      source.action !== "crewon.project-generations.v1.generateConcept" ||
      (["pluginId", "packageDigest", "contributionId"] as const).some(
        (field) => source[field] !== publication.source[field],
      ) ||
      (["pluginId", "packageDigest", "contributionId", "action"] as const).some(
        (field) => execution[field] !== publication.target[field],
      ) ||
      (
        ["tenantId", "spaceId", "profileId", "principalId", "actorId"] as const
      ).some((field) => source[field] !== execution[field])
    )
      throw new ProjectGenerationPublicationError(
        "project_generation_execution_publication_mismatch",
      );
  });
}
