import {
  captureCreativeProjectCommitAuthority,
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitCurrent,
  assertCreativeProjectCommitTransactionCurrent,
} from "./creative-project-commit-authority.ts";
import type { CreativeProjectCommitAuthority } from "./creative-project-store-port.ts";
import {
  extensionCanonicalJson,
  parsePluginProjectWorkspaceOwnerScope,
  type PluginProjectWorkspaceOwnerScope,
} from "@crewon/domain";
import { parseCreativeProjectUiActionRequest } from "@crewon/contracts/plugins";
import { ApplicationError } from "./application-error.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import { capturePluginUiInvocationCommitAuthority } from "./plugin-ui-invocation-authority.ts";
import { committedTaskContext } from "./plugin-ui-committed-task-support.ts";

export const PLUGIN_PROJECT_READ_METHODS = [
  "loadProject",
  "listProjects",
  "loadBrief",
  "listBriefs",
  "loadConceptAsset",
  "listConceptAssets",
  "loadConceptRevision",
  "listConceptRevisions",
] as const;
export type PluginProjectReadMethod =
  (typeof PLUGIN_PROJECT_READ_METHODS)[number];
export type PluginProjectReadScope = Readonly<{
  version: "crewon.plugin-project-read-scope.v1";
}>;
export type PluginProjectMutationScope = Readonly<{
  version: "crewon.plugin-project-mutation-scope.v1";
}>;
export type PluginProjectReadOptions = Readonly<{
  readScope: PluginProjectReadScope | PluginProjectMutationScope;
}>;
const actionMethods = {
  getProject: ["loadProject"],
  listProjects: ["listProjects"],
  getBrief: ["loadProject", "loadBrief"],
  listBriefs: ["loadProject", "listBriefs"],
  getConceptAsset: ["loadProject", "loadConceptAsset"],
  listConceptAssets: ["loadProject", "listConceptAssets"],
  getConceptRevision: [
    "loadProject",
    "loadConceptAsset",
    "loadConceptRevision",
  ],
  listConceptRevisions: [
    "loadProject",
    "loadConceptAsset",
    "listConceptRevisions",
  ],
} as const;
type Qualified = Readonly<{
  purpose: "read" | "mutation";
  scope: PluginProjectWorkspaceOwnerScope;
  snapshot: ReturnType<typeof committedTaskContext>;
  request: ReturnType<typeof parseCreativeProjectUiActionRequest>;
  methods: readonly string[];
  assertCurrent(): Promise<void>;
  assertActive(): void;
}>;
const references = new WeakMap<object, Qualified>();

/** Private issuer. The exact registered UI call is required before reading its fields. */
export function capturePluginProjectReadScope(
  context: PluginUiActionContext,
  hostAuthority: CreativeProjectCommitAuthority,
): PluginProjectReadScope {
  return captureScope(context, hostAuthority, "read") as PluginProjectReadScope;
}
/** Private metadata mutation issuer; other write kinds are deliberately not supported yet. */
export function capturePluginProjectMutationScope(
  context: PluginUiActionContext,
  hostAuthority: CreativeProjectCommitAuthority,
): PluginProjectMutationScope {
  return captureScope(
    context,
    hostAuthority,
    "mutation",
  ) as PluginProjectMutationScope;
}
function captureScope(
  context: PluginUiActionContext,
  hostAuthority: CreativeProjectCommitAuthority,
  purpose: "read" | "mutation",
) {
  const authority = capturePluginUiInvocationCommitAuthority(context);
  const host = captureCreativeProjectCommitAuthority({
    authority: hostAuthority,
  });
  if (host === undefined) unavailable();
  const snapshot = committedTaskContext(context);
  if (
    host.transaction === undefined ||
    extensionCanonicalJson(host.transaction.pin) !==
      extensionCanonicalJson(snapshot.pin) ||
    extensionCanonicalJson(host.transaction.selection) !==
      extensionCanonicalJson(snapshot.context.selection) ||
    extensionCanonicalJson(host.transaction.package) !==
      extensionCanonicalJson(snapshot.context.package)
  )
    unavailable();
  const request = parseCreativeProjectUiActionRequest({
    action: context.action,
    input: context.input,
  });
  const name = request.action.slice("crewon.creative-projects.v1.".length);
  if (
    (purpose === "read"
      ? !Object.hasOwn(actionMethods, name)
      : !["renameProject", "setProjectState"].includes(name)) ||
    authority.transaction === undefined ||
    authority.transaction.pin.action !== request.action
  )
    unavailable();
  const methods =
    purpose === "read"
      ? actionMethods[name as keyof typeof actionMethods]
      : ["loadProject"];
  const active = () => {
    authority.assertActive();
    assertCreativeProjectCommitActive(host);
    if (committedTaskContext(context).fingerprint !== snapshot.fingerprint)
      unavailable();
  };
  active();
  const pin = snapshot.pin;
  const source: Qualified = Object.freeze({
    purpose,
    scope: parsePluginProjectWorkspaceOwnerScope({
      tenantId: pin.tenantId,
      spaceId: pin.spaceId,
      principalId: pin.principalId,
      actorId: pin.actorId,
      profileId: pin.profileId,
      pluginId: pin.pluginId,
      publisherId: pin.publisherId,
    }),
    snapshot,
    request,
    methods: Object.freeze([...methods]),
    assertActive: active,
    assertCurrent: async () => {
      active();
      await assertCreativeProjectCommitCurrent(host);
      await assertCreativeProjectCommitTransactionCurrent(host);
      active();
    },
  });
  const ref = Object.freeze({
    version:
      purpose === "read"
        ? ("crewon.plugin-project-read-scope.v1" as const)
        : ("crewon.plugin-project-mutation-scope.v1" as const),
  });
  references.set(ref, source);
  return ref;
}
export function qualifyPluginProjectReadScope(
  ref: PluginProjectReadScope | PluginProjectMutationScope,
): Qualified {
  const source =
    ref !== null && typeof ref === "object" ? references.get(ref) : undefined;
  if (source === undefined) unavailable();
  source.assertActive();
  return source;
}
function unavailable(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_read_scope_unavailable",
  );
}

export function qualifyPluginProjectMutationScope(
  ref: PluginProjectMutationScope,
): Qualified {
  const source = qualifyPluginProjectReadScope(ref);
  if (source.purpose !== "mutation") unavailable();
  return source;
}
