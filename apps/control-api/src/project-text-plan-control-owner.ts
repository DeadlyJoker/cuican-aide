import {
  ApplicationError,
  preparePluginTaskModelSelection,
  preparePluginTaskTargetSelection,
  type PluginTaskModelSelectionPort,
  type ActorContext,
  type ProjectTextPlanCommitAuthority,
  type ProjectTextPlanStore,
  type ProjectConversationStore,
  type CreativeProjectAuthorizationPort,
  type ProjectTextPlanContinuationPort,
  type PluginProjectTextPlanAuthorizationPort,
  type PluginProjectTextPlanInvocationAuthority,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parseProjectTextPlan,
  parseProjectTextPlanRevision,
  type ProjectConversationInstallation,
} from "@crewon/domain";
import type { ProjectTextPlansActionRequest } from "@crewon/contracts/project-text-plans";
import type { ProjectConversationControlOwner } from "./project-conversation-control-owner.ts";
import type { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import type { CreativeProjectPluginUiConfig } from "./creative-project-plugin-ui-composition.ts";
import type { ContentDigester } from "@crewon/application";

export type ProjectTextPlanControlDependencies = Readonly<{
  configuration: CreativeProjectPluginUiConfig;
  plans: ProjectTextPlanStore;
  conversations: ProjectConversationStore;
  conversationOwner: ProjectConversationControlOwner;
  requests: InstalledPluginRequestOwner;
  authorization: CreativeProjectAuthorizationPort;
  digester: ContentDigester;
  modelSelection?(): PluginTaskModelSelectionPort | undefined;
}>;
/** Genuine mounted UI and genuine deployment identity share current fences, never their identity provenance. */
export class ProjectTextPlanControlOwner {
  readonly #d: ProjectTextPlanControlDependencies;
  readonly authorization: PluginProjectTextPlanAuthorizationPort;
  readonly continuation: ProjectTextPlanContinuationPort;
  constructor(d: ProjectTextPlanControlDependencies) {
    this.#d = Object.freeze({
      ...d,
      configuration: Object.freeze({
        publications: Object.freeze(
          d.configuration.publications.map((x) => Object.freeze({ ...x })),
        ),
      }),
      authorization: {
        authorize: d.authorization.authorize.bind(d.authorization),
      },
    });
    this.authorization = Object.freeze<PluginProjectTextPlanAuthorizationPort>({
      issueRead: (_context, request, invocation) =>
        this.#read(request, invocation),
      issueCommit: (_context, request, invocation) =>
        this.#commit(request, invocation),
    });
    this.continuation = Object.freeze<ProjectTextPlanContinuationPort>({
      run: async (locator, signal, work) => {
        const raw = await this.#d.plans.loadPlan(locator);
        if (raw === null) unavailable();
        const plan = parseProjectTextPlan(raw, this.#d.digester),
          record = await this.#d.plans.loadRevision({
            ...locator,
            planRevision: plan.currentPlanRevision,
          });
        if (record === null) unavailable();
        const definition = parseProjectTextPlanRevision(
          record,
          this.#d.digester,
        );
        if (
          !same(plan.owner, locator.actor) ||
          plan.profileId !== locator.profileId ||
          !same(definition.actor, plan.owner)
        )
          denied();
        this.#publication(
          definition.installation,
          definition.delegation.contributionId,
        );
        return this.#d.requests.runDelegated(
          {
            actor: plan.owner,
            scope: {
              tenantId: plan.owner.tenantId,
              spaceId: plan.owner.spaceId,
              profileId: plan.profileId,
            },
            installation: definition.installation,
            delegation: definition.delegation,
            signal,
          },
          async () => {
            const binding = await this.#binding(plan.owner, plan.threadId);
            if (
              binding.bindingId !== plan.bindingId ||
              binding.revision !== definition.bindingRevision ||
              !same(binding.currentInstallation, definition.installation)
            )
              denied();
            const conversation =
              await this.#d.conversationOwner.issuePlanConversationAuthority(
                plan.owner,
                definition.installation,
                "metadata",
              );
            const authority = this.#authority(
              binding,
              conversation,
              definition.delegation,
              plan.projectId,
            );
            await authority.assertCurrent();
            authority.assertActive();
            return work({
              plan: authority,
              conversation,
              prepareExecution: async () => {
                await this.#d.requests.prepareDelegatedExecution();
                return this.#d.conversationOwner.issuePlanConversationAuthority(
                  plan.owner,
                  definition.installation,
                  "execute",
                );
              },
            });
          },
        );
      },
    });
  }
  async #read(
    request: ProjectTextPlansActionRequest,
    invocation: PluginProjectTextPlanInvocationAuthority,
  ) {
    this.#publication(invocation.installation, invocation.contributionId);
    await invocation.assertCurrent();
    const q = await this.#d.conversationOwner.issuePlanConversationAuthority(
      invocation.actor,
      invocation.installation,
      "metadata",
    );
    await this.#policy(
      invocation.actor,
      request.input.projectId,
      "creativeProject:read",
    );
    return Object.freeze({
      ...q,
      assertActive: () => {
        invocation.assertActive();
        q.assertActive();
      },
      assertCurrent: async () => {
        await invocation.assertCurrent();
        await q.assertCurrent();
        await this.#policy(
          q.actor,
          request.input.projectId,
          "creativeProject:read",
        );
        invocation.assertActive();
        q.assertActive();
      },
      assertTransactionCurrent: async () => {
        await invocation.assertTransactionCurrent();
        await q.assertTransactionCurrent();
        await this.#policy(
          q.actor,
          request.input.projectId,
          "creativeProject:read",
        );
        invocation.assertActive();
        q.assertActive();
      },
    });
  }
  async #commit(
    request: ProjectTextPlansActionRequest,
    invocation: PluginProjectTextPlanInvocationAuthority,
  ): Promise<ProjectTextPlanCommitAuthority> {
    this.#publication(invocation.installation, invocation.contributionId);
    await invocation.assertCurrent();
    let threadId: string;
    if (request.action === "crewon.project-text-plans.v1.start")
      threadId = request.input.threadId;
    else if (
      request.action !== "crewon.project-text-plans.v1.get" &&
      request.action !== "crewon.project-text-plans.v1.list"
    ) {
      const raw = await this.#d.plans.loadPlan({
        actor: invocation.actor,
        profileId: invocation.installation.profileId,
        planId: request.input.planId,
      });
      if (raw === null) unavailable();
      const plan = parseProjectTextPlan(raw, this.#d.digester);
      if (plan.projectId !== request.input.projectId) denied();
      threadId = plan.threadId;
    } else denied();
    const binding = await this.#binding(invocation.actor, threadId);
    if (
      binding.projectId !== request.input.projectId ||
      !same(binding.currentInstallation, invocation.installation)
    )
      denied();
    const q = await this.#d.conversationOwner.issuePlanConversationAuthority(
      invocation.actor,
      invocation.installation,
      "metadata",
    );
    const authority = this.#authority(
      binding,
      q,
      invocation.delegation,
      request.input.projectId,
      invocation,
    );
    await authority.assertCurrent();
    return authority;
  }
  #authority(
    binding: ProjectTextPlanCommitAuthority["binding"],
    q: Awaited<
      ReturnType<
        ProjectConversationControlOwner["issuePlanConversationAuthority"]
      >
    >,
    delegation: ProjectTextPlanCommitAuthority["delegation"],
    projectId: string,
    invocation?: PluginProjectTextPlanInvocationAuthority,
  ): ProjectTextPlanCommitAuthority {
    const active = () => {
      q.assertActive();
      invocation?.assertActive();
    };
    const transaction = async () => {
      active();
      await q.assertTransactionCurrent();
      await invocation?.assertTransactionCurrent();
      await this.#policy(q.actor, projectId, "creativeProject:write");
      active();
    };
    return Object.freeze({
      version: "crewon.project-text-plan-commit.v1",
      actor: q.actor,
      binding,
      selection: q.selection,
      package: q.package,
      delegation,
      ...(this.#d.modelSelection === undefined
        ? {}
        : {
            prepareModelSelection: async (
              input: Parameters<
                NonNullable<
                  ProjectTextPlanCommitAuthority["prepareModelSelection"]
                >
              >[0],
            ) => {
              await q.assertCurrent();
              q.assertActive();
              const common = {
                actor: q.actor,
                pin: q.pin,
                configuration: input.configuration,
              };
              const selection =
                input.selection.kind === "model"
                  ? await preparePluginTaskModelSelection(
                      this.#d.modelSelection!(),
                      { ...common, modelId: input.selection.modelId },
                      this.#d.digester,
                    )
                  : await preparePluginTaskTargetSelection(
                      this.#d.modelSelection!(),
                      { ...common, target: input.selection.target },
                      this.#d.digester,
                    );
              await q.assertCurrent();
              q.assertActive();
              active();
              return selection;
            },
          }),
      backgroundAuthorization: this.#d.requests.supportsDelegatedIdentity()
        ? "available"
        : "unavailable",
      assertActive: active,
      assertTransactionCurrent: transaction,
      assertCurrent: async () => {
        await transaction();
        await q.assertCurrent();
        await invocation?.assertCurrent();
        const current = await this.#binding(q.actor, binding.threadId);
        if (!same(current, binding)) denied();
        active();
      },
    });
  }
  async #binding(actor: ActorContext, threadId: string) {
    const raw = await this.#d.conversations.loadBinding({
      actor,
      profileId: this.#d.requests.currentScope().profileId,
      threadId,
    });
    if (raw === null || raw.state !== "active") denied();
    return raw;
  }
  #publication(
    installation: ProjectConversationInstallation,
    contributionId: string,
  ) {
    if (
      !this.#d.configuration.publications.some(
        (x) =>
          x.pluginId === installation.pluginId &&
          x.packageDigest === installation.packageDigest &&
          x.contributionId === contributionId,
      )
    )
      denied();
  }
  async #policy(
    actor: ActorContext,
    projectId: string,
    action: "creativeProject:read" | "creativeProject:write",
  ) {
    const decision = await this.#d.authorization.authorize({
      actor,
      action,
      resource: {
        kind: "creativeProject",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        projectId,
      },
    });
    if (decision.outcome !== "allow") denied();
  }
}
function same(a: unknown, b: unknown) {
  return extensionCanonicalJson(a) === extensionCanonicalJson(b);
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "project_text_plan_authorization_unavailable",
  );
}
function unavailable(): never {
  throw new ApplicationError("conflict", "project_text_plan_unavailable");
}
