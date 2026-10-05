import {
  CREWON_PROJECT_TEXT_PLANS_SERVICE,
  CREWON_PROJECT_TEXT_PLANS_API_VERSION,
  MAX_PROJECT_TEXT_PLANS_VIEW_BYTES,
  parseProjectTextPlansActionResponse,
  type ProjectTextPlansActionRequest,
} from "@crewon/contracts/project-text-plans";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import { extensionCanonicalJson } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import {
  ProjectTextPlanApplicationService,
  isProjectTextPlanApplicationService,
} from "./project-text-plan-application-service.ts";
import { captureProjectConversationAuthority } from "./project-conversation-authority.ts";
import { captureProjectTextPlanCommitAuthority } from "./project-text-plan-authority.ts";
import type { ProjectConversationCommitAuthority } from "./project-conversation-store-port.ts";
import type { ProjectTextPlanCommitAuthority } from "./project-text-plan-store-port.ts";
import { capturePluginProjectTextPlanInvocationCommitAuthority } from "./plugin-ui-invocation-authority.ts";
import {
  isProjectTextPlanAction,
  projectTextPlanActionContext,
  type PluginProjectTextPlanInvocationAuthority,
} from "./plugin-project-text-plan-action-context.ts";
import {
  captureProjectTextPublications,
  type PluginProjectTextActionPublication,
} from "./plugin-project-text-action-owner.ts";
import { uiRecord } from "./plugin-ui-application-support.ts";
import type {
  PluginUiActionContext,
  PluginUiActionPort,
  PluginUiCommittedMetadataOutcome,
  PluginUiCommittedMetadataPort,
  PluginUiJsonValue,
} from "./plugin-ui-ports.ts";

export interface PluginProjectTextPlanAuthorizationPort {
  issueRead(
    context: PluginUiActionContext,
    request: ProjectTextPlansActionRequest,
    invocation: PluginProjectTextPlanInvocationAuthority,
  ): Promise<ProjectConversationCommitAuthority>;
  issueCommit(
    context: PluginUiActionContext,
    request: ProjectTextPlansActionRequest,
    invocation: PluginProjectTextPlanInvocationAuthority,
  ): Promise<ProjectTextPlanCommitAuthority>;
}
export type PluginProjectTextPlanActionOwnerDependencies = Readonly<{
  plans: ProjectTextPlanApplicationService;
  publications: readonly PluginProjectTextActionPublication[];
  authorization: PluginProjectTextPlanAuthorizationPort;
}>;
type Outcome = Readonly<{
  context: PluginUiActionContext;
  fingerprint: string;
  output: PluginUiJsonValue;
}>;
const actualOwners = new WeakSet<object>();
const outcomePrototype = Object.freeze(Object.create(null) as object);
export function isPluginProjectTextPlanActionOwner(
  input: unknown,
): input is PluginProjectTextPlanActionOwner {
  return input !== null && typeof input === "object" && actualOwners.has(input);
}

