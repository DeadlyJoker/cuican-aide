import {
  extensionCanonicalJson,
  parsePluginProjectWorkspaceOwnerScope,
  type PluginProjectWorkspaceOwnerScope,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import type { ProjectFoundationCommitAuthority } from "./project-foundation-store-port.ts";
import { capturePluginProjectFoundationInvocation } from "./plugin-project-foundation-invocation.ts";

/** Opaque source identity; only the actual installed UI invocation can issue it. */
export type PluginProjectFoundationScope = Readonly<{
  version: "crewon.plugin-project-foundation-scope.v1";
}>;
type Qualified = Readonly<{
  scope: PluginProjectWorkspaceOwnerScope;
  snapshot: ReturnType<
    typeof capturePluginProjectFoundationInvocation
  >["snapshot"];
  assertActive(): void;
  assertCurrent(): Promise<void>;
}>;
const sources = new WeakMap<object, Qualified>();
/** Private issuer, deliberately absent from the package entrypoint. */
export function capturePluginProjectFoundationScope(
  context: PluginUiActionContext,
  host: ProjectFoundationCommitAuthority,
): PluginProjectFoundationScope {
  const original = capturePluginProjectFoundationInvocation(context);
  const snapshot = original.snapshot;
  if (
    original.transaction !== undefined &&
    (host.transaction === undefined ||
      extensionCanonicalJson(host.transaction.pin) !==
        extensionCanonicalJson(snapshot.pin) ||
      extensionCanonicalJson(host.transaction.selection) !==
        extensionCanonicalJson(snapshot.context.selection) ||
      extensionCanonicalJson(host.transaction.package) !==
        extensionCanonicalJson(snapshot.context.package))
  )
    unavailable();
  const assertActive = () => {
    original.assertActive();
    host.assertActive();
  };
  const pin = snapshot.pin;
  const source: Qualified = Object.freeze({
    scope: parsePluginProjectWorkspaceOwnerScope({
      ...context.actor,
      profileId: pin.profileId,
      pluginId: pin.pluginId,
      publisherId: pin.publisherId,
    }),
    snapshot,
    assertActive,
    async assertCurrent() {
      assertActive();
      // The original owner callback checks both live Host identity and project policy.
      await (host.transaction ?? host).assertCurrent();
      assertActive();
    },
  });
  source.assertActive();
  const ref: PluginProjectFoundationScope = Object.freeze({
    version: "crewon.plugin-project-foundation-scope.v1",
  });
  sources.set(ref, source);
  return ref;
}
/** Storage consumer only: copied objects and completed/revoked invocations fail closed. */
export function qualifyPluginProjectFoundationScope(
  reference: PluginProjectFoundationScope,
): Qualified {
  const source =
    reference !== null && typeof reference === "object"
      ? sources.get(reference)
      : undefined;
  if (source === undefined) unavailable();
  source.assertActive();
  return source;
}
function unavailable(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_foundation_scope_unavailable",
  );
}

/** Bounded dependency methods for one exact Foundation target; creation grants no reads. */
export function foundationProjectReadSource(
  reference: PluginProjectFoundationScope,
) {
  const source = qualifyPluginProjectFoundationScope(reference);
  const request = source.snapshot.request;
  const readMethods: Record<string, readonly string[]> = {
    getFoundation: ["loadFoundation"],
    getSource: ["loadSource"],
    readSourcePage: ["loadSource", "readSourcePage"],
    listSourceChapters: ["loadSource", "listSourceChapters"],
    getProposal: ["loadProposal"],
    listProposals: ["listProposals"],
  };
  const name = request.action.slice("crewon.project-foundation.v1.".length);
  const methods =
    name === "createProject"
      ? []
      : [
          "loadProject",
          "loadBrief",
          ...(readMethods[name] ?? [
            "loadFoundation",
            "loadSource",
            "loadProposal",
          ]),
        ];
  return Object.freeze({
    purpose: "read" as const,
    ...source,
    request,
    methods: Object.freeze(methods),
  });
}
