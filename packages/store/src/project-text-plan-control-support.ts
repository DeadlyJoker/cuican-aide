import {
  applyProjectTextPlanControl,
  parseExtensionConfiguration,
  parseExtensionActivation,
  parseProjectTextArtifact,
  parseProjectTextArtifactRevision,
  extensionCanonicalJson,
  type ProjectTextPlan,
  type ProjectTextPlanRevision,
  type ProjectTextPlanStep,
} from "@crewon/domain";
import {
  creativeStoreDigester,
  decodeCreativeProject,
  decodeCreativeBrief,
} from "./creative-project-store-records.ts";
import { decodeConversation } from "./project-conversation-store-support.ts";
import {
  capturePlanControl,
  planEqual,
  planJson,
  planStoreFail,
} from "./project-text-plan-records.ts";

export type PlanControlPrepared = ReturnType<typeof capturePlanControl>;
export function planControlQueries(p: PlanControlPrepared) {
  const r = p.revision,
    scope = [r.actor.tenantId, r.actor.spaceId, r.projectId];
  return {
    binding: {
      sql: "SELECT * FROM project_conversation_bindings WHERE tenant_id=? AND space_id=? AND binding_id=?",
      values: [r.actor.tenantId, r.actor.spaceId, r.bindingId],
    },
    project: {
      sql: "SELECT * FROM creative_projects WHERE tenant_id=? AND space_id=? AND project_id=?",
      values: scope,
    },
    configuration: {
      sql: "SELECT configuration_json FROM extension_configurations WHERE tenant_id=? AND space_id=? AND plugin_id=? ORDER BY revision DESC LIMIT 1",
      values: [r.actor.tenantId, r.actor.spaceId, r.installation.pluginId],
    },
    activation: {
      sql: "SELECT activation_json FROM extension_activations WHERE tenant_id=? AND space_id=? AND plugin_id=?",
      values: [r.actor.tenantId, r.actor.spaceId, r.installation.pluginId],
    },
    brief:
      r.sources.brief === null
        ? null
        : {
            sql: "SELECT b.*,p.owner_principal_id FROM creative_project_briefs b JOIN creative_projects p ON p.tenant_id=b.tenant_id AND p.space_id=b.space_id AND p.project_id=b.project_id WHERE b.tenant_id=? AND b.space_id=? AND b.project_id=? AND b.brief_revision=?",
            values: [...scope, r.sources.brief.briefRevision],
          },
    outline:
      r.sources.outline === null
        ? null
        : {
            sql: "SELECT h.record_json AS head_json,c.record_json AS revision_json FROM project_text_artifacts h JOIN project_text_revisions c ON c.tenant_id=h.tenant_id AND c.space_id=h.space_id AND c.project_id=h.project_id AND c.artifact_id=h.artifact_id WHERE h.tenant_id=? AND h.space_id=? AND h.project_id=? AND h.artifact_id=? AND c.content_revision=?",
            values: [
              ...scope,
              r.sources.outline.artifactId,
              r.sources.outline.contentRevision,
            ],
          },
    heads: {
      sql: `SELECT * FROM project_text_artifacts WHERE tenant_id=? AND space_id=? AND project_id=? AND (kind='outline' OR (kind='script' AND episode_id IN (${r.episodeIds.map(() => "?").join(",") || "NULL"}))) ORDER BY kind,episode_id LIMIT 18`,
      values: [...scope, ...r.episodeIds],
    },
  };
}
export type PlanControlRows = {
  binding: Record<string, unknown> | undefined;
  project: Record<string, unknown> | undefined;
  configuration: Record<string, unknown> | undefined;
  activation: Record<string, unknown> | undefined;
  brief: Record<string, unknown> | undefined;
  outline: Record<string, unknown> | undefined;
  heads: readonly Record<string, unknown>[];
};
export function checkPlanControlRows(
  p: PlanControlPrepared,
  rows: PlanControlRows,
  newRevision: boolean,
): void {
  const r = p.revision,
    b = decodeConversation(rows.binding),
    project = decodeCreativeProject(rows.project, r.actor, r.projectId);
  if (
    b === null ||
    b.state !== "active" ||
    project === null ||
    project.state !== "active"
  )
    planStoreFail("project_text_plan_binding_changed");
  planEqual(b, p.q.binding, "project_text_plan_binding_changed");
  if (!newRevision) return;
  const cfg = parseExtensionConfiguration(
      planJson(rows.configuration?.configuration_json) as Parameters<
        typeof parseExtensionConfiguration
      >[0],
      creativeStoreDigester,
    ),
    activation = parseExtensionActivation(
      planJson(rows.activation?.activation_json) as Parameters<
        typeof parseExtensionActivation
      >[0],
    );
  if (
    cfg.tenantId !== r.actor.tenantId ||
    cfg.spaceId !== r.actor.spaceId ||
    cfg.pluginId !== r.installation.pluginId ||
    cfg.revision !== r.configurationRevision ||
    cfg.contentDigest !== r.configurationDigest ||
    cfg.pluginVersion !== r.installation.version ||
    activation.state !== "enabled" ||
    activation.configurationRevision !== cfg.revision ||
    activation.configurationDigest !== cfg.contentDigest
  )
    planStoreFail("project_text_plan_configuration_changed");
  planEqual(
    activation.target,
    r.target,
    "project_text_plan_configuration_changed",
  );
  if (r.sources.brief !== null) {
    const brief = decodeCreativeBrief(rows.brief, r.actor, r.projectId);
    if (
      brief === null ||
      project.latestBriefRevision !== brief.briefRevision ||
      brief.contentDigest !== r.sources.brief.contentDigest
    )
      planStoreFail("project_text_plan_source_changed");
  }
  if (r.sources.outline !== null) {
    if (rows.outline === undefined)
      planStoreFail("project_text_plan_source_changed");
    const h = parseProjectTextArtifact(planJson(rows.outline.head_json)),
      v = parseProjectTextArtifactRevision(
        planJson(rows.outline.revision_json),
        creativeStoreDigester,
      );
    if (
      h.kind !== "outline" ||
      h.projectId !== r.projectId ||
      h.ownerPrincipalId !== r.actor.principalId ||
      h.artifactId !== r.sources.outline.artifactId ||
      h.selectedContentRevision !== r.sources.outline.contentRevision ||
      v.kind !== "outline" ||
      v.contentDigest !== r.sources.outline.contentDigest ||
      v.contentRevision !== r.sources.outline.contentRevision ||
      v.artifactId !== h.artifactId
    )
      planStoreFail("project_text_plan_source_changed");
    if (
      r.start === "script" &&
      r.episodeIds.some(
        (id) => !v.content.episodes.some((e) => e.episodeId === id),
      )
    )
      planStoreFail("project_text_plan_source_changed");
  }
  const heads = rows.heads.map((h) =>
    parseProjectTextArtifact(planJson(h.record_json)),
  );
  if (
    heads.some(
      (h) =>
        h.tenantId !== r.actor.tenantId ||
        h.spaceId !== r.actor.spaceId ||
        h.projectId !== r.projectId ||
        h.ownerPrincipalId !== r.actor.principalId,
    )
  )
    planStoreFail();
  for (const baseline of r.baselines) {
    const h = heads.find(
      (h) => h.kind === baseline.kind && h.episodeId === baseline.episodeId,
    );
    planEqual(
      baseline,
      {
        kind: baseline.kind,
        episodeId: baseline.episodeId,
        artifactId: h?.artifactId ?? null,
        artifactRevision: h?.revision ?? 0,
        selectedContentRevision: h?.selectedContentRevision ?? null,
        locked: h?.locked ?? false,
      },
      "project_text_plan_selection_changed",
    );
  }
  const required = [
    ...(r.start !== "script" && r.targetStage !== "brief"
      ? [{ kind: "outline", episodeId: null }]
      : []),
    ...(r.targetStage === "script"
      ? r.episodeIds.map((episodeId) => ({ kind: "script", episodeId }))
      : []),
  ];
  if (
    required.length !== r.baselines.length ||
    required.some(
      (x) =>
        !r.baselines.some(
          (b) => b.kind === x.kind && b.episodeId === x.episodeId,
        ),
    )
  )
    planStoreFail();
}
export function verifyPlanControl(
  p: PlanControlPrepared,
  previous: ProjectTextPlan | null,
  revision: ProjectTextPlanRevision | null,
  steps: readonly ProjectTextPlanStep[],
): void {
  if ((previous?.revision ?? 0) !== p.expected)
    planStoreFail("project_text_plan_revision_conflict");
  const actual = applyProjectTextPlanControl(
    {
      kind: p.kind,
      authorizationUnavailable: p.q.backgroundAuthorization === "unavailable",
      previous,
      previousRevision: revision,
      previousSteps: steps,
      definition: p.revision,
      stepIds: p.steps.map((s) => s.stepId),
      at: p.plan.updatedAt,
    },
    creativeStoreDigester,
  );
  planEqual(actual.plan, p.plan, "project_text_plan_recipe_invalid");
  if (actual.steps.length !== p.steps.length)
    planStoreFail("project_text_plan_recipe_invalid");
  actual.steps.forEach((step, index) =>
    planEqual(step, p.steps[index], "project_text_plan_recipe_invalid"),
  );
}