/** Only an actual mounted invocation can create delegation. This owner never launches a Run or Node host. */
export class PluginProjectTextPlanActionOwner {
  readonly actions: PluginUiActionPort;
  readonly committedMetadata: PluginUiCommittedMetadataPort;
  readonly #plans: ReturnType<typeof capturePlans>;
  readonly #publications: readonly PluginProjectTextActionPublication[];
  readonly #authorization: PluginProjectTextPlanAuthorizationPort;
  readonly #outcomes = new WeakMap<object, Outcome>();
  #closed = false;
  #pending = 0;
  #closing: Promise<void> | undefined;
  #finishClose: (() => void) | undefined;
  constructor(input: PluginProjectTextPlanActionOwnerDependencies) {
    try {
      const v = uiRecord(input, ["plans", "publications", "authorization"]);
      this.#plans = capturePlans(v.plans);
      this.#publications = captureProjectTextPublications(v.publications);
      this.#authorization = Object.freeze({
        issueRead: captureMethod(v.authorization, "issueRead"),
        issueCommit: captureMethod(v.authorization, "issueCommit"),
      }) as PluginProjectTextPlanAuthorizationPort;
    } catch (cause) {
      throw new ApplicationError(
        "internal",
        "plugin_project_text_plan_config_invalid",
        { cause },
      );
    }
    this.actions = Object.freeze({
      invoke: (context: PluginUiActionContext) => this.#invoke(context),
    });
    this.committedMetadata = Object.freeze({
      isOutcome: (input: unknown): input is PluginUiCommittedMetadataOutcome =>
        input !== null &&
        typeof input === "object" &&
        this.#outcomes.has(input),
      verify: (
        context: PluginUiActionContext,
        outcome: PluginUiCommittedMetadataOutcome,
      ) => this.#verify(context, outcome),
    });
    actualOwners.add(this);
    Object.freeze(this);
  }
  supportsAction(action: string): boolean {
    return isProjectTextPlanAction(action);
  }
  assertAvailable(): void {
    if (this.#closed) denied("plugin_project_text_plan_actions_unavailable");
  }
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    return (this.#closing =
      this.#pending === 0
        ? Promise.resolve()
        : new Promise((resolve) => {
            this.#finishClose = resolve;
          }));
  }
  async #invoke(context: PluginUiActionContext) {
    this.assertAvailable();
    if (this.#pending >= 64)
      throw new ApplicationError(
        "conflict",
        "plugin_project_text_plan_inflight_limit",
      );
    const original =
      capturePluginProjectTextPlanInvocationCommitAuthority(context);
    const snapshot = projectTextPlanActionContext(context),
      request = snapshot.request;
    this.#assertPublication(snapshot.context);
    this.#pending++;
    try {
      const active = () => {
        this.assertAvailable();
        original.assertActive();
      };
      active();
      await original.assertCurrent();
      active();
      const read =
        request.action === "crewon.project-text-plans.v1.get" ||
        request.action === "crewon.project-text-plans.v1.list";
      let output: unknown;
      if (read) {
        const q = captureProjectConversationAuthority(
          await this.#authorization.issueRead(context, request, original),
        );
        this.#assertIssued(
          original,
          q.actor,
          q.installation,
          q.selection,
          q.package,
        );
        if (q.pin.contributionId !== original.contributionId) denied();
        const authority: ProjectConversationCommitAuthority = Object.freeze({
          ...q,
          assertActive: () => {
            active();
            q.assertActive();
          },
          assertCurrent: () =>
            this.#fence(active, original.assertCurrent, q.assertCurrent),
          assertTransactionCurrent: () =>
            this.#fence(
              active,
              original.assertTransactionCurrent,
              q.assertTransactionCurrent,
            ),
        });
        output =
          request.action === "crewon.project-text-plans.v1.get"
            ? await this.#plans.get(original.actor, request.input, authority)
            : await this.#plans.list(original.actor, request.input, authority);
        await authority.assertCurrent();
        authority.assertActive();
      } else {
        const q = captureProjectTextPlanCommitAuthority(
          await this.#authorization.issueCommit(context, request, original),
        );
        this.#assertIssued(
          original,
          q.actor,
          q.binding.currentInstallation,
          q.selection,
          q.package,
        );
        if (
          q.binding.projectId !== request.input.projectId ||
          extensionCanonicalJson(q.delegation) !==
            extensionCanonicalJson(original.delegation)
        )
          denied();
        if (
          request.action === "crewon.project-text-plans.v1.start" &&
          (q.binding.threadId !== request.input.threadId ||
            q.binding.revision !== request.input.expectedBindingRevision)
        )
          denied();
        const authority: ProjectTextPlanCommitAuthority = Object.freeze({
          ...q,
          assertActive: () => {
            active();
            q.assertActive();
          },
          assertCurrent: () =>
            this.#fence(active, original.assertCurrent, q.assertCurrent),
          assertTransactionCurrent: () =>
            this.#fence(
              active,
              original.assertTransactionCurrent,
              q.assertTransactionCurrent,
            ),
        });
        switch (request.action) {
          case "crewon.project-text-plans.v1.start":
            output = await this.#plans.start(
              original.actor,
              request.input,
              authority,
            );
            break;
          case "crewon.project-text-plans.v1.pause":
            output = await this.#plans.pause(
              original.actor,
              request.input,
              authority,
            );
            break;
          case "crewon.project-text-plans.v1.resume":
            output = await this.#plans.resume(
              original.actor,
              request.input,
              authority,
            );
            break;
          case "crewon.project-text-plans.v1.revoke":
            output = await this.#plans.revoke(
              original.actor,
              request.input,
              authority,
            );
            break;
          case "crewon.project-text-plans.v1.reviseRemaining":
            output = await this.#plans.reviseRemaining(
              original.actor,
              request.input,
              authority,
            );
            break;
          case "crewon.project-text-plans.v1.continue":
            output = await this.#plans.continue(
              original.actor,
              request.input,
              authority,
            );
            break;
        }
      }
      const parsed = parsePluginUiJsonValue(
        parseProjectTextPlansActionResponse(request, output),
        { maxBytes: MAX_PROJECT_TEXT_PLANS_VIEW_BYTES },
      );
      if (
        projectTextPlanActionContext(context).fingerprint !==
        snapshot.fingerprint
      )
        denied("plugin_project_text_plan_context_changed");
      if (read) return parsed;
      // A genuine Service return is a confirmed COMMIT/replay. Late withdrawal cannot undo that fact.
      const outcome = Object.freeze(
        Object.create(outcomePrototype),
      ) as PluginUiCommittedMetadataOutcome;
      this.#outcomes.set(
        outcome,
        Object.freeze({
          context,
          fingerprint: snapshot.fingerprint,
          output: parsed,
        }),
      );
      return outcome;
    } finally {
      this.#pending--;
      if (this.#pending === 0) this.#finishClose?.();
    }
  }
  async #fence(
    active: () => void,
    original: () => Promise<void>,
    issued: () => Promise<void>,
  ): Promise<void> {
    active();
    await original();
    active();
    await issued();
    active();
  }
  #assertIssued(
    original: PluginProjectTextPlanInvocationAuthority,
    actor: unknown,
    installation: unknown,
    selection: unknown,
    pkg: unknown,
  ): void {
    for (const [actual, expected] of [
      [actor, original.actor],
      [installation, original.installation],
      [selection, original.selection],
      [pkg, original.package],
    ])
      if (extensionCanonicalJson(actual) !== extensionCanonicalJson(expected))
        denied();
    original.assertActive();
    this.assertAvailable();
  }
  #verify(
    context: PluginUiActionContext,
    outcome: PluginUiCommittedMetadataOutcome,
  ): PluginUiJsonValue {
    const entry =
      outcome !== null && typeof outcome === "object"
        ? this.#outcomes.get(outcome)
        : undefined;
    this.#outcomes.delete(outcome);
    if (
      entry === undefined ||
      entry.context !== context ||
      projectTextPlanActionContext(context).fingerprint !== entry.fingerprint
    )
      throw new ApplicationError(
        "internal",
        "plugin_ui_committed_metadata_invalid",
      );
    return entry.output;
  }
  #assertPublication(context: PluginUiActionContext): void {
    const d = context.lease.descriptor,
      contribution = d.contributions.find(
        (c) => c.id === context.lease.contributionId,
      ),
      dual = d.entrypoints.node !== null && d.businessManifestPath !== null;
    if (
      !this.#publications.some(
        (p) =>
          p.pluginId === d.pluginId &&
          p.packageDigest === context.package.packageDigest &&
          p.contributionId === context.lease.contributionId,
      ) ||
      contribution?.kind !== "module" ||
      contribution.slot !== "main.content" ||
      !d.requires.some(
        (r) =>
          r.service === CREWON_PROJECT_TEXT_PLANS_SERVICE &&
          r.apiVersion === CREWON_PROJECT_TEXT_PLANS_API_VERSION &&
          (!r.optional || dual),
      )
    )
      denied("plugin_project_text_plan_publication_unavailable");
  }
}
function capturePlans(input: unknown) {
  if (!isProjectTextPlanApplicationService(input))
    throw new Error("plugin_project_text_plan_service_invalid");
  const p = ProjectTextPlanApplicationService.prototype;
  return Object.freeze({
    start: p.start.bind(input),
    get: p.get.bind(input),
    list: p.list.bind(input),
    pause: p.pause.bind(input),
    resume: p.resume.bind(input),
    revoke: p.revoke.bind(input),
    reviseRemaining: p.reviseRemaining.bind(input),
    continue: p.continue.bind(input),
  });
}
function captureMethod(
  input: unknown,
  key: string,
): (...args: never[]) => unknown {
  if (input === null || typeof input !== "object")
    throw new Error("plugin_project_text_plan_authorization_invalid");
  let target: object | null = input;
  for (
    let i = 0;
    target !== null && i < 16;
    i++, target = Object.getPrototypeOf(target)
  ) {
    const d = Object.getOwnPropertyDescriptor(target, key);
    if (d === undefined) continue;
    if (!Object.hasOwn(d, "value") || typeof d.value !== "function") break;
    return d.value.bind(input);
  }
  throw new Error("plugin_project_text_plan_authorization_invalid");
}
function denied(code = "plugin_project_text_plan_action_denied"): never {
  throw new ApplicationError("authorization", code);
}
