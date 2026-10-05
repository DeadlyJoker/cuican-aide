import {
  parseCreativeProjectUiActionRequest,
  parseCreativeProjectUiActionResponse,
} from "@crewon/contracts/plugins";
import {
  parseProjectPlanningProposal,
  type ProjectPlanningProposal,
} from "@crewon/contracts/project-planning";
import {
  PROJECT_CONVERSATION_ASSOCIATION_ACTIONS,
  parseProjectConversationAssociationRequest,
  parseProjectConversationAssociationResponse,
} from "@crewon/contracts/project-conversation-association";
import {
  PROJECT_CONVERSATIONS_METHOD_ACTIONS,
  parseProjectConversationsActionRequest,
  parseProjectConversationsActionResponse,
  type PublicProjectConversationBinding,
} from "@crewon/contracts/project-conversations";
import {
  PROJECT_TEXT_PLANS_METHOD_ACTIONS,
  parseProjectTextPlansActionRequest,
  parseProjectTextPlansActionResponse,
  type PublicProjectTextPlanView,
} from "@crewon/contracts/project-text-plans";
import {
  parsePluginUiJsonValue,
  type PluginUiLease,
} from "@crewon/contracts/plugins";
import type { ControlPluginUiModule } from "./controlPluginUiCatalog";
import {
  proposalLaunchIdentity,
  type ProjectPlanningLaunchIntent,
  type ProjectPlanningLaunchIntentStore,
  type ProjectPlanningLaunchMode,
} from "./projectPlanningLaunchIntent";

export type ProjectPlanningLaunchState = Readonly<{
  phase: "idle" | "working" | "uncertain" | "created" | "started";
  intent: ProjectPlanningLaunchIntent | null;
  plan: PublicProjectTextPlanView | null;
  error: string | null;
}>;
export type ProjectPlanningLaunchPort = Readonly<{
  supports(proposal: ProjectPlanningProposal): boolean;
  available(proposal: ProjectPlanningProposal): boolean;
  snapshot(proposal: ProjectPlanningProposal): ProjectPlanningLaunchState;
  subscribe(listener: () => void): () => void;
  confirm(
    proposal: ProjectPlanningProposal,
    choice: Readonly<{
      mode: ProjectPlanningLaunchMode;
      adoption: "manual" | "whenUnchanged";
    }>,
  ): Promise<void>;
  refresh(proposal: ProjectPlanningProposal): Promise<void>;
}>;
export type ProjectPlanningLaunchTransport = Readonly<{
  module(proposal: ProjectPlanningProposal): ControlPluginUiModule;
  assertCurrent(
    proposal: ProjectPlanningProposal,
    module: ControlPluginUiModule,
  ): void;
  originThread(
    proposal: ProjectPlanningProposal,
  ): Promise<Readonly<{ revision: number; workspaceId: string | null }>>;
  acquire(
    module: ControlPluginUiModule,
    proposal: ProjectPlanningProposal,
  ): Promise<PluginUiLease>;
  invoke(
    lease: PluginUiLease,
    request: Readonly<{ action: string; input: unknown }>,
  ): Promise<unknown>;
  release(lease: PluginUiLease): Promise<void>;
  retainUntilExpiry?(lease: PluginUiLease): void;
}>;
const IDLE: ProjectPlanningLaunchState = Object.freeze({
  phase: "idle",
  intent: null,
  plan: null,
  error: null,
});
function fail(code: string): never {
  throw new Error(code);
}

