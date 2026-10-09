import { createHash } from "node:crypto";
import { extensionCanonicalJson, parsePluginSelection } from "@crewon/domain";
import type { PluginInstallationStore } from "@crewon/application";
import {
  createPluginCompositionLock,
  type PluginCompositionHostService,
} from "@crewon/contracts/plugins";
import {
  PluginExecutionComposition,
  type PluginActivationCandidate,
  type PluginHostService,
} from "@crewon/plugin-host";
import {
  assertPackageCandidate,
  fail,
} from "./installed-plugin-runtime-resolver-package.ts";
import type { InstalledPluginRunContext } from "./installed-plugin-run-context.ts";
import type {
  InstalledPluginRuntimePrepared,
  InstalledPluginRuntimePackageOwner,
} from "./installed-plugin-runtime-resident.ts";
import type { InstalledPluginRuntimeResolverDependencies } from "./installed-plugin-runtime-resolver.ts";

/** Capture explicit deployment versions before any asynchronous storage or package loading. */
export function captureInstalledPluginCompositionExecution(
  input: NonNullable<
    InstalledPluginRuntimeResolverDependencies["compositionExecution"]
  >,
) {
  const property =
    input && Object.getOwnPropertyDescriptor(input, "hostServiceMetadata");
  if (
    !property?.enumerable ||
    !("value" in property) ||
    Object.keys(input).length !== 1
  )
    fail("installed_plugin_composition_configuration_invalid");
  return Object.freeze({
    hostServiceMetadata: createPluginCompositionLock(
      {
        schemaVersion: "crewon.plugin-composition-lock.v1",
        scope: {
          tenantId: "configuration",
          spaceId: "configuration",
          profileId: "configuration",
          authorityEpoch: "configuration",
        },
        revision: 1,
        nodes: [],
        hostServices: property.value,
      },
      {
        sha256: (body: string) =>
          `sha256:${createHash("sha256").update(body).digest("hex")}`,
      },
    ).hostServices,
  });
}

/** Original graph owner using the same actual Run/PDP and publisher approval as the legacy path. */
export async function openInstalledPluginCompositionRuntime(
  input: Readonly<{
    contexts: InstalledPluginRunContext;
    installations: PluginInstallationStore;
    prepared: InstalledPluginRuntimePrepared;
    installRoot: string;
    hostServices: readonly PluginHostService[];
    hostServiceMetadata: readonly PluginCompositionHostService[];
    authorizePackage: InstalledPluginRuntimeResolverDependencies["authorizePackage"];
    purpose: "submit" | "observe";
    signal: AbortSignal;
    assertOpen(signal: AbortSignal): void;
  }>,
) {
  const { prepared, contexts } = input;
  const lock = contexts.verifiedComposition(prepared.snapshot);
  if (!lock) fail("installed_plugin_composition_missing");
  const candidates = new Map<string, PluginActivationCandidate>();
  const published = new Set<string>();
  const authorize = async (
    candidate: PluginActivationCandidate,
    purpose: "submit" | "observe",
    signal: AbortSignal,
  ) => {
    input.assertOpen(signal);
    const pkg = await contexts.assertCompositionNodeCurrent(
      prepared.snapshot,
      candidate.descriptor.pluginId,
      purpose,
      signal,
    );
    for (const field of ["pluginId", "publisherId", "version"] as const)
      if (candidate.descriptor[field] !== pkg[field])
        fail("installed_plugin_descriptor_mismatch");
    if (candidate.packageDigest !== pkg.packageDigest)
      fail("installed_plugin_descriptor_mismatch");
    if (pkg.pluginId === prepared.admission.pluginId)
      await assertPackageCandidate({
        candidate,
        package: pkg,
        proof: prepared.proof,
        installRoot: input.installRoot,
        signal,
      });
    if (
      (await input.authorizePackage(
        { candidate, scope: prepared.scope, purpose },
        signal,
      )) !== "allow"
    )
      fail("installed_plugin_runtime_publisher_denied");
    await contexts.assertCompositionNodeCurrent(
      prepared.snapshot,
      pkg.pluginId,
      purpose,
      signal,
    );
    input.assertOpen(signal);
  };
  const owner = await PluginExecutionComposition.open({
    lock,
    expectedScope: {
      ...prepared.scope,
      authorityEpoch: prepared.admission.authorityEpoch,
    },
    rootPluginId: prepared.admission.pluginId,
    installRoot: input.installRoot,
    hostServices: input.hostServices.map((implementation) => {
      const metadata = input.hostServiceMetadata.find(
        (entry) =>
          entry.service === implementation.service &&
          entry.apiVersion === implementation.apiVersion,
      );
      if (!metadata)
        fail("installed_plugin_composition_host_service_unversioned");
      return { metadata, implementation };
    }),
    authority: {
      authorizePreparation: async ({ candidate }) => {
        await authorize(candidate, input.purpose, input.signal);
        candidates.set(candidate.descriptor.pluginId, candidate);
        return "allow" as const;
      },
      beforePublication: async ({ node }) => {
        const candidate = candidates.get(node.pluginId);
        if (!candidate) fail("installed_plugin_runtime_candidate_missing");
        await authorize(candidate, input.purpose, input.signal);
        published.add(node.pluginId);
      },
      authorizePublication: ({ node, candidate }) => {
        input.assertOpen(input.signal);
        const original = candidates.get(node.pluginId);
        return published.has(node.pluginId) &&
          original &&
          candidate.identity.pluginId === node.pluginId &&
          candidate.identity.version === node.version &&
          candidate.identity.packageDigest === node.packageDigest &&
          extensionCanonicalJson(candidate.descriptor) ===
            extensionCanonicalJson(original.descriptor)
          ? "allow"
          : "deny";
      },
    },
  });
  const candidate = candidates.get(prepared.admission.pluginId);
  if (!candidate) {
    await owner.close();
    fail("installed_plugin_runtime_candidate_missing");
  }
  const packageOwner: InstalledPluginRuntimePackageOwner = {
    identity: owner.identity,
    acquire: (borrow) =>
      owner.acquire({
        lockDigest: lock.lockDigest,
        purpose: borrow.purpose,
        authorizeBorrow: ({ identity }) => borrow.authorizeBorrow(identity),
      }),
    close: () => owner.close(),
  };
  return {
    package: packageOwner,
    candidate,
    authorize: async (purpose: "submit" | "observe", signal: AbortSignal) => {
      const selections = new Map<string, string>();
      const readSelection = async (pluginId: string) => {
        signal.throwIfAborted();
        const raw = await input.installations.loadSelection({
          scope: prepared.scope,
          pluginId,
        });
        signal.throwIfAborted();
        if (!raw) fail("installed_plugin_selection_missing");
        return extensionCanonicalJson(parsePluginSelection(raw));
      };
      for (const pluginId of candidates.keys())
        selections.set(pluginId, await readSelection(pluginId));
      for (const value of candidates.values())
        await authorize(value, purpose, signal);
      // A later node's asynchronous policy must not invalidate an earlier provider's checked selection.
      for (const [pluginId, selection] of selections)
        if ((await readSelection(pluginId)) !== selection)
          fail("installed_plugin_selection_changed");
    },
  };
}
