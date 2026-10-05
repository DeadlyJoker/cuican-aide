import { projectTextOpaqueId } from "./project-text-content.ts";
import {
  extensionCanonicalJson,
  type ExtensionContentDigester,
} from "./extension-configuration.ts";
import {
  validateCreativeProjectActor,
  creativeProjectRecord,
  creativeProjectRevision,
  creativeProjectTimestamp,
  creativeProjectDigest,
  creativeProjectFailure,
} from "./creative-project-validation.ts";
import {
  pluginInstallationOpaqueId,
  pluginInstallationNamespaceId,
  pluginInstallationVersion,
  pluginInstallationDigest,
  pluginInstallationRevision,
} from "./plugin-installation-validation.ts";
import type { CreativeProjectActor } from "./creative-project.ts";

export type ProjectConversationInstallation = Readonly<{
  tenantId: string;
  spaceId: string;
  profileId: string;
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
  selectionRevision: number;
}>;
export type ProjectConversationBinding = Readonly<{
  schemaVersion: "crewon.project-conversation-binding.v1";
  bindingId: string;
  owner: CreativeProjectActor;
  profileId: string;
  projectId: string;
  threadId: string;
  workspaceId: string | null;
  revision: number;
  state: "active" | "revoked";
  currentInstallation: ProjectConversationInstallation;
  createdAt: string;
  updatedAt: string;
  contentDigest: string;
}>;
export function parseProjectConversationInstallation(
  input: unknown,
): ProjectConversationInstallation {
  const v = creativeProjectRecord(input, [
    "tenantId",
    "spaceId",
    "profileId",
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
    "selectionRevision",
  ]);
  return Object.freeze({
    tenantId: pluginInstallationOpaqueId(v.tenantId),
    spaceId: pluginInstallationOpaqueId(v.spaceId),
    profileId: pluginInstallationOpaqueId(v.profileId),
    pluginId: pluginInstallationNamespaceId(v.pluginId),
    publisherId: pluginInstallationNamespaceId(v.publisherId),
    version: pluginInstallationVersion(v.version),
    packageDigest: pluginInstallationDigest(v.packageDigest),
    selectionRevision: pluginInstallationRevision(v.selectionRevision),
  });
}
export function parseProjectConversationBinding(
  input: unknown,
  digester: ExtensionContentDigester,
): ProjectConversationBinding {
  const v = creativeProjectRecord(input, [
    "schemaVersion",
    "bindingId",
    "owner",
    "profileId",
    "projectId",
    "threadId",
    "workspaceId",
    "revision",
    "state",
    "currentInstallation",
    "createdAt",
    "updatedAt",
    "contentDigest",
  ]);
  if (
    v.schemaVersion !== "crewon.project-conversation-binding.v1" ||
    (v.state !== "active" && v.state !== "revoked")
  )
    invalid();
  const owner = validateCreativeProjectActor(v.owner),
    installation = parseProjectConversationInstallation(v.currentInstallation);
  const createdAt = creativeProjectTimestamp(v.createdAt),
    updatedAt = creativeProjectTimestamp(v.updatedAt),
    profileId = pluginInstallationOpaqueId(v.profileId);
  if (
    owner.tenantId !== installation.tenantId ||
    owner.spaceId !== installation.spaceId ||
    profileId !== installation.profileId ||
    Date.parse(updatedAt) < Date.parse(createdAt)
  )
    invalid();
  const body = Object.freeze({
    schemaVersion: "crewon.project-conversation-binding.v1" as const,
    bindingId: projectTextOpaqueId(v.bindingId),
    owner,
    profileId,
    projectId: projectTextOpaqueId(v.projectId),
    threadId: projectTextOpaqueId(v.threadId),
    workspaceId:
      v.workspaceId === null ? null : pluginInstallationOpaqueId(v.workspaceId),
    revision: creativeProjectRevision(v.revision),
    state: v.state,
    currentInstallation: installation,
    createdAt,
    updatedAt,
  });
  const contentDigest = creativeProjectDigest(v.contentDigest);
  if (digester.sha256(extensionCanonicalJson(body)) !== contentDigest)
    invalid();
  return Object.freeze({ ...body, contentDigest });
}
export function createProjectConversationBinding(
  input: Omit<ProjectConversationBinding, "schemaVersion" | "contentDigest">,
  digester: ExtensionContentDigester,
): ProjectConversationBinding {
  const body = {
    schemaVersion: "crewon.project-conversation-binding.v1",
    ...creativeProjectRecord(input, [
      "bindingId",
      "owner",
      "profileId",
      "projectId",
      "threadId",
      "workspaceId",
      "revision",
      "state",
      "currentInstallation",
      "createdAt",
      "updatedAt",
    ]),
  };
  return parseProjectConversationBinding(
    { ...body, contentDigest: digester.sha256(extensionCanonicalJson(body)) },
    digester,
  );
}
export function assertProjectConversationBindingChange(
  previous: ProjectConversationBinding,
  next: ProjectConversationBinding,
): void {
  if (
    next.revision !== previous.revision + 1 ||
    [
      "bindingId",
      "profileId",
      "projectId",
      "threadId",
      "workspaceId",
      "createdAt",
    ].some(
      (k) =>
        previous[k as keyof ProjectConversationBinding] !==
        next[k as keyof ProjectConversationBinding],
    ) ||
    extensionCanonicalJson(previous.owner) !==
      extensionCanonicalJson(next.owner) ||
    previous.currentInstallation.pluginId !==
      next.currentInstallation.pluginId ||
    previous.currentInstallation.publisherId !==
      next.currentInstallation.publisherId
  )
    invalid();
}
function invalid(): never {
  return creativeProjectFailure("project_conversation_binding_invalid");
}
