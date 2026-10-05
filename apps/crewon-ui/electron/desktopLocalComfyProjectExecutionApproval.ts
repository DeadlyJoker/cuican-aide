import {
  desktopInstalledPluginRecord,
  desktopInstalledPluginExactKeys,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";
import { createHash } from "node:crypto";
import {
  type DesktopProjectExecutionConfiguration,
  parsePluginPackageDescriptor,
  type InstalledPluginPeerCatalogEntry,
  type PluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import {
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
} from "@crewon/domain";
import {
  parseDesktopPluginApproval,
  type DesktopPluginApprovalSettings,
} from "./desktopPluginBootstrap.ts";

/** Explicit first-party Comfy project binding. Data only; Control still rechecks every target and permission. */
export function composeDesktopLocalComfyProjectExecutionApproval(
  input: Readonly<{
    approval: DesktopPluginApprovalSettings;
    source: Readonly<{
      descriptor: PluginPackageDescriptor;
      packageDigest: string;
      contributionId: string;
    }>;
    target: Readonly<{
      descriptor: PluginPackageDescriptor;
      contributionId: string;
      entry: Pick<
        InstalledPluginPeerCatalogEntry,
        "identity" | "configuration" | "configuredTarget"
      >;
    }>;
  }>,
): DesktopPluginApprovalSettings {
  const approval = parseDesktopPluginApproval(input.approval);
  const source = parsePluginPackageDescriptor(input.source.descriptor),
    target = parsePluginPackageDescriptor(input.target.descriptor);
  const identityRecord = desktopInstalledPluginRecord(
    input.target.entry.identity,
  );
  desktopInstalledPluginExactKeys(identityRecord, [
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
    "manifestDigest",
    "implementationDigest",
  ]);
  const identity =
    identityRecord as unknown as InstalledPluginPeerCatalogEntry["identity"];
  const config = parseExtensionConfiguration(input.target.entry.configuration, {
    sha256: (value) =>
      `sha256:${createHash("sha256").update(value).digest("hex")}`,
  });
  parseExtensionExecutionTarget(input.target.entry.configuredTarget);
  const unifiedShortDrama =
    target.pluginId === "crewon.short-drama" &&
    source.pluginId === target.pluginId &&
    source.publisherId === target.publisherId &&
    source.version === target.version &&
    input.source.packageDigest === identity.packageDigest &&
    input.source.contributionId === input.target.contributionId;
  if (
    (target.pluginId !== "crewon.comfyui-krea2" && !unifiedShortDrama) ||
    target.entrypoints.node === null ||
    target.businessManifestPath === null ||
    identity.pluginId !== target.pluginId ||
    identity.publisherId !== target.publisherId ||
    identity.version !== target.version ||
    config.pluginId !== identity.pluginId ||
    config.pluginVersion !== identity.version ||
    config.manifestDigest !== identity.manifestDigest ||
    config.implementationDigest !== identity.implementationDigest
  )
    invalid();
  const published = (
    descriptor: PluginPackageDescriptor,
    digest: string,
    contributionId: string,
  ) =>
    descriptor.entrypoints.ui !== null &&
    descriptor.contributions.some(
      (entry) =>
        entry.id === contributionId &&
        entry.kind === "module" &&
        entry.slot === "main.content",
    ) &&
    approval.sources.some(
      (entry) =>
        entry.pluginId === descriptor.pluginId &&
        entry.publisherId === descriptor.publisherId &&
        entry.version === descriptor.version &&
        entry.packageDigest === digest,
    ) &&
    approval.publications.some(
      (entry) =>
        entry.pluginId === descriptor.pluginId &&
        entry.publisherId === descriptor.publisherId &&
        entry.packageDigest === digest &&
        entry.publicAssets.includes(descriptor.entrypoints.ui!.path),
    );
  if (
    !published(
      source,
      input.source.packageDigest,
      input.source.contributionId,
    ) ||
    !published(target, identity.packageDigest, input.target.contributionId)
  )
    invalid();
  for (const service of [
    "crewon.creative-projects",
    "crewon.plugin-ui-recovery",
    "crewon.project-generation-reads",
    "crewon.project-generations",
    "crewon.project-generation-queries",
    "crewon.project-generation-selections",
    "crewon.project-generation-contexts",
  ]) {
    if (
      !source.requires.some(
        (entry) => entry.service === service && entry.apiVersion === "1",
      )
    )
      invalid();
  }
  const sourcePublication = {
    pluginId: source.pluginId,
    packageDigest: input.source.packageDigest,
    contributionId: input.source.contributionId,
  };
  const targetPublication = {
    pluginId: identity.pluginId,
    packageDigest: identity.packageDigest,
    contributionId: input.target.contributionId,
  };
  const previous: Omit<
    Partial<DesktopProjectExecutionConfiguration>,
    "version"
  > = approval.schemaVersion === "crewon.desktop-plugin-approval.v1"
    ? {}
    : (() => {
        const { version: _version, ...metadata } = approval.projects;
        return metadata;
      })();
  const same = (entry: {
    pluginId: string;
    packageDigest: string;
    contributionId: string;
  }) =>
    entry.pluginId === sourcePublication.pluginId &&
    entry.packageDigest === sourcePublication.packageDigest &&
    entry.contributionId === sourcePublication.contributionId;
  const merge = (
    entries: readonly (typeof sourcePublication)[] | undefined,
  ) => [...(entries ?? []).filter((entry) => !same(entry)), sourcePublication];
  const mapping = (
    entries:
      | readonly Readonly<{
          source: typeof sourcePublication;
          target: typeof targetPublication & { action: string };
        }>[]
      | undefined,
    action: string,
  ) => ({
    publications: [
      ...(entries ?? []).filter((entry) => !same(entry.source)),
      { source: sourcePublication, target: { ...targetPublication, action } },
    ],
  });
  const identitySelection = {
    ...(unifiedShortDrama ? { pluginId: "crewon.short-drama" as const } : {}),
    pluginVersion: identity.version,
    manifestDigest: identity.manifestDigest,
    implementationDigest: identity.implementationDigest,
  };
  if (
    "resultSelections" in previous &&
    previous.resultSelections !== undefined &&
    previous.resultSelections.adapter !== "comfyui-krea2"
  )
    invalid();
  return parseDesktopPluginApproval({
    ...approval,
    schemaVersion: "crewon.desktop-plugin-approval.v3",
    projects: {
      ...previous,
      version: "crewon.desktop-project-execution.v1",
      pluginUi: {
        publications: merge(
          "pluginUi" in previous ? previous.pluginUi?.publications : undefined,
        ),
      },
      generationReads: { version: "crewon.project-generation-read.v1" },
      generationReadUi: {
        publications: merge(
          "generationReadUi" in previous
            ? previous.generationReadUi?.publications
            : undefined,
        ),
      },
      pluginGenerations: mapping(
        "pluginGenerations" in previous
          ? previous.pluginGenerations?.publications
          : undefined,
        "image.generate",
      ),
      pluginQueries: mapping(
        "pluginQueries" in previous
          ? previous.pluginQueries?.publications
          : undefined,
        "image.query",
      ),
      resultSelections: {
        version: "crewon.project-concept-selection.v1",
        adapter: "comfyui-krea2",
        identities: [
          ...("resultSelections" in previous
            ? (previous.resultSelections?.identities ?? [])
            : []
          ).filter(
            (entry) =>
              (entry.pluginId ?? "crewon.comfyui-krea2") !==
                identity.pluginId ||
              entry.pluginVersion !== identity.version ||
              entry.manifestDigest !== identity.manifestDigest ||
              entry.implementationDigest !== identity.implementationDigest,
          ),
          identitySelection,
        ],
      },
      selectionUi: {
        publications: merge(
          "selectionUi" in previous
            ? previous.selectionUi?.publications
            : undefined,
        ),
      },
      uiRecovery: {
        version: "crewon.plugin-ui-recovery.v1",
        publications: [
          ...("uiRecovery" in previous
            ? (previous.uiRecovery?.publications ?? [])
            : []
          ).filter((entry) => !same(entry)),
          {
            ...sourcePublication,
            actions: [
              "crewon.project-generations.v1.generateConcept",
              "crewon.project-generation-queries.v1.queryConceptGeneration",
              "crewon.project-generation-selections.v1.selectConceptImage",
            ],
          },
        ],
      },
    },
  });
}
function invalid(): never {
  throw new Error("desktop_local_comfy_project_execution_approval_invalid");
}
