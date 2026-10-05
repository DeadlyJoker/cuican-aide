import {
  parseProjectTextPlansActionRequest,
  PROJECT_TEXT_PLANS_METHOD_ACTIONS,
  type ProjectTextPlansActionRequest,
} from "@crewon/contracts/project-text-plans";
import type { ActorContext } from "./authorization-port.ts";
import type {
  InstalledPluginPackage,
  PluginSelection,
  ProjectConversationInstallation,
  ProjectTextPlanDelegation,
} from "@crewon/domain";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import {
  uiActor,
  uiEpoch,
  uiPackage,
  uiProfile,
  uiPublicLease,
  uiRecord,
  uiSelection,
} from "./plugin-ui-application-support.ts";

/** Host-only, exact live invocation evidence. No public body or persisted provenance can issue it. */
export type PluginProjectTextPlanInvocationAuthority = Readonly<{
  actor: ActorContext;
  installation: ProjectConversationInstallation;
  selection: PluginSelection;
  package: InstalledPluginPackage;
  contributionId: string;
  actionId: ProjectTextPlansActionRequest["action"];
  input: ProjectTextPlansActionRequest["input"];
  invocationId: string;
  delegation: ProjectTextPlanDelegation | null;
  assertActive(): void;
  assertCurrent(): Promise<void>;
  /** External live identity/profile/PDP only; never borrows the committing Store. */
  assertTransactionCurrent(): Promise<void>;
}>;

export function isProjectTextPlanAction(action: string): boolean {
  return Object.values(PROJECT_TEXT_PLANS_METHOD_ACTIONS).some(
    (value) => value === action,
  );
}

export function projectTextPlanActionContext(input: PluginUiActionContext) {
  const v = uiRecord(input, [
    "actor",
    "scope",
    "selection",
    "package",
    "lease",
    "authorityEpoch",
    "action",
    "input",
  ]);
  const actor = uiActor(v.actor as ActorContext),
    scope = uiProfile(v.scope, actor),
    lease = uiPublicLease(v.lease);
  const selection = uiSelection(v.selection, scope, lease.descriptor.pluginId),
    pkg = uiPackage(v.package, scope, selection);
  const request = parseProjectTextPlansActionRequest({
      action: v.action,
      input: v.input,
    }),
    authorityEpoch = uiEpoch(v.authorityEpoch);
  if (
    selection.state !== "enabled" ||
    selection.revision !== lease.selectionRevision ||
    pkg.packageDigest !== lease.packageDigest ||
    pkg.version !== lease.descriptor.version ||
    pkg.publisherId !== lease.descriptor.publisherId
  )
    throw new Error("plugin_project_text_plan_context_invalid");
  const context = Object.freeze({
    actor,
    scope,
    selection,
    package: pkg,
    lease,
    authorityEpoch,
    action: request.action,
    input: request.input,
  }) as unknown as PluginUiActionContext;
  const installation: ProjectConversationInstallation = Object.freeze({
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
    profileId: scope.profileId,
    pluginId: pkg.pluginId,
    publisherId: pkg.publisherId,
    version: pkg.version,
    packageDigest: pkg.packageDigest,
    selectionRevision: selection.revision,
  });
  return Object.freeze({
    context,
    installation,
    request,
    fingerprint: JSON.stringify(context),
  });
}
