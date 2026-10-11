import {
  parsePluginProjectWorkspaceOwnerScope,
  type PluginProjectWorkspaceOwnerScope,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import { capturePluginUiInvocationCommitAuthority } from "./plugin-ui-invocation-authority.ts";
import { capturePluginProjectFoundationInvocation } from "./plugin-project-foundation-invocation.ts";
import {
  derivePluginProjectCreationReceipt,
  type PluginProjectCreationEntryPoint,
} from "./plugin-project-creation-receipt.ts";
import type { CreativeProjectMutationReceipt } from "./creative-project-store-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";

/** Host source identity only. Project creation policy and the original Store transaction remain mandatory. */
export type PluginProjectCreationScope = Readonly<{
  version: "crewon.plugin-project-creation-scope.v1";
}>;
type Qualified = Readonly<{
  scope: PluginProjectWorkspaceOwnerScope;
  entryPoint: PluginProjectCreationEntryPoint;
  transaction:
    | NonNullable<
        ReturnType<
          typeof capturePluginUiInvocationCommitAuthority
        >["transaction"]
      >
    | NonNullable<
        ReturnType<
          typeof capturePluginProjectFoundationInvocation
        >["transaction"]
      >;
  assertCurrent(): Promise<void>;
  assertActive(): void;
}>;
const sources = new WeakMap<object, Qualified>();

/** Private issuer; deliberately absent from the package entrypoint. Requires the actual live Host invocation. */
export function capturePluginProjectCreationScope(
  context: PluginUiActionContext,
): PluginProjectCreationScope {
  const base = capturePluginUiInvocationCommitAuthority(context);
  const action = context.action;
  const authority =
    action === "crewon.creative-projects.v1.createProject"
      ? base
      : action === "crewon.project-foundation.v1.createProject"
        ? capturePluginProjectFoundationInvocation(context)
        : unavailable();
  const transaction = authority.transaction;
  if (transaction === undefined || transaction.pin.action !== action)
    unavailable();
  const pin = transaction.pin;
  const qualified: Qualified = Object.freeze({
    scope: parsePluginProjectWorkspaceOwnerScope({
      tenantId: pin.tenantId,
      spaceId: pin.spaceId,
      principalId: pin.principalId,
      actorId: pin.actorId,
      profileId: pin.profileId,
      pluginId: pin.pluginId,
      publisherId: pin.publisherId,
    }),
    entryPoint:
      action === "crewon.creative-projects.v1.createProject"
        ? "creative-project"
        : "project-foundation",
    transaction,
    assertCurrent: authority.assertCurrent,
    assertActive: authority.assertActive,
  });
  qualified.assertActive();
  const reference = Object.freeze({
    version: "crewon.plugin-project-creation-scope.v1" as const,
  });
  sources.set(reference, qualified);
  return reference;
}

/** Store consumer: copied JSON cannot select an owner, and a completed invocation cannot be reused. */
export function qualifyPluginProjectCreationScope(
  reference: PluginProjectCreationScope,
): Qualified {
  const qualified =
    reference !== null && typeof reference === "object"
      ? sources.get(reference)
      : undefined;
  if (qualified === undefined) unavailable();
  qualified.assertActive();
  return qualified;
}

/** Bind the original external receipt to a genuine source, never to caller-provided owner fields. */
export function deriveQualifiedPluginProjectCreationReceipt(
  reference: PluginProjectCreationScope,
  externalReceipt: CreativeProjectMutationReceipt,
  digester: ContentDigester,
) {
  const qualified = qualifyPluginProjectCreationScope(reference);
  const receipt = derivePluginProjectCreationReceipt(
    {
      scope: qualified.scope,
      entryPoint: qualified.entryPoint,
      externalReceipt,
    },
    digester,
  );
  qualified.assertActive();
  return receipt;
}
function unavailable(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_creation_scope_unavailable",
  );
}
