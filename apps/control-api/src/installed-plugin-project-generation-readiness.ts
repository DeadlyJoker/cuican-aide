import {
  capturePluginUiInvocationCommitAuthority,
  type ExtensionTaskApplicationService,
} from "@crewon/application";
import {
  parseProjectGenerationContextUiActionRequest,
  parseProjectGenerationContextUiActionResponse,
} from "@crewon/contracts/plugins";
import {
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginSelection,
  parsePluginTaskAdmissionPin,
  type PluginTaskAdmissionPin,
} from "@crewon/domain";
import type { PluginProjectGenerationContextDispatchPort } from "@crewon/plugin-host";
import type { InstalledPluginProjectGenerationDependencies } from "./installed-plugin-project-generation-owner.ts";
import {
  generationCandidate,
  generationDenied,
  generationInstalledPackage,
  generationMethod,
  generationSame,
  generationSameScope,
  generationSelectionMatches,
} from "./installed-plugin-project-generation-support.ts";
import { pluginSecurityActor } from "./plugin-security-validation.ts";

type Dispatch = Parameters<
  PluginProjectGenerationContextDispatchPort["getReadiness"]
>[0];

/** Qualifies the actual pair without activating its Node entry or issuing task authority. */
export async function installedProjectGenerationReadiness(
  input: Readonly<{
    dependencies: InstalledPluginProjectGenerationDependencies;
    dispatch: Dispatch;
    assertAvailable(): void;
    lifetime: AbortSignal;
    read: ExtensionTaskApplicationService["getPublishedProjectGenerationReadiness"];
  }>,
) {
  const { dependencies, dispatch, read } = input;
  const { context } = dispatch;
  const original = capturePluginUiInvocationCommitAuthority(context);
  const authority = Object.freeze({
    assertCurrent: generationMethod(dispatch.authority, "assertCurrent"),
    assertActive: generationMethod(dispatch.authority, "assertActive"),
  });
  const actor = pluginSecurityActor(context.actor);
  const scope = parsePluginProfileScope(context.scope);
  const sourceSelection = parsePluginSelection(context.selection);
  const sourcePackage = parseInstalledPluginPackage(context.package);
  const sourcePin = parsePluginTaskAdmissionPin(dispatch.sourcePin);
  const publication = dependencies.publications.find((item) =>
    generationSame(item, dispatch.publication),
  );
  if (publication === undefined)
    generationDenied("project_generation_publication_unapproved");
  const parsed = parseProjectGenerationContextUiActionRequest({
    action: context.action,
    input: context.input,
  });
  if (
    !generationSame(parsed.input.reference, dispatch.reference) ||
    !generationSameScope(scope, sourcePackage) ||
    !generationSelectionMatches(sourceSelection, sourcePin) ||
    !generationSame(actor, {
      principalId: sourcePin.principalId,
      actorId: sourcePin.actorId,
      tenantId: sourcePin.tenantId,
      spaceId: sourcePin.spaceId,
    }) ||
    sourcePin.action !== parsed.action ||
    (["pluginId", "packageDigest", "contributionId"] as const).some(
      (key) => sourcePin[key] !== publication.source[key],
    )
  )
    generationDenied("project_generation_source_context_changed");
  const rawSignal = dependencies.requestSignal();
  if (!(rawSignal instanceof AbortSignal))
    generationDenied("project_generation_request_signal_invalid");
  const signal = AbortSignal.any([rawSignal, input.lifetime]);
  const active = () => {
    input.assertAvailable();
    signal.throwIfAborted();
    original.assertActive();
    authority.assertActive();
  };
  active();
  await authority.assertCurrent();
  active();
  const target = await generationInstalledPackage({
    installations: dependencies.installations,
    scope,
    pluginId: publication.target.pluginId,
    packageDigest: publication.target.packageDigest,
    assertActive: active,
  });
  const sourceCandidate = await generationCandidate({
    installRoot: dependencies.installRoot,
    package: sourcePackage,
    signal,
  });
  const targetCandidate = await generationCandidate({
    installRoot: dependencies.installRoot,
    package: target.package,
    signal,
  });
  active();
  if (
    !sourceCandidate.descriptor.requires.some(
      (item) =>
        item.service === "crewon.project-generations" &&
        item.apiVersion === "1",
    )
  )
    generationDenied("project_generation_source_unsupported");
  const policy = async (
    pin: Pick<
      PluginTaskAdmissionPin,
      "pluginId" | "packageDigest" | "selectionRevision" | "contributionId"
    >,
  ) => {
    active();
    const decision = await dependencies.authorization.authorize({
      actor,
      action: "invoke",
      resource: {
        kind: "pluginUi",
        ...scope,
        pluginId: pin.pluginId,
        packageDigest: pin.packageDigest,
        selectionRevision: pin.selectionRevision,
        contributionId: pin.contributionId,
      },
    });
    active();
    if (decision.outcome !== "allow")
      generationDenied("project_generation_plugin_authority_changed");
    return decision.authorityEpoch;
  };
  const executionPin = parsePluginTaskAdmissionPin({
    ...scope,
    ...actor,
    pluginId: target.package.pluginId,
    publisherId: target.package.publisherId,
    version: target.package.version,
    packageDigest: target.package.packageDigest,
    selectionRevision: target.selection.revision,
    contributionId: publication.target.contributionId,
    action: publication.target.action,
    authorityEpoch: await policy({
      pluginId: target.package.pluginId,
      packageDigest: target.package.packageDigest,
      selectionRevision: target.selection.revision,
      contributionId: publication.target.contributionId,
    }),
  });
  const current = async () => {
    active();
    const currentActor = await dependencies.resolveActor(
      {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        actorId: actor.actorId,
      },
      signal,
    );
    active();
    if (
      currentActor === null ||
      !generationSame(pluginSecurityActor(currentActor), actor)
    )
      generationDenied("project_generation_identity_changed");
    const currentScope = parsePluginProfileScope(
      await dependencies.profiles.resolve(actor),
    );
    active();
    if (!generationSame(currentScope, scope))
      generationDenied("project_generation_profile_changed");
    for (const [pin, pkg, candidate, purpose] of [
      [sourcePin, sourcePackage, sourceCandidate, "read"],
      [executionPin, target.package, targetCandidate, "submit"],
    ] as const) {
      if ((await policy(pin)) !== pin.authorityEpoch)
        generationDenied("project_generation_plugin_authority_changed");
      await generationCandidate({
        installRoot: dependencies.installRoot,
        package: pkg,
        signal,
        expected: candidate,
      });
      active();
      if (
        (await dependencies.authorizePackage(
          { actor, scope, candidate, purpose },
          signal,
        )) !== "allow"
      )
        generationDenied("project_generation_execution_package_denied");
      active();
    }
    await generationInstalledPackage({
      installations: dependencies.installations,
      scope,
      pluginId: sourcePin.pluginId,
      packageDigest: sourcePin.packageDigest,
      expectedSelection: sourceSelection,
      expectedPackage: sourcePackage,
      assertActive: active,
    });
    await generationInstalledPackage({
      installations: dependencies.installations,
      scope,
      pluginId: executionPin.pluginId,
      packageDigest: executionPin.packageDigest,
      expectedSelection: target.selection,
      expectedPackage: target.package,
      assertActive: active,
    });
    await authority.assertCurrent();
    active();
  };
  await current();
  if (
    targetCandidate.descriptor.entrypoints.node === null ||
    !targetCandidate.descriptor.contributions.some(
      (item) => item.id === publication.target.contributionId,
    )
  ) {
    await current();
    return parseProjectGenerationContextUiActionResponse(parsed, {
      reference: parsed.input.reference,
      readiness: {
        outcome: "unavailable",
        reasonCode: "project_generation_runtime_unavailable",
      },
    });
  }
  const output = await read({
    actor,
    reference: parsed.input.reference,
    publication,
    sourcePin,
    executionPin,
    authority: Object.freeze({
      assertCurrent: current,
      assertTransactionCurrent: current,
      assertActive: active,
    }),
  });
  // Plain JSON readiness never inherits the durable generation acknowledgement exception.
  await current();
  return parseProjectGenerationContextUiActionResponse(parsed, output);
}
