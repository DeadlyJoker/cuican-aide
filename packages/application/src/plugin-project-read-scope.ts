import {
  foundationProjectReadSource,
  type PluginProjectFoundationScope,
} from "./plugin-project-foundation-scope.ts";
import type { ProjectFoundationUiRequest } from "@crewon/contracts/project-foundation";
import {
  captureProjectFoundationRunReadAuthority,
  type ProjectFoundationRunReadAuthority,
} from "./project-foundation-run-commit-authority.ts";
import {
  PROJECT_WORKSPACE_TARGET_ACTION,
  parseProjectWorkspaceTargetRequest,
} from "@crewon/contracts/project-workspace-target";
import {
  captureCreativeProjectCommitAuthority,
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitCurrent,
  assertCreativeProjectCommitTransactionCurrent,
} from "./creative-project-commit-authority.ts";
import type { CreativeProjectCommitAuthority } from "./creative-project-store-port.ts";
import {
  extensionCanonicalJson,
  parsePluginTaskAdmissionPin,
  parsePluginProjectWorkspaceOwnerScope,
  type PluginProjectWorkspaceOwnerScope,
} from "@crewon/domain";
import { parseCreativeProjectUiActionRequest } from "@crewon/contracts/plugins";
import { ApplicationError } from "./application-error.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import { capturePluginUiInvocationCommitAuthority } from "./plugin-ui-invocation-authority.ts";
import { committedTaskContext } from "./plugin-ui-committed-task-support.ts";
import { captureProjectConversationAuthority } from "./project-conversation-authority.ts";
import type { ProjectConversationCommitAuthority } from "./project-conversation-store-port.ts";
import {
  parseProjectConversationsActionRequest,
  PROJECT_CONVERSATIONS_METHOD_ACTIONS,
} from "@crewon/contracts/project-conversations";
import {
  captureCreativeProjectRunReadAuthority,
  type CreativeProjectRunReadAuthority,
} from "./creative-project-run-commit-authority.ts";

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
const mutationMethods = {
  renameProject: ["loadProject"],
  setProjectState: ["loadProject"],
  appendBrief: ["loadProject"],
  createConcept: ["loadProject", "loadBrief"],
  appendConceptRevision: ["loadProject", "loadBrief", "loadConceptAsset"],
} as const;
export function isPluginProjectMutationAction(action: string): boolean {
  return (
    action.startsWith("crewon.creative-projects.v1.") &&
    Object.hasOwn(
      mutationMethods,
      action.slice("crewon.creative-projects.v1.".length),
    )
  );
}
type Qualified = Readonly<{
  runAuthority?: CreativeProjectRunReadAuthority;
  foundationRunAuthority?: ProjectFoundationRunReadAuthority;
  purpose: "read" | "mutation";
  scope: PluginProjectWorkspaceOwnerScope;
  snapshot: Readonly<{
    pin: ReturnType<typeof committedTaskContext>["pin"];
    context: Pick<PluginUiActionContext, "selection" | "package">;
    fingerprint: string;
  }>;
  request:
    | Readonly<{
        action:
          | "crewon.project-run-read.v1"
          | "crewon.project-foundation-run-read.v1";
        input: Readonly<{
          projectId: string;
          briefRevision?: number;
          revision?: number;
          digest?: string;
        }>;
      }>
    | ProjectFoundationUiRequest
    | ReturnType<typeof parseCreativeProjectUiActionRequest>
    | ReturnType<typeof parseProjectConversationsActionRequest>
    | Readonly<{
        action: typeof PROJECT_WORKSPACE_TARGET_ACTION;
        input: ReturnType<typeof parseProjectWorkspaceTargetRequest>;
      }>;
  methods: readonly string[];
  assertCurrent(): Promise<void>;
  assertActive(): void;
}>;
const references = new WeakMap<object, Qualified>();

