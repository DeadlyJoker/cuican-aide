import {
  pluginInstallationDigest,
  pluginInstallationNamespaceId,
  pluginInstallationRecord,
  pluginInstallationVersion,
} from "./plugin-installation-validation.ts";
import {
  parsePluginTaskAdmissionPin,
  type PluginTaskAdmissionPin,
} from "./plugin-task-admission.ts";

/** Explicit query-only approval. It never changes the current generation publication. */
export type ProjectHistoricalQueryPublication = Readonly<{
  source: Readonly<{
    pluginId: string;
    packageDigest: string;
    contributionId: string;
  }>;
  target: Readonly<{
    pluginId: string;
    publisherId: string;
    version: string;
    packageDigest: string;
    manifestDigest: string;
    implementationDigest: string;
    contributionId: string;
    action: "image.query";
  }>;
}>;
export function parseProjectHistoricalQueryPublication(
  input: unknown,
): ProjectHistoricalQueryPublication {
  const v = pluginInstallationRecord(input, ["source", "target"]),
    s = pluginInstallationRecord(v.source, [
      "pluginId",
      "packageDigest",
      "contributionId",
    ]),
    t = pluginInstallationRecord(v.target, [
      "pluginId",
      "publisherId",
      "version",
      "packageDigest",
      "manifestDigest",
      "implementationDigest",
      "contributionId",
      "action",
    ]);
  if (t.action !== "image.query")
    throw new Error("project_historical_query_publication_invalid");
  return Object.freeze({
    source: Object.freeze({
      pluginId: pluginInstallationNamespaceId(s.pluginId),
      packageDigest: pluginInstallationDigest(s.packageDigest),
      contributionId: pluginInstallationNamespaceId(s.contributionId),
    }),
    target: Object.freeze({
      pluginId: pluginInstallationNamespaceId(t.pluginId),
      publisherId: pluginInstallationNamespaceId(t.publisherId),
      version: pluginInstallationVersion(t.version),
      packageDigest: pluginInstallationDigest(t.packageDigest),
      manifestDigest: pluginInstallationDigest(t.manifestDigest),
      implementationDigest: pluginInstallationDigest(t.implementationDigest),
      contributionId: pluginInstallationNamespaceId(t.contributionId),
      action: "image.query" as const,
    }),
  });
}
export function captureProjectHistoricalQueryPublications(
  input: unknown,
): readonly ProjectHistoricalQueryPublication[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype)
    throw new Error("project_historical_query_publications_invalid");
  const len = Object.getOwnPropertyDescriptor(input, "length")?.value;
  if (
    typeof len !== "number" ||
    !Number.isSafeInteger(len) ||
    len < 1 ||
    len > 32 ||
    Reflect.ownKeys(input).length !== len + 1
  )
    throw new Error("project_historical_query_publications_invalid");
  const seen = new Set<string>(),
    out: ProjectHistoricalQueryPublication[] = [];
  for (let i = 0; i < len; i++) {
    const d = Object.getOwnPropertyDescriptor(input, String(i));
    if (!d?.enumerable || !("value" in d))
      throw new Error("project_historical_query_publications_invalid");
    const p = parseProjectHistoricalQueryPublication(d.value),
      key = JSON.stringify(p);
    if (seen.has(key))
      throw new Error("project_historical_query_publication_duplicate");
    seen.add(key);
    out.push(p);
  }
  return Object.freeze(out);
}
export function assertProjectHistoricalQueryExecutionPublication(
  input: Readonly<{
    publication: ProjectHistoricalQueryPublication;
    sourcePin: PluginTaskAdmissionPin;
    executionPin: PluginTaskAdmissionPin;
  }>,
): void {
  const v = pluginInstallationRecord(input, [
      "publication",
      "sourcePin",
      "executionPin",
    ]),
    p = parseProjectHistoricalQueryPublication(v.publication),
    s = parsePluginTaskAdmissionPin(v.sourcePin),
    t = parsePluginTaskAdmissionPin(v.executionPin);
  if (
    s.action !==
      "crewon.project-historical-queries.v1.queryConceptGeneration" ||
    (["pluginId", "packageDigest", "contributionId"] as const).some(
      (k) => s[k] !== p.source[k],
    ) ||
    (
      [
        "pluginId",
        "publisherId",
        "version",
        "packageDigest",
        "contributionId",
        "action",
      ] as const
    ).some((k) => t[k] !== p.target[k]) ||
    (
      ["tenantId", "spaceId", "profileId", "principalId", "actorId"] as const
    ).some((k) => s[k] !== t[k])
  )
    throw new Error("project_historical_query_execution_publication_mismatch");
}
