import { createHash } from "node:crypto";
import {
  parsePluginProjectWorkspaceOwner,
  pluginProjectWorkspaceIdentityInput,
  type PluginProjectWorkspaceOwner,
} from "@crewon/domain";
import { PROJECT_CONVERSATIONS_METHOD_ACTIONS } from "@crewon/contracts/project-conversations";
import type { DesktopNativePluginPackageIdentity } from "@crewon/contracts/plugins";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import type { ProjectConversationCommitAuthority } from "./project-conversation-store-port.ts";
import type { ProjectConversationApplicationDependencies } from "./project-conversation-application-service.ts";
import { ApplicationError } from "./application-error.ts";
import { conversationUiProjectReader } from "./project-conversation-ui-project-reader.ts";
import { qualifyPluginProjectReadScope } from "./plugin-project-read-scope.ts";
import { captureProjectConversationAuthority } from "./project-conversation-authority.ts";
import { ownedConversationProjectWriteAuthority } from "./project-conversation-project-authority.ts";
import { readConversationProject } from "./project-conversation-project-reader.ts";

/** Process-local live Host preparation only. Neither detached JSON nor a directory result is this reference. */
export type PluginProjectWorkspacePreparation = Readonly<{
  version: "crewon.plugin-project-workspace-preparation.v1";
}>;
type Qualified = Readonly<{
  invocationFingerprint: string;
  commit: ProjectConversationCommitAuthority;
  owner: PluginProjectWorkspaceOwner;
  packageIdentity: DesktopNativePluginPackageIdentity;
  expectedWorkspaceId: string;
  assertCurrent(): Promise<void>;
  assertActive(): void;
}>;
const sources = new WeakMap<object, Qualified>();

/** Private issuer; no caller ownership, root, workspace ID, adoption or Run grant. */
export async function preparePluginProjectWorkspace(
  input: Readonly<{
    context: PluginUiActionContext;
    authority: ProjectConversationCommitAuthority;
    projects: ProjectConversationApplicationDependencies["projects"];
    authorization: ProjectConversationApplicationDependencies["authorization"];
  }>,
): Promise<PluginProjectWorkspacePreparation> {
  // The original view checks genuine invocation membership before reading context fields or Host authority.
  const view = conversationUiProjectReader(input);
  if (
    view.request.action !==
    PROJECT_CONVERSATIONS_METHOD_ACTIONS.createConversation
  )
    throw new ApplicationError(
      "authorization",
      "plugin_project_workspace_preparation_method_mismatch",
    );
  const source = qualifyPluginProjectReadScope(view.scope);
  const request = view.request.input;
  const owner = parsePluginProjectWorkspaceOwner({
    ...source.scope,
    projectId: request.projectId,
  });
  const expectedWorkspaceId = `workspace-project-${createHash("sha256").update(pluginProjectWorkspaceIdentityInput(owner)).digest("hex")}`;
  if (
    request.workspaceId !== null &&
    request.workspaceId !== expectedWorkspaceId
  )
    throw new ApplicationError(
      "authorization",
      "plugin_project_workspace_preparation_target_mismatch",
    );
  const captured = captureProjectConversationAuthority(input.authority);
  const q = ownedConversationProjectWriteAuthority({
    authority: captured,
    projectId: owner.projectId,
    authorization: input.authorization,
  });
  const active = () => {
    source.assertActive();
    q.assertActive();
  };
  const current = async () => {
    active();
    // The same original Store rechecks full ownership and active project state, never merely the old preparation.
    await readConversationProject({
      authority: q,
      projectId: owner.projectId,
      action: "creativeProject:write",
      authorization: input.authorization,
      projects: view.projects,
    });
    await q.assertCurrent();
    await q.assertTransactionCurrent();
    active();
  };
  await current();
  const qualified: Qualified = Object.freeze({
    invocationFingerprint: source.snapshot.fingerprint,
    commit: q,
    owner,
    expectedWorkspaceId,
    packageIdentity: Object.freeze({
      pluginId: q.installation.pluginId,
      publisherId: q.installation.publisherId,
      version: q.installation.version,
      packageDigest: q.installation.packageDigest,
    }),
    assertCurrent: current,
    assertActive: active,
  });
  active();
  const reference: PluginProjectWorkspacePreparation = Object.freeze({
    version: "crewon.plugin-project-workspace-preparation.v1",
  });
  sources.set(reference, qualified);
  return reference;
}

/** Control consumer. It must check current before Native allocation and again before original SQL registration. */
export function qualifyPluginProjectWorkspacePreparation(
  reference: PluginProjectWorkspacePreparation,
): Qualified {
  const source =
    reference !== null && typeof reference === "object"
      ? sources.get(reference)
      : undefined;
  if (source === undefined)
    throw new ApplicationError(
      "authorization",
      "plugin_project_workspace_preparation_unavailable",
    );
  source.assertActive();
  return source;
}