/** Separate original Foundation Tool evidence; never obtained from public scope hints. */
export async function issuePluginProjectFoundationRunReadScope(
  input: Readonly<{
    authority: ProjectFoundationRunReadAuthority;
    assertActive(): void;
  }>,
): Promise<PluginProjectReadScope> {
  const q = captureProjectFoundationRunReadAuthority(input.authority);
  const methods: Record<string, readonly string[]> = {
    foundation_scope: [],
    foundation_read: [],
    foundation_source: ["loadSource"],
    foundation_source_page: ["loadSource", "readSourcePage"],
    foundation_chapters: ["loadSource", "listSourceChapters"],
    foundation_proposal: ["loadProposal"],
    foundation_proposals: ["listProposals"],
  };
  if (!Object.hasOwn(methods, q.operationId)) unavailable();
  const active = input.assertActive.bind(input);
  active();
  await q.assertCurrent();
  active();
  const command = JSON.parse(q.commandInput) as Record<string, unknown>;
  const pin = parsePluginTaskAdmissionPin(
    Object.fromEntries(
      [
        "tenantId",
        "spaceId",
        "profileId",
        "pluginId",
        "publisherId",
        "version",
        "packageDigest",
        "selectionRevision",
        "principalId",
        "actorId",
        "contributionId",
        "action",
        "authorityEpoch",
      ].map((k) => [k, q.admission[k as keyof typeof q.admission]]),
    ),
  );
  const request = Object.freeze({
    action: "crewon.project-foundation-run-read.v1" as const,
    input: Object.freeze({
      projectId: q.foundationAdmission.projectId,
      ...(command.proposalRevision === undefined
        ? {}
        : {
            revision: Number(command.proposalRevision),
            digest: String(command.proposalDigest),
          }),
      ...(command.sourceRevision === undefined
        ? {}
        : {
            revision: Number(command.sourceRevision),
            digest: String(command.sourceDigest),
          }),
    }),
  });
  const ref: PluginProjectReadScope = Object.freeze({
    version: "crewon.plugin-project-read-scope.v1",
  });
  references.set(
    ref,
    Object.freeze({
      purpose: "read",
      foundationRunAuthority: q,
      scope: parsePluginProjectWorkspaceOwnerScope({
        ...q.actor,
        profileId: pin.profileId,
        pluginId: pin.pluginId,
        publisherId: pin.publisherId,
      }),
      snapshot: Object.freeze({
        pin,
        context: Object.freeze({ selection: q.selection, package: q.package }),
        fingerprint: extensionCanonicalJson({
          pin,
          request,
          receiptId: q.receipt.receiptId,
        }),
      }),
      request,
      methods: Object.freeze([
        "loadProject",
        "loadBrief",
        "loadFoundation",
        ...methods[q.operationId]!,
      ]),
      assertActive: active,
      assertCurrent: async () => {
        active();
        await q.assertCurrent();
        active();
      },
    }),
  );
  return ref;
}

