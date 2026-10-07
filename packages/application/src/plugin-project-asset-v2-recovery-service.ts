import {
  PROJECT_ASSET_RECOVERY_V2_ACTIONS as actions,
  parseProjectAssetRecoveryV2Request,
  parseProjectAssetV2WriteRequest,
  parseProjectAssetRecoveryV2Response,
} from "@crewon/contracts/project-asset-recovery-v2";
import {
  parseProjectAssetUiIntentScope,
  projectAssetTimestamp,
} from "@crewon/domain";
import { capturePluginProjectAssetV2Invocation } from "./plugin-project-asset-v2-invocation.ts";
import {
  captureProjectTextPublications,
  type PluginProjectTextActionPublication,
} from "./plugin-project-text-action-owner.ts";
import {
  captureAssetV2RecoveryAuthority,
  type ProjectAssetV2RecoveryStore,
  type ProjectAssetV2RecoveryAuthority,
} from "./project-asset-v2-recovery-port.ts";
import {
  parseAssetV2RecoveryRecord,
  assetV2RecoverySame as same,
  assetV2RecoveryInvalid as fail,
} from "./project-asset-v2-recovery-record.ts";
import {
  projectAssetOwnFields,
  projectAssetBoundMethod,
} from "./project-asset-application-support.ts";
import {
  checkedCreativeProject,
  creativeOwner,
} from "./creative-project-application-support.ts";
import { ApplicationError } from "./application-error.ts";
import type { ProjectAssetCommitAuthority } from "./project-asset-commit-authority.ts";
import type { CreativeProjectAuthorizationPort } from "./creative-project-authorization-port.ts";
import type { CreativeProjectStore } from "./creative-project-store-port.ts";
import type { ApplicationClock } from "./application-runtime-ports.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
type Fence = Pick<
  ProjectAssetCommitAuthority,
  "assertCurrent" | "assertTransactionCurrent" | "assertActive"
