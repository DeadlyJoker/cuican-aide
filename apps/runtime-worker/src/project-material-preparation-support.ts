import { types } from "node:util";
import {
  materialPreparationFields,
  type ProjectMaterialPreparationStore,
  type ProjectMaterialPreparationTarget,
} from "@crewon/application";
import {
  pluginInstallationDigest,
  pluginInstallationNamespaceId,
} from "@crewon/domain";
import {
  SqliteProjectMaterialPreparationStore,
  PostgresProjectMaterialPreparationStore,
} from "@crewon/store";

/** Host deployment review, including exact installed bytes. Never supplied by UI/Agent or inferred from a URL. */
export type ProjectMaterialTargetIdentity = Readonly<{
  pluginId: "crewon.short-drama";
  version: string;
  publisherId: string;
  packageDigest: string;
  manifestDigest: string;
  implementationDigest: string;
}>;
export function captureReviewedMaterialTargets(
  input: readonly ProjectMaterialTargetIdentity[],
) {
  if (
    !Array.isArray(input) ||
    types.isProxy(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length < 1 ||
    input.length > 32 ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    fail("identity_invalid");
  const identities = Array.from({ length: input.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      fail("identity_invalid");
    const r = materialPreparationFields(descriptor.value, [
      "pluginId",
      "version",
      "publisherId",
      "packageDigest",
      "manifestDigest",
      "implementationDigest",
    ]);
    if (
      r.pluginId !== "crewon.short-drama" ||
      typeof r.version !== "string" ||
      r.version.length > 32 ||
      !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(r.version)
    )
      fail("identity_invalid");
    return Object.freeze({
      pluginId: r.pluginId,
      version: r.version,
      publisherId: pluginInstallationNamespaceId(r.publisherId),
      packageDigest: pluginInstallationDigest(r.packageDigest),
      manifestDigest: pluginInstallationDigest(r.manifestDigest),
      implementationDigest: pluginInstallationDigest(r.implementationDigest),
    });
  });
  if (
    new Set(identities.map((i) => i.packageDigest)).size !== identities.length
  )
    fail("identity_invalid");
  return (target: ProjectMaterialPreparationTarget): void => {
    if (
      !identities.some(
        (i) =>
          i.pluginId === target.package.pluginId &&
          i.version === target.package.version &&
          i.publisherId === target.package.publisherId &&
          i.packageDigest === target.package.packageDigest &&
          i.manifestDigest === target.configuration.manifestDigest &&
          i.implementationDigest === target.configuration.implementationDigest,
      )
    )
      fail("target_unreviewed");
  };
}
/** Real durable journal only; instance overrides cannot return fabricated claim receipts. */
export function captureMaterialPreparationJournal(
  input: ProjectMaterialPreparationStore,
): ProjectMaterialPreparationStore {
  const prototype =
    input instanceof SqliteProjectMaterialPreparationStore
      ? SqliteProjectMaterialPreparationStore.prototype
      : input instanceof PostgresProjectMaterialPreparationStore
        ? PostgresProjectMaterialPreparationStore.prototype
        : null;
  if (!prototype || types.isProxy(input)) fail("journal_invalid");
  return Object.freeze({
    load: prototype.load.bind(input),
    reserve: prototype.reserve.bind(input),
    claimDispatch: prototype.claimDispatch.bind(input),
    advance: prototype.advance.bind(input),
  });
}
export function materialPreparationBound<
  T extends (...args: never[]) => unknown,
>(input: unknown, key: string): T {
  if (!input || typeof input !== "object" || types.isProxy(input))
    fail("dependency_invalid");
  for (
    let owner: object | null = input;
    owner;
    owner = Object.getPrototypeOf(owner)
  ) {
    const d = Object.getOwnPropertyDescriptor(owner, key);
    if (!d) continue;
    if (!Object.hasOwn(d, "value") || typeof d.value !== "function")
      fail("dependency_invalid");
    return d.value.bind(input) as T;
  }
  fail("dependency_invalid");
}
export function materialPreparationFail(code: string): never {
  fail(code);
}
function fail(code: string): never {
  throw new Error(`project_material_preparation_${code}`);
}
