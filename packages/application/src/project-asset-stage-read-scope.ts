import { projectAssetAuthorityFields } from "./project-asset-qualification-data.ts";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import {
  extensionCanonicalJson,
  parsePluginProjectWorkspaceOwnerScope,
  parseProjectConversationBinding,
  type ProjectConversationBinding,
} from "@crewon/domain";
import {
  parseProjectAssetStageRequest,
  parseProjectAssetScriptSourceRequest,
  type ProjectAssetStageRequest,
  type ProjectAssetScriptSourceRequest,
} from "@crewon/contracts/project-asset-stages";
import { parseProjectTextId } from "@crewon/contracts";
import { ApplicationError } from "./application-error.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import {
  captureProjectAssetStageAuthority,
  type ProjectAssetStageCommitAuthority,
} from "./project-asset-stage-authority.ts";
import {
  registerTrustedRunProjectReadSource,
  qualifyPluginProjectReadScope,
  type PluginProjectReadScope,
} from "./plugin-project-read-scope.ts";

export type ProjectAssetStageReadRequest = Readonly<{
  action: "crewon.project-asset-stage-read.v1";
  input:
    | Readonly<{ purpose: "availability"; projectId: string; threadId: string }>
    | (ProjectAssetScriptSourceRequest & Readonly<{ purpose: "script-source" }>)
    | (ProjectAssetStageRequest & Readonly<{ purpose: "start-stage" }>);
}>;
function request(
  input: ProjectAssetStageReadRequest,
): ProjectAssetStageReadRequest {
  const cloned = projectAssetAuthorityFields(
    parsePluginUiJsonValue(input, { maxBytes: 24 * 1024 }),
    ["action", "input"],
  );
  if (cloned.action !== "crewon.project-asset-stage-read.v1") denied();
  const safe = cloned.input as ProjectAssetStageReadRequest["input"];
  const { purpose, ...value } = safe;
  if (purpose === "start-stage")
    return Object.freeze({
      action: input.action,
      input: Object.freeze({
        ...parseProjectAssetStageRequest(value),
        purpose,
      }),
    });
  if (purpose === "script-source")
    return Object.freeze({
      action: input.action,
      input: Object.freeze({
        ...parseProjectAssetScriptSourceRequest(value),
        purpose,
      }),
    });
  if (purpose !== "availability" || Object.keys(value).length !== 2) denied();
  return Object.freeze({
    action: input.action,
    input: Object.freeze({
      purpose,
      projectId: parseProjectTextId(value.projectId),
      threadId: parseProjectTextId(value.threadId),
    }),
  });
}
/** Deliberate Host issuer for the actual independent Asset Stage publication,
 * Node declaration, installation and PDP authority. It borrows no Conversation
 * or Run authority and grants only a single bound project's dependency reads.
 */
export function issuePluginProjectAssetStageReadScope(
  input: Readonly<{
    authority: ProjectAssetStageCommitAuthority;
    binding: ProjectConversationBinding;
    request: ProjectAssetStageReadRequest;
    digester: ContentDigester;
  }>,
): PluginProjectReadScope {
  const q = captureProjectAssetStageAuthority(input.authority),
    b = parseProjectConversationBinding(input.binding, input.digester),
    r = request(input.request);
  if (
    b.state !== "active" ||
    b.profileId !== q.installation.profileId ||
    b.projectId !== r.input.projectId ||
    b.threadId !== r.input.threadId ||
    extensionCanonicalJson(b.owner) !== extensionCanonicalJson(q.actor) ||
    extensionCanonicalJson(b.currentInstallation) !==
      extensionCanonicalJson(q.installation) ||
    (r.input.purpose !== "availability" &&
      r.input.expectedBindingRevision !== b.revision)
  )
    denied();
  const text =
    r.input.purpose === "script-source" ||
    (r.input.purpose === "start-stage" && r.input.stage.script !== null);
  return registerTrustedRunProjectReadSource({
    assetStageRead: Object.freeze({ authority: q, binding: b }),
    purpose: "read",
    scope: parsePluginProjectWorkspaceOwnerScope({
      ...q.actor,
      profileId: q.installation.profileId,
      pluginId: q.installation.pluginId,
      publisherId: q.installation.publisherId,
    }),
    snapshot: Object.freeze({
      pin: q.pin,
      context: Object.freeze({ selection: q.selection, package: q.package }),
      fingerprint: extensionCanonicalJson({
        pin: q.pin,
        binding: b,
        request: r,
      }),
    }),
    request: r,
    methods: Object.freeze([
      "loadProject",
      ...(r.input.purpose === "availability" ? [] : ["loadBrief"]),
      ...(text ? ["loadScript", "loadOutline", "loadRevision"] : []),
      ...(r.input.purpose === "start-stage"
        ? [
            "loadAssetStageAdmission",
            "readRequiredAssetStageDigest",
            "loadExtensionTurnReceipt",
          ]
        : []),
    ]),
    assertActive: q.assertActive,
    assertCurrent: async () => {
      q.assertActive();
      await q.assertCurrent();
      await q.assertTransactionCurrent();
      q.assertActive();
    },
  });
}
export function assertProjectAssetStageReadScope(
  input: Readonly<{
    scope: PluginProjectReadScope;
    authority: ProjectAssetStageCommitAuthority;
    binding: ProjectConversationBinding;
    request: ProjectAssetStageReadRequest;
  }>,
): void {
  const source = qualifyPluginProjectReadScope(input.scope),
    actual = source.assetStageRead;
  if (
    actual === undefined ||
    source.request.action !== "crewon.project-asset-stage-read.v1" ||
    extensionCanonicalJson(source.request) !==
      extensionCanonicalJson(request(input.request)) ||
    extensionCanonicalJson(actual.binding) !==
      extensionCanonicalJson(input.binding) ||
    extensionCanonicalJson(source.snapshot.pin) !==
      extensionCanonicalJson(input.authority.pin) ||
    extensionCanonicalJson(source.snapshot.context) !==
      extensionCanonicalJson({
        selection: input.authority.selection,
        package: input.authority.package,
      })
  )
    denied();
  actual.authority.assertActive();
  input.authority.assertActive();
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "project_asset_stage_read_scope_mismatch",
  );
}