>;
/** Scope comes only from the genuine invocation. Recovery authorizes the stored project, never the active UI project. */
export class PluginProjectAssetV2RecoveryService {
  readonly #journal: ProjectAssetV2RecoveryStore;
  readonly #load: CreativeProjectStore["loadProject"];
  readonly #authorize: CreativeProjectAuthorizationPort["authorize"];
  readonly #now: ApplicationClock["now"];
  readonly #publications: readonly PluginProjectTextActionPublication[];
  constructor(
    input: Readonly<{
      journal: ProjectAssetV2RecoveryStore;
      projects: Pick<CreativeProjectStore, "loadProject">;
      authorization: CreativeProjectAuthorizationPort;
      clock: ApplicationClock;
      publications: readonly PluginProjectTextActionPublication[];
    }>,
  ) {
    const v = projectAssetOwnFields(input, [
      "journal",
      "projects",
      "authorization",
      "clock",
      "publications",
    ]);
    this.#journal = Object.freeze({
      migrate: projectAssetBoundMethod<ProjectAssetV2RecoveryStore["migrate"]>(
        v.journal,
        "migrate",
      ),
      stage: projectAssetBoundMethod<ProjectAssetV2RecoveryStore["stage"]>(
        v.journal,
        "stage",
      ),
      getPending: projectAssetBoundMethod<
        ProjectAssetV2RecoveryStore["getPending"]
      >(v.journal, "getPending"),
      loadIntent: projectAssetBoundMethod<
        ProjectAssetV2RecoveryStore["loadIntent"]
      >(v.journal, "loadIntent"),
      cancelPending: projectAssetBoundMethod<
        ProjectAssetV2RecoveryStore["cancelPending"]
      >(v.journal, "cancelPending"),
      acknowledge: projectAssetBoundMethod<
        ProjectAssetV2RecoveryStore["acknowledge"]
      >(v.journal, "acknowledge"),
    });
    this.#load = projectAssetBoundMethod(v.projects, "loadProject");
    this.#authorize = projectAssetBoundMethod(v.authorization, "authorize");
    this.#now = projectAssetBoundMethod(v.clock, "now");
    this.#publications = captureProjectTextPublications(v.publications);
    Object.freeze(this);
  }
  async stage(context: PluginUiActionContext, fence: Fence) {
    const a = this.#authority(context, fence),
      q = parseProjectAssetV2WriteRequest(a.request),
      qualified = this.#policy(a, q.input.projectId, "creativeProject:write");
    await qualified.assertCurrent();
    await this.#owned(a, q.input.projectId);
    const record = this.#stored(
      await this.#journal.stage({ at: this.#at() }, qualified),
      a,
    );
    if (!same(record.intent.request, q)) fail();
    if (record.intent.phase === "cancelled")
      throw new ApplicationError(
        "conflict",
        "project_asset_v2_recovery_cancelled",
      );
    await qualified.assertCurrent();
    return record;
  }
  async invoke(context: PluginUiActionContext, fence: Fence) {
    const a = this.#authority(context, fence),
      q = parseProjectAssetRecoveryV2Request(a.request);
    await a.assertCurrent();
    if (q.action === actions.getPending) {
      const raw = await this.#journal.getPending(a);
      if (raw === null) {
        await a.assertCurrent();
        return parseProjectAssetRecoveryV2Response(q, { intent: null });
      }
      const record = this.#stored(raw, a);
      if (record.acknowledgedAt !== null) fail();
      await this.#policy(
        a,
        record.intent.request.input.projectId,
        "creativeProject:read",
      ).assertCurrent();
      await this.#owned(a, record.intent.request.input.projectId);
      await a.assertCurrent();
      return parseProjectAssetRecoveryV2Response(q, { intent: record.intent });
    }
    const raw = await this.#journal.loadIntent(a);
    if (raw === null)
      throw new ApplicationError(
        "notFound",
        "project_asset_v2_recovery_not_found",
      );
    const record = this.#stored(raw, a);
    if (record.intent.intentId !== q.input.intentId) fail();
    const qualified = this.#policy(
      a,
      record.intent.request.input.projectId,
      "creativeProject:write",
    );
    await qualified.assertCurrent();
    await this.#owned(a, record.intent.request.input.projectId);
    if (q.action === actions.cancelPending) {
      const next = this.#stored(
        await this.#journal.cancelPending({ at: this.#at() }, qualified),
        a,
      );
      if (!same(next.intent.request, record.intent.request)) fail();
      return parseProjectAssetRecoveryV2Response(q, { intent: next.intent });
    }
    const result = await this.#journal.acknowledge(
        { at: this.#at() },
        qualified,
      ),
      next = this.#stored(result.record, a);
    if (
      next.acknowledgedAt === null ||
      !same(next.intent.request, record.intent.request)
    )
      fail();
    return parseProjectAssetRecoveryV2Response(q, {
      intentId: next.intent.intentId,
      revision: next.intent.revision,
      disposition: result.disposition,
    });
  }
  #authority(context: PluginUiActionContext, fence: Fence) {
    const original = capturePluginProjectAssetV2Invocation(context),
      s = original.snapshot,
      d = s.context.lease.descriptor,
      c = d.contributions.find((x) => x.id === s.context.lease.contributionId);
    if (
      !this.#publications.some(
        (p) =>
          p.pluginId === d.pluginId &&
          p.packageDigest === s.context.package.packageDigest &&
          p.contributionId === c?.id,
      ) ||
      c?.kind !== "module" ||
      c.slot !== "main.content" ||
      !d.requires.some(
        (r) =>
          r.service === "crewon.project-asset-recovery" &&
          r.apiVersion === "2" &&
          (!r.optional ||
            (d.entrypoints.node !== null && d.businessManifestPath !== null)),
      )
    )
      throw new ApplicationError(
        "authorization",
        "plugin_project_asset_v2_recovery_unavailable",
      );
    const active = () => {
      original.assertActive();
      fence.assertActive();
    };
    const check = async (phase: "current" | "transaction") => {
      active();
      if (phase === "current") {
        await original.assertCurrent();
        await fence.assertCurrent();
      } else {
        await original.assertTransactionCurrent();
        await fence.assertTransactionCurrent();
      }
      active();
    };
    return captureAssetV2RecoveryAuthority({
      version: "crewon.project-asset-v2-recovery-authority.v1",
      scope: parseProjectAssetUiIntentScope({
        actor: s.context.actor,
        installation: s.installation,
        contributionId: c.id,
      }),
      selection: s.context.selection,
      package: s.context.package,
      request: s.request,
      assertActive: active,
      assertCurrent: () => check("current"),
      assertTransactionCurrent: () => check("transaction"),
    });
  }
  #stored(raw: unknown, a: ProjectAssetV2RecoveryAuthority) {
    const r = parseAssetV2RecoveryRecord(raw);
    if (!same(r.scope, a.scope)) fail();
    return r;
  }
  #policy(
    a: ProjectAssetV2RecoveryAuthority,
    projectId: string,
    action: "creativeProject:read" | "creativeProject:write",
  ): ProjectAssetV2RecoveryAuthority {
    const check = async (current: () => Promise<void>) => {
      a.assertActive();
      const decision = await this.#authorize({
        actor: a.scope.actor,
        action,
        resource: {
          kind: "creativeProject",
          tenantId: a.scope.actor.tenantId,
          spaceId: a.scope.actor.spaceId,
          projectId,
        },
      });
      if (projectAssetOwnFields(decision, ["outcome"]).outcome !== "allow")
        throw new ApplicationError(
          "authorization",
          "creative_project_authorization_denied",
        );
      await current();
      a.assertActive();
    };
    return Object.freeze({
      ...a,
      assertCurrent: () => check(a.assertCurrent),
      assertTransactionCurrent: () => check(a.assertTransactionCurrent),
    });
  }
  async #owned(a: ProjectAssetV2RecoveryAuthority, projectId: string) {
    const owner = creativeOwner(a.scope.actor),
      project = await this.#load({ owner, projectId });
    if (!project)
      throw new ApplicationError("notFound", "creative_project_not_found");
    checkedCreativeProject(project, owner, projectId);
  }
  #at() {
    return projectAssetTimestamp(this.#now());
  }
}
