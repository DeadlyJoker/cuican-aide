import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  ApplicationError,
  type ActorContext,
  type ContentDigester,
  type CreativeProjectStore,
  type PluginInstallationStore,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parseConceptAssetRevision,
  parseInstalledPluginPackage,
  parsePluginSelection,
  validateCreativeProject,
  type InstalledPluginPackage,
  type PluginProfileScope,
  type PluginSelection,
  type PluginTaskAdmissionPin,
  type ProjectGenerationReference,
} from "@crewon/domain";
import {
  verifyLocalPluginPackage,
  type PluginActivationCandidate,
} from "@crewon/plugin-host";

export function generationDenied(code: string): never {
  throw new ApplicationError("authorization", code);
}

export function generationSame(a: unknown, b: unknown): boolean {
  return extensionCanonicalJson(a) === extensionCanonicalJson(b);
}

/** Bind only actual data methods; configuration getters are never evaluated. */
export function generationMethod<T extends object, K extends keyof T>(
  input: T,
  name: K,
): T[K] {
  if (input === null || typeof input !== "object") invalid();
  for (
    let owner: object | null = input, depth = 0;
    owner && depth < 32;
    depth++
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor !== undefined) {
      if (
        !Object.hasOwn(descriptor, "value") ||
        typeof descriptor.value !== "function"
      )
        invalid();
      return Function.prototype.bind.call(descriptor.value, input) as T[K];
    }
    owner = Object.getPrototypeOf(owner);
  }
  invalid();
}

export function generationInstallRoot(input: unknown): string {
  if (
    typeof input !== "string" ||
    !isAbsolute(input) ||
    resolve(input) !== input ||
    input.trim() !== input ||
    input.length > 4096 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input)
  )
    invalid();
  return input;
}

export async function generationInstalledPackage(
  input: Readonly<{
    installations: Pick<
      PluginInstallationStore,
      "loadSelection" | "loadPackage"
    >;
    scope: PluginProfileScope;
    pluginId: string;
    packageDigest: string;
    expectedSelection?: PluginSelection;
    expectedPackage?: InstalledPluginPackage;
    assertActive(): void;
  }>,
): Promise<
  Readonly<{ selection: PluginSelection; package: InstalledPluginPackage }>
> {
  const selected = await input.installations.loadSelection({
    scope: input.scope,
    pluginId: input.pluginId,
  });
  input.assertActive();
  if (selected === null)
    generationDenied("project_generation_plugin_selection_changed");
  const selection = parsePluginSelection(selected);
  if (
    selection.state !== "enabled" ||
    selection.selectedPackageDigest !== input.packageDigest ||
    !generationSameScope(selection, input.scope) ||
    (input.expectedSelection !== undefined &&
      !generationSame(selection, input.expectedSelection))
  )
    generationDenied("project_generation_plugin_selection_changed");
  const raw = await input.installations.loadPackage({
    scope: input.scope,
    packageDigest: input.packageDigest,
  });
  input.assertActive();
  if (raw === null)
    generationDenied("project_generation_plugin_package_changed");
  const pkg = parseInstalledPluginPackage(raw);
  if (
    pkg.pluginId !== input.pluginId ||
    pkg.packageDigest !== input.packageDigest ||
    pkg.publisherId !== selection.publisherId ||
    !generationSameScope(pkg, input.scope) ||
    (input.expectedPackage !== undefined &&
      !generationSame(pkg, input.expectedPackage))
  )
    generationDenied("project_generation_plugin_package_changed");
  return Object.freeze({ selection, package: pkg });
}

export function generationSameScope(
  input: PluginProfileScope,
  scope: PluginProfileScope,
): boolean {
  return (
    input.tenantId === scope.tenantId &&
    input.spaceId === scope.spaceId &&
    input.profileId === scope.profileId
  );
}

export async function generationCandidate(
  input: Readonly<{
    installRoot: string;
    package: InstalledPluginPackage;
    signal: AbortSignal;
    expected?: PluginActivationCandidate;
  }>,
): Promise<PluginActivationCandidate> {
  const root = await realpath(input.installRoot);
  const stats = await lstat(root);
  input.signal.throwIfAborted();
  if (
    !stats.isDirectory() ||
    (stats.mode & 0o022) !== 0 ||
    (typeof process.getuid === "function" && stats.uid !== process.getuid())
  )
    generationDenied("project_generation_install_root_changed");
  const directory = join(
    root,
    "packages",
    input.package.packageDigest.slice(7),
  );
  const verified = await verifyLocalPluginPackage({
    directory,
    signal: input.signal,
  });
  input.signal.throwIfAborted();
  const candidate = Object.freeze({
    descriptor: verified.descriptor,
    packageDigest: verified.packageDigest,
  });
  if (
    verified.directory !== directory ||
    candidate.packageDigest !== input.package.packageDigest ||
    candidate.descriptor.pluginId !== input.package.pluginId ||
    candidate.descriptor.publisherId !== input.package.publisherId ||
    candidate.descriptor.version !== input.package.version ||
    (input.expected !== undefined && !generationSame(candidate, input.expected))
  )
    generationDenied("project_generation_plugin_bytes_changed");
  return candidate;
}

/** Historical inputs remain readable after archive; fresh admission checks current CAS in Application/Store. */
export async function generationSavedPrompt(
  input: Readonly<{
    projects: Pick<CreativeProjectStore, "loadProject" | "loadConceptRevision">;
    actor: ActorContext;
    reference: ProjectGenerationReference;
    digester: ContentDigester;
    assertActive(): void;
  }>,
): Promise<string> {
  const { tenantId, spaceId, principalId } = input.actor;
  const owner = Object.freeze({ tenantId, spaceId, principalId });
  const rawProject = await input.projects.loadProject({
    owner,
    projectId: input.reference.projectId,
  });
  input.assertActive();
  if (rawProject === null)
    throw new ApplicationError("notFound", "creative_project_not_found");
  const project = validateCreativeProject(rawProject);
  if (
    project.tenantId !== tenantId ||
    project.spaceId !== spaceId ||
    project.ownerPrincipalId !== principalId ||
    project.projectId !== input.reference.projectId
  )
    generationDenied("project_generation_source_owner_changed");
  const raw = await input.projects.loadConceptRevision({
    owner,
    projectId: input.reference.projectId,
    assetId: input.reference.assetId,
    assetRevision: input.reference.assetRevision,
  });
  input.assertActive();
  if (raw === null)
    throw new ApplicationError(
      "notFound",
      "creative_project_asset_revision_not_found",
    );
  const revision = parseConceptAssetRevision(raw, input.digester);
  if (
    revision.tenantId !== tenantId ||
    revision.spaceId !== spaceId ||
    revision.projectId !== project.projectId ||
    revision.assetId !== input.reference.assetId ||
    revision.assetRevision !== input.reference.assetRevision
  )
    generationDenied("project_generation_source_changed");
  return revision.prompt;
}

export function generationSelectionMatches(
  selection: PluginSelection,
  pin: PluginTaskAdmissionPin,
): boolean {
  return (
    selection.state === "enabled" &&
    generationSameScope(selection, pin) &&
    selection.pluginId === pin.pluginId &&
    selection.publisherId === pin.publisherId &&
    selection.selectedPackageDigest === pin.packageDigest &&
    selection.revision === pin.selectionRevision
  );
}

function invalid(): never {
  throw new Error("installed_plugin_project_generation_configuration_invalid");
}
