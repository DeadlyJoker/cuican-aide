import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  PROJECT_TEXT_PLANS_METHOD_ACTIONS,
  type ProjectTextPlansMethod,
  type ProjectTextPlansRequests,
} from "@crewon/contracts/project-text-plans";
import { planFixture } from "../../store/src/project-text-plan.test-support.ts";
import { PluginUiApplicationService } from "./plugin-ui-application-service.ts";
import { ProjectTextPlanApplicationService } from "./project-text-plan-application-service.ts";
import { PluginProjectTextPlanActionOwner } from "./plugin-project-text-plan-action-owner.ts";
import type { PluginProjectTextPlanInvocationAuthority } from "./plugin-project-text-plan-action-context.ts";
import type {
  PluginUiActionContext,
  PluginUiActionPort,
} from "./plugin-ui-ports.ts";
import {
  uiFixture,
  uiTestDescriptor,
  uiTestBytes,
} from "./plugin-ui.test-support.ts";

/** Real Plan Service/SQLite commits and genuine UI registration; named verifier/PDP ports are explicit. No Native, model or supplier claim. */
export async function projectTextPlanActionFixture(t: TestContext) {
  const f = await planFixture(t, "sqlite"),
    ui = uiFixture();
  ui.state.scope = {
    tenantId: f.actor.tenantId,
    spaceId: f.actor.spaceId,
    profileId: f.installation.profileId,
  };
  ui.state.package = f.installed.package;
  ui.state.selection = f.enabled.selection;
  ui.state.descriptor = parsePluginPackageDescriptor({
    ...uiTestDescriptor,
    pluginId: f.installation.pluginId,
    publisherId: f.installation.publisherId,
    version: f.installation.version,
    businessManifestPath: "business.json",
    files: [
      ...uiTestDescriptor.files,
      { path: "business.json", byteLength: 1, sha256: "a".repeat(64) },
    ],
    requires: [
      { service: "crewon.project-text-plans", apiVersion: "1", optional: true },
    ],
  });
  const state = {
    allowed: true,
    projectAllowed: true,
    issued: 0,
    invocation: null as PluginProjectTextPlanInvocationAuthority | null,
    context: null as PluginUiActionContext | null,
    raw: undefined as
      | Awaited<ReturnType<PluginUiActionPort["invoke"]>>
      | undefined,
    beforeIssue: null as null | (() => Promise<void>),
    afterAction: null as
      | null
      | ((context: PluginUiActionContext) => void | Promise<void>),
    onContext: null as null | ((context: PluginUiActionContext) => void),
    foreign: false,
  };
  const plans = new ProjectTextPlanApplicationService({
    plans: f.plans,
    conversations: f.store,
    projects: f.metadata,
    texts: f.text,
    extensions: f.first.store,
    authorization: {
      authorize: async () =>
        state.projectAllowed
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "named_project_denied" },
    },
    clock: f.dependencies.clock,
    ids: { nextId: () => randomUUID() },
    digester: f.digester,
  });
  const current = async () => {
    if (!state.allowed) throw new Error("named_plan_publication_withdrawn");
  };
  const authorization = {
    async issueRead(
      context: PluginUiActionContext,
      _request: unknown,
      invocation: PluginProjectTextPlanInvocationAuthority,
    ) {
      state.issued++;
      state.invocation = invocation;
      await state.beforeIssue?.();
      await current();
      return {
        ...f.authority,
        pin: { ...f.authority.pin, authorityEpoch: context.authorityEpoch },
        assertCurrent: current,
        assertTransactionCurrent: current,
      };
    },
    async issueCommit(
      _context: PluginUiActionContext,
      _request: unknown,
      invocation: PluginProjectTextPlanInvocationAuthority,
    ) {
      state.issued++;
      state.invocation = invocation;
      await state.beforeIssue?.();
      await current();
      return {
        ...f.planAuthority(invocation.delegation),
        backgroundAuthorization: "available" as const,
        ...(state.foreign
          ? { actor: { ...f.actor, actorId: "foreign-actor" } }
          : {}),
        assertCurrent: current,
        assertTransactionCurrent: current,
      };
    },
  };
  const publications = [
    {
      pluginId: f.installation.pluginId,
      packageDigest: f.installation.packageDigest,
      contributionId: "workbench",
    },
  ];
  const owner = new PluginProjectTextPlanActionOwner({
    plans,
    publications,
    authorization,
  });
  t.after(() => owner.close());
  const service = new PluginUiApplicationService({
    store: ui.store,
    profiles: { resolve: async () => ui.state.scope },
    authorization: {
      authorize: async (input) =>
        ui.state.allowed.has(input.action)
          ? { outcome: "allow", authorityEpoch: ui.state.epoch }
          : { outcome: "deny", reasonCode: "named_ui_denied" },
    },
    packages: {
      verify: async () => ({
        descriptor: ui.state.descriptor,
        publicAssets: ["ui.mjs"],
      }),
      readAsset: async () => ({
        bytes: uiTestBytes,
        contentType: "text/javascript; charset=utf-8",
      }),
    },
    ids: { nextId: () => "m".repeat(40) },
    clock: { now: () => ui.state.now },
    committedMetadata: owner.committedMetadata,
    actions: {
      invoke: async (context) => {
        state.context = context;
        state.onContext?.(context);
        const raw = await owner.actions.invoke(context);
        state.raw = raw;
        await state.afterAction?.(context);
        return raw;
      },
    },
  });
  const open = () =>
    service.openMount(f.actor, {
      pluginId: f.installation.pluginId,
      contributionId: "workbench",
      expectedSelectionRevision: f.installation.selectionRevision,
      expectedPackageDigest: f.installation.packageDigest,
    });
  const invoke = async <M extends ProjectTextPlansMethod>(
    method: M,
    input: ProjectTextPlansRequests[M],
  ) => {
    const lease = await open();
    return service.invoke(f.actor, {
      mountRef: lease.mountRef,
      action: PROJECT_TEXT_PLANS_METHOD_ACTIONS[method],
      input: input as never,
    });
  };
  const request = {
    projectId: f.binding.projectId,
    threadId: f.binding.threadId,
    expectedBindingRevision: f.binding.revision,
    idempotencyKey: "actual-plan-start",
    expectedBriefRevision: 1,
    instruction: "Draft a one-episode outline without generating media",
    start: "outline" as const,
    target: "outline" as const,
    episodes: { kind: "newOutline" as const, episodeCount: 1 },
    adoption: "manual" as const,
  };
  return {
    ...f,
    ui,
    state,
    plans,
    authorization,
    publications,
    owner,
    service,
    open,
    invoke,
    request,
  };
}