/** Trusted Worker producer only; original Run/Tool evidence is rechecked on the Store's transaction connection. */
export async function issuePluginProjectRunReadScope(
  input: Readonly<{
    authority: CreativeProjectRunReadAuthority;
    assertActive(): void;
  }>,
): Promise<PluginProjectReadScope> {
  const q = captureCreativeProjectRunReadAuthority(input.authority);
  const active = input.assertActive.bind(input);
  active();
  await q.assertCurrent();
  active();
  const command = JSON.parse(q.commandInput) as Record<string, unknown>;
  const projectId = q.projectStageAdmission!.projectId;
  if (command.projectId !== projectId) unavailable();
  let briefRevision: number | undefined;
  const contentSource = command.source as Record<string, unknown> | undefined;
  const textRead =
    q.operationId !== "project_read" &&
    (q.operationId !== "content_read" || contentSource?.kind === "text");
  if (q.operationId === "content_read") {
    if (contentSource?.kind === "brief") {
      if (
        !Number.isSafeInteger(contentSource.briefRevision) ||
        Number(contentSource.briefRevision) < 1
      )
        unavailable();
      briefRevision = Number(contentSource.briefRevision);
    } else if (contentSource?.kind !== "text") unavailable();
  }
  const pin = parsePluginTaskAdmissionPin(
    Object.fromEntries(
      [
        "tenantId",
        "spaceId",
        "profileId",
        "pluginId",
        "publisherId",
        "version",
        "packageDigest",
        "selectionRevision",
        "principalId",
        "actorId",
        "contributionId",
        "action",
        "authorityEpoch",
      ].map((k) => [k, q.admission[k as keyof typeof q.admission]]),
    ),
  );
  const request = Object.freeze({
    action: "crewon.project-run-read.v1" as const,
    input: Object.freeze({
      projectId,
      ...(briefRevision === undefined ? {} : { briefRevision }),
    }),
  });
  const source: Qualified = Object.freeze({
    purpose: "read",
    runAuthority: q,
    scope: parsePluginProjectWorkspaceOwnerScope({
      ...q.actor,
      profileId: pin.profileId,
      pluginId: pin.pluginId,
      publisherId: pin.publisherId,
    }),
    snapshot: Object.freeze({
      pin,
      context: Object.freeze({ selection: q.selection, package: q.package }),
      fingerprint: extensionCanonicalJson({
        pin,
        request,
        receiptId: q.receipt.receiptId,
      }),
    }),
    request,
    methods: Object.freeze([
      "loadProject",
      "loadBrief",
      ...(textRead
        ? [
            "loadOutline",
            "loadScript",
            "loadArtifact",
            "loadRevision",
            "loadOutlineSourceRevision",
            "loadStructuredRevision",
            "loadFoundation",
            "loadSource",
            "readSourcePage",
            "listSourceChapters",
          ]
        : []),
      ...(q.operationId === "text_history"
        ? ["listRevisions", "listStructuredRevisions"]
        : []),
    ]),
    assertActive: active,
    assertCurrent: async () => {
      active();
      await q.assertCurrent();
      active();
    },
  });
  const ref: PluginProjectReadScope = Object.freeze({
    version: "crewon.plugin-project-read-scope.v1",
  });
  references.set(ref, source);
  return ref;
}

/** Private original Conversation preparation reader. It grants neither a mutation scope nor a Run/Tool capability. */
export function capturePluginProjectConversationReadScope(
  context: PluginUiActionContext,
  hostAuthority: ProjectConversationCommitAuthority,
): PluginProjectReadScope {
  const live = capturePluginUiInvocationCommitAuthority(context);
  const host = captureProjectConversationAuthority(hostAuthority);
  const snapshot = committedTaskContext(context);
  const target = context.action === PROJECT_WORKSPACE_TARGET_ACTION;
  const request = target
    ? Object.freeze({
        action: PROJECT_WORKSPACE_TARGET_ACTION,
        input: parseProjectWorkspaceTargetRequest(context.input),
      })
    : parseProjectConversationsActionRequest({
        action: context.action,
        input: context.input,
      });
  if (
    (!target &&
      ![
        PROJECT_CONVERSATIONS_METHOD_ACTIONS.createConversation,
        PROJECT_CONVERSATIONS_METHOD_ACTIONS.getBinding,
        PROJECT_CONVERSATIONS_METHOD_ACTIONS.listConversations,
        PROJECT_CONVERSATIONS_METHOD_ACTIONS.openConversation,
        PROJECT_CONVERSATIONS_METHOD_ACTIONS.refreshSource,
        PROJECT_CONVERSATIONS_METHOD_ACTIONS.setState,
      ].includes(request.action as never)) ||
    snapshot.pin.action !== request.action ||
    extensionCanonicalJson({ ...snapshot.pin, action: "project.execute" }) !==
      extensionCanonicalJson(host.pin) ||
    extensionCanonicalJson(snapshot.context.selection) !==
      extensionCanonicalJson(host.selection) ||
    extensionCanonicalJson(snapshot.context.package) !==
      extensionCanonicalJson(host.package)
  )
    unavailable();
  const active = () => {
    live.assertActive();
    host.assertActive();
    if (committedTaskContext(context).fingerprint !== snapshot.fingerprint)
      unavailable();
  };
  active();
  const pin = snapshot.pin;
  const source: Qualified = Object.freeze({
    purpose: "read",
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
    methods: Object.freeze(["loadProject"]),
    assertActive: active,
    assertCurrent: async () => {
      active();
      await host.assertCurrent();
      await host.assertTransactionCurrent();
      await live.assertCurrent();
      active();
    },
  });
  const ref: PluginProjectReadScope = Object.freeze({
    version: "crewon.plugin-project-read-scope.v1",
  });
  references.set(ref, source);
  return ref;
}