/** A host confirmation sequence over existing metadata services. Only text-plan start can schedule work. */
export function createProjectPlanningLaunch(
  store: ProjectPlanningLaunchIntentStore,
  transport: ProjectPlanningLaunchTransport,
): ProjectPlanningLaunchPort {
  const states = new Map<string, ProjectPlanningLaunchState>(),
    busy = new Set<string>(),
    listeners = new Set<() => void>();
  const publish = (
    proposal: ProjectPlanningProposal,
    state: ProjectPlanningLaunchState,
  ) => {
    states.set(proposalLaunchIdentity(proposal), Object.freeze(state));
    if (states.size > 32)
      for (const key of states.keys()) {
        if (!busy.has(key) && key !== proposalLaunchIdentity(proposal)) {
          states.delete(key);
          break;
        }
      }
    for (const listener of listeners) listener();
  };
  const snapshot = (
    proposal: ProjectPlanningProposal,
  ): ProjectPlanningLaunchState => {
    const identity = proposalLaunchIdentity(proposal),
      active = states.get(identity);
    if (active) return active;
    let intent: ProjectPlanningLaunchIntent | null;
    try {
      intent = store.get(proposal);
    } catch {
      return { ...IDLE, error: "project_planning_launch_intent_invalid" };
    }
    return intent
      ? Object.freeze({
          phase: restoredPhase(intent),
          intent,
          plan: null,
          error: null,
        })
      : IDLE;
  };
  const save = (
    proposal: ProjectPlanningProposal,
    intent: ProjectPlanningLaunchIntent,
    plan: PublicProjectTextPlanView | null = null,
  ) => {
    store.save(intent); // Must finish before dispatching a business command.
    publish(proposal, { phase: "working", intent, plan, error: null });
  };
  const current = (
    proposal: ProjectPlanningProposal,
    module: ControlPluginUiModule,
    intent: ProjectPlanningLaunchIntent | null,
  ) => {
    transport.assertCurrent(proposal, module);
    if (intent && intent.selectionRevision !== module.plugin.selectionRevision)
      fail("project_planning_launch_source_changed");
  };
  const bindingMatches = (
    binding: PublicProjectConversationBinding,
    intent: ProjectPlanningLaunchIntent,
    module: ControlPluginUiModule,
  ) => {
    const s = binding.source,
      p = module.plugin;
    if (
      binding.projectId !== intent.projectId ||
      binding.threadId !== intent.proposal.origin.threadId ||
      binding.workspaceId !== intent.workspaceId ||
      binding.state !== "active" ||
      s.pluginId !== p.descriptor.pluginId ||
      s.publisherId !== p.descriptor.publisherId ||
      s.version !== p.descriptor.version ||
      s.packageDigest !== p.packageDigest ||
      s.selectionRevision !== intent.selectionRevision
    )
      fail("project_planning_launch_binding_changed");
  };
  async function observe(
    lease: PluginUiLease,
    proposal: ProjectPlanningProposal,
    module: ControlPluginUiModule,
    intent: ProjectPlanningLaunchIntent,
  ) {
    current(proposal, module, intent);
    let binding: PublicProjectConversationBinding | null = null,
      plan: PublicProjectTextPlanView | null = null;
    if (intent.projectId) {
      const request = parseCreativeProjectUiActionRequest({
        action: "crewon.creative-projects.v1.getProject",
        input: { projectId: intent.projectId },
      });
      const result = parseCreativeProjectUiActionResponse(
        request,
        await transport.invoke(lease, request),
      );
      current(proposal, module, intent);
      if (!("project" in result) || result.project.state !== "active")
        fail("project_planning_launch_project_changed");
    }
    const request = parseProjectConversationsActionRequest({
      action: PROJECT_CONVERSATIONS_METHOD_ACTIONS.getBinding,
      input: { threadId: proposal.origin.threadId },
    });
    const result = parseProjectConversationsActionResponse(
      request,
      await transport.invoke(lease, request),
    );
    current(proposal, module, intent);
    if (!("binding" in result))
      fail("project_planning_launch_response_invalid");
    binding = result.binding;
    if (binding) bindingMatches(binding, intent, module);
    if (intent.associated && !binding)
      fail("project_planning_launch_binding_changed");
    if (intent.planId && intent.projectId) {
      const get = parseProjectTextPlansActionRequest({
        action: PROJECT_TEXT_PLANS_METHOD_ACTIONS.get,
        input: { projectId: intent.projectId, planId: intent.planId },
      });
      const response = parseProjectTextPlansActionResponse(
        get,
        await transport.invoke(lease, get),
      );
      current(proposal, module, intent);
      if (
        !("view" in response) ||
        !response.view ||
        response.view.plan.threadId !== proposal.origin.threadId
      )
        fail("project_planning_launch_plan_changed");
      plan = response.view;
    }
    return { binding, plan };
  }
  async function run(
    value: ProjectPlanningProposal,
    choice: Readonly<{
      mode: ProjectPlanningLaunchMode;
      adoption: "manual" | "whenUnchanged";
    }> | null,
  ) {
    const proposal = parseProjectPlanningProposal(value),
      identity = proposalLaunchIdentity(proposal);
    if (busy.has(identity)) fail("project_planning_launch_busy");
    const module = transport.module(proposal);
    let intent = store.get(proposal),
      lease: PluginUiLease | null = null,
      plan: PublicProjectTextPlanView | null = null,
      unresolvedDispatch = false;
    current(proposal, module, intent);
    if (
      choice &&
      intent &&
      (choice.mode !== intent.mode || choice.adoption !== intent.adoption)
    )
      fail("project_planning_launch_confirmation_changed");
    if (choice?.mode === "execute" && !proposal.capability.executionReady)
      fail("project_planning_launch_execution_unavailable");
    busy.add(identity);
    publish(proposal, { phase: "working", intent, plan, error: null });
    try {
      if (!intent && !choice) {
        publish(proposal, IDLE);
        return;
      }
      if (!intent) {
        const thread = await transport.originThread(proposal);
        current(proposal, module, null);
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(identity),
        );
        current(proposal, module, null);
        intent = Object.freeze({
          version: "crewon.project-planning-launch-intent.v1",
          proposal,
          selectionRevision: module.plugin.selectionRevision,
          mode: choice!.mode,
          adoption: choice!.adoption,
          key: Array.from(new Uint8Array(digest), (b) =>
            b.toString(16).padStart(2, "0"),
          ).join(""),
          threadRevision: thread.revision,
          workspaceId: thread.workspaceId,
          dispatched: null,
          projectId: null,
          briefRevision: null,
          attach: null,
          start: null,
          associated: false,
          planId: null,
        });
        save(proposal, intent);
      }
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(identity),
      );
      current(proposal, module, intent);
      if (
        intent.key !==
        Array.from(new Uint8Array(digest), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("")
      )
        fail("project_planning_launch_intent_invalid");
      lease = await transport.acquire(module, proposal);
      current(proposal, module, intent);
      const source = proposal.capability.source;
      if (
        lease.descriptor.pluginId !== source.pluginId ||
        lease.descriptor.publisherId !== source.publisherId ||
        lease.descriptor.version !== source.version ||
        lease.packageDigest !== source.packageDigest ||
        lease.contributionId !== source.contributionId ||
        lease.selectionRevision !== intent.selectionRevision
      )
        fail("project_planning_launch_source_changed");
      let observed = await observe(lease, proposal, module, intent);
      plan = observed.plan;
      // Cold restoration and refresh are observations. They cannot advance the sequence.
      if (!choice) {
        publish(proposal, {
          phase: restoredPhase(intent),
          intent,
          plan,
          error: null,
        });
        return;
      }
      if (!intent.projectId) {
        const create = parseCreativeProjectUiActionRequest({
          action: "crewon.creative-projects.v1.createProject",
          input: {
            request: {
              title: proposal.input.title,
              briefText: proposal.input.briefText,
            },
            idempotencyKey: `planning-create:${intent.key}`,
          },
        });
        intent = { ...intent, dispatched: "create" };
        save(proposal, intent);
        current(proposal, module, intent);
        unresolvedDispatch = true;
        const result = parseCreativeProjectUiActionResponse(
          create,
          await transport.invoke(lease, create),
        );
        // Retain a completed reply in its original account journal even if the visible Thread changed.
        if (!("project" in result) || !("brief" in result))
          fail("project_planning_launch_response_invalid");
        unresolvedDispatch = false;
        intent = {
          ...intent,
          projectId: result.project.projectId,
          briefRevision: result.brief.briefRevision,
          dispatched: null,
        };
        save(proposal, intent);
        current(proposal, module, intent);
        observed = await observe(lease, proposal, module, intent);
      }
      if (!intent.associated) {
        intent = {
          ...intent,
          attach: intent.attach ?? {
            projectId: intent.projectId!,
            threadId: proposal.origin.threadId,
            expectedThreadRevision: intent.threadRevision,
            workspaceId: intent.workspaceId,
            idempotencyKey: `planning-attach:${intent.key}`,
          },
        };
        save(proposal, intent);
        if (!observed.binding) {
          const attach = parseProjectConversationAssociationRequest({
            action: PROJECT_CONVERSATION_ASSOCIATION_ACTIONS.attach,
            input: intent.attach,
          });
          intent = { ...intent, dispatched: "attach" };
          save(proposal, intent);
          current(proposal, module, intent);
          unresolvedDispatch = true;
          const result = parseProjectConversationAssociationResponse(
            attach,
            await transport.invoke(lease, attach),
          );
          if (!("binding" in result))
            fail("project_planning_launch_response_invalid");
          bindingMatches(result.binding, intent, module);
          unresolvedDispatch = false;
          observed.binding = result.binding;
        }
        intent = { ...intent, associated: true, dispatched: null };
        save(proposal, intent);
        current(proposal, module, intent);
      }
      if (intent.mode === "execute" && !intent.planId) {
        intent = {
          ...intent,
          start: intent.start ?? {
            projectId: intent.projectId!,
            threadId: proposal.origin.threadId,
            expectedBindingRevision: observed.binding!.revision,
            idempotencyKey: `planning-start:${intent.key}`,
            expectedBriefRevision: intent.briefRevision!,
            instruction: proposal.input.instruction,
            start: proposal.input.start,
            target: proposal.input.target,
            episodes:
              proposal.input.episodeCount === null
                ? null
                : {
                    kind: "newOutline",
                    episodeCount: proposal.input.episodeCount,
                  },
            adoption: intent.adoption,
          },
          dispatched: "start",
        };
        save(proposal, intent);
        current(proposal, module, intent);
        const start = parseProjectTextPlansActionRequest({
          action: PROJECT_TEXT_PLANS_METHOD_ACTIONS.start,
          input: intent.start,
        });
        unresolvedDispatch = true;
        const result = parseProjectTextPlansActionResponse(
          start,
          await transport.invoke(lease, start),
        );
        if (
          !("view" in result) ||
          !result.view ||
          result.view.plan.threadId !== proposal.origin.threadId
        )
          fail("project_planning_launch_response_invalid");
        unresolvedDispatch = false;
        plan = result.view;
        intent = { ...intent, planId: plan.plan.planId, dispatched: null };
        save(proposal, intent, plan);
        current(proposal, module, intent);
      }
      publish(proposal, {
        phase: intent.planId ? "started" : "created",
        intent,
        plan,
        error: null,
      });
    } catch (error) {
      publish(proposal, {
        phase: intent?.dispatched
          ? "uncertain"
          : intent?.associated
            ? "created"
            : intent
              ? "uncertain"
              : "idle",
        intent,
        plan,
        error:
          error instanceof Error
            ? error.message.slice(0, 160)
            : "project_planning_launch_unavailable",
      });
      throw error;
    } finally {
      // Only this owned reference is released; no plugin Run or supplier request is cancelled.
      // An unresolved dispatch may still be committing in Control. Do not revoke its borrowed reference.
      // Its original host lease expires normally; recovery reacquires another exact source mount.
      if (lease && unresolvedDispatch) transport.retainUntilExpiry?.(lease);
      else if (lease)
        try {
          await transport.release(lease);
        } catch {
          /* Reference expires under its original Host owner. */
        }
      busy.delete(identity);
    }
  }
  return Object.freeze({
    supports(proposal) {
      try {
        transport.module(proposal);
        return true;
      } catch {
        return false;
      }
    },
    available(proposal) {
      try {
        const module = transport.module(proposal);
        current(proposal, module, store.get(proposal));
        return true;
      } catch {
        return false;
      }
    },
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    confirm: (proposal, choice) => run(proposal, choice),
    refresh: (proposal) => run(proposal, null),
  });
}

function restoredPhase(
  intent: ProjectPlanningLaunchIntent,
): ProjectPlanningLaunchState["phase"] {
  return intent.dispatched || (intent.mode === "execute" && !intent.planId)
    ? "uncertain"
    : intent.planId
      ? "started"
      : intent.associated
        ? "created"
        : "uncertain";
}