/** Private issuer. The exact registered UI call is required before reading its fields. */
export function capturePluginProjectReadScope(
  context: PluginUiActionContext,
  hostAuthority: CreativeProjectCommitAuthority,
): PluginProjectReadScope {
  return captureScope(context, hostAuthority, "read") as PluginProjectReadScope;
}
/** Private issuer for original project mutations; creation has its own source and recipe. */
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
      : !Object.hasOwn(mutationMethods, name)) ||
    authority.transaction === undefined ||
    authority.transaction.pin.action !== request.action
  )
    unavailable();
  const methods =
    purpose === "read"
      ? actionMethods[name as keyof typeof actionMethods]
      : mutationMethods[name as keyof typeof mutationMethods];
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
/** Trusted backend issuer after actual Control execution admission. Identification/installation snapshot only, never a fabricated UI invocation or Run grant. */
export function issuePluginProjectConversationStageReadScope(
  input: Readonly<{
    authority: ProjectConversationCommitAuthority;
    request: Extract<
      ReturnType<typeof parseProjectConversationsActionRequest>,
      { action: typeof PROJECT_CONVERSATIONS_METHOD_ACTIONS.startStage }
    >;
  }>,
): PluginProjectReadScope {
  const authority = captureProjectConversationAuthority(input.authority);
  const request = parseProjectConversationsActionRequest(input.request);
  if (request.action !== PROJECT_CONVERSATIONS_METHOD_ACTIONS.startStage)
    unavailable();
  const pin = authority.pin;
  const snapshot = Object.freeze({
    pin,
    context: Object.freeze({
      selection: authority.selection,
      package: authority.package,
    }),
    fingerprint: extensionCanonicalJson({ pin, request }),
  });
  const ref: PluginProjectReadScope = Object.freeze({
    version: "crewon.plugin-project-read-scope.v1",
  });
  const source: Qualified = Object.freeze({
    purpose: "read",
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
    methods: Object.freeze([
      "loadProject",
      "loadBrief",
      ...(request.input.stage.kind === "discussion" ? ["loadFoundation"] : []),
      ...(request.input.stage.kind === "script" &&
      request.input.stage.outline !== null
        ? ["loadOutline", "loadOutlineSourceRevision", "loadRevision"]
        : []),
    ]),
    assertActive: authority.assertActive,
    assertCurrent: async () => {
      authority.assertActive();
      await authority.assertCurrent();
      await authority.assertTransactionCurrent();
      authority.assertActive();
    },
  });
  source.assertActive();
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

/** Internal Foundation adapter; ownership and actual invocation come from the opaque source. */
export function issueFoundationProjectReadScope(
  reference: PluginProjectFoundationScope,
): PluginProjectReadScope {
  const source = foundationProjectReadSource(reference);
  const ref: PluginProjectReadScope = Object.freeze({
    version: "crewon.plugin-project-read-scope.v1",
  });
  references.set(ref, source);
  return ref;
}
