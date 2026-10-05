import { parsePluginUiJsonValue, pluginUiFields } from "./plugin-ui-json.ts";
import {
  parseProjectTextId,
  parseProjectTextIdempotencyKey,
} from "./project-text-control-contract.ts";
import {
  MAX_PROJECT_TEXT_PLANS_INPUT_BYTES,
  MAX_PROJECT_TEXT_PLANS_VIEW_BYTES,
  MAX_PROJECT_TEXT_PLAN_INSTRUCTION_BYTES,
  PROJECT_TEXT_PLANS_METHOD_ACTIONS,
  type ProjectTextPlansAction,
  type ProjectTextPlansActionRequest,
  type ProjectTextPlansCodec,
  type ProjectTextPlansResponseMap,
  type PublicProjectTextPlanStage,
  type PublicProjectTextPlanEpisodeSelection,
  type PublicProjectTextPlanSummary,
  type PublicProjectTextPlanDefinition,
  type PublicProjectTextPlanSources,
  type PublicProjectTextPlanResult,
  type PublicProjectTextPlanSelection,
  type PublicProjectTextPlanStep,
  type PublicProjectTextPlanView,
} from "./plugin-project-text-plans-service.ts";

export class PluginProjectTextPlansContractError extends Error {
  constructor() {
    super("plugin_project_text_plans_invalid");
  }
}
function fail(): never {
  throw new PluginProjectTextPlansContractError();
}
function checked<T>(read: () => T): T {
  try {
    return read();
  } catch {
    return fail();
  }
}
function integer(v: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  return typeof v === "number" &&
    Number.isSafeInteger(v) &&
    v >= min &&
    v <= max
    ? v
    : fail();
}
function oneOf<T extends string>(v: unknown, values: readonly T[]): T {
  return typeof v === "string" && values.includes(v as T) ? (v as T) : fail();
}
function digest(v: unknown): string {
  return typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v) ? v : fail();
}
function timestamp(v: unknown): string {
  return typeof v === "string" &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString() === v
    ? v
    : fail();
}
const stages = ["brief", "outline", "script"] as const;
const adoptionModes = ["manual", "whenUnchanged"] as const;
function stage(v: unknown): PublicProjectTextPlanStage {
  return oneOf(v, stages);
}
function instruction(v: unknown): string {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v) ||
    new TextEncoder().encode(v).byteLength >
      MAX_PROJECT_TEXT_PLAN_INSTRUCTION_BYTES
  )
    fail();
  return v;
}
function episodeIds(v: unknown, allowEmpty = false): readonly string[] {
  if (!Array.isArray(v) || v.length < (allowEmpty ? 0 : 1) || v.length > 16)
    fail();
  const ids = v.map(parseProjectTextId);
  if (new Set(ids).size !== ids.length) fail();
  return Object.freeze(ids);
}
function episodes(v: unknown): PublicProjectTextPlanEpisodeSelection | null {
  if (v === null) return null;
  const kind = (v as Record<string, unknown>).kind;
  if (kind === "newOutline") {
    const r = pluginUiFields(v, ["kind", "episodeCount"]);
    return Object.freeze({
      kind,
      episodeCount: integer(r.episodeCount, 1, 16),
    });
  }
  if (kind === "selectedOutline" || kind === "independentScripts") {
    const r = pluginUiFields(v, ["kind", "episodeIds"]);
    return Object.freeze({ kind, episodeIds: episodeIds(r.episodeIds) });
  }
  return fail();
}
function assertDefinitionShape(
  start: PublicProjectTextPlanStage,
  target: PublicProjectTextPlanStage,
  mode: string,
): void {
  if (stages.indexOf(start) > stages.indexOf(target)) fail();
  if (
    target === "brief"
      ? mode !== "none"
      : start === "script"
        ? mode !== "selectedOutline" && mode !== "independentScripts"
        : mode !== "newOutline"
  )
    fail();
}
export function parseProjectTextPlansActionRequest(
  input: unknown,
): ProjectTextPlansActionRequest {
  return checked(() => {
    const v = pluginUiFields(
      parsePluginUiJsonValue(input, {
        maxBytes: MAX_PROJECT_TEXT_PLANS_INPUT_BYTES,
      }),
      ["action", "input"],
    );
    const action = oneOf(
      v.action,
      Object.values(PROJECT_TEXT_PLANS_METHOD_ACTIONS),
    );
    const method = action.slice("crewon.project-text-plans.v1.".length);
    const definitionFields = [
      "expectedBriefRevision",
      "instruction",
      "start",
      "target",
      "episodes",
      "adoption",
    ];
    const controlFields = [
      "projectId",
      "planId",
      "expectedRevision",
      "idempotencyKey",
    ];
    const fields =
      method === "start"
        ? [
            "projectId",
            "threadId",
            "expectedBindingRevision",
            "idempotencyKey",
            ...definitionFields,
          ]
        : method === "get"
          ? ["projectId", "planId"]
          : method === "list"
            ? ["projectId", "afterPlanId", "limit"]
            : method === "reviseRemaining"
              ? [...controlFields, ...definitionFields]
              : controlFields;
    const r = pluginUiFields(v.input, fields);
    const out: Record<string, unknown> = {};
    for (const key of fields) {
      switch (key) {
        case "projectId":
        case "planId":
        case "threadId":
          out[key] = parseProjectTextId(r[key]);
          break;
        case "afterPlanId":
          out[key] = r[key] === null ? null : parseProjectTextId(r[key]);
          break;
        case "idempotencyKey":
          out[key] = parseProjectTextIdempotencyKey(r[key]);
          break;
        case "expectedRevision":
        case "expectedBindingRevision":
        case "expectedBriefRevision":
          out[key] = integer(r[key]);
          break;
        case "limit":
          out[key] = integer(r[key], 1, 16);
          break;
        case "instruction":
          out[key] = instruction(r[key]);
          break;
        case "start":
        case "target":
          out[key] = stage(r[key]);
          break;
        case "episodes":
          out[key] = episodes(r[key]);
          break;
        case "adoption":
          out[key] = oneOf(r[key], adoptionModes);
          break;
        default:
          fail();
      }
    }
    if (method === "start" || method === "reviseRemaining") {
      const e = out.episodes as PublicProjectTextPlanEpisodeSelection | null;
      assertDefinitionShape(
        out.start as PublicProjectTextPlanStage,
        out.target as PublicProjectTextPlanStage,
        e?.kind ?? "none",
      );
    }
    return Object.freeze({
      action,
      input: Object.freeze(out),
    }) as ProjectTextPlansActionRequest;
  });
}
const pauseReasons = [
  "source_changed",
  "selection_changed",
  "locked",
  "binding_changed",
  "installation_changed",
  "authorization_unavailable",
  "run_failed",
  "run_canceled",
  "result_missing",
  "result_invalid",
  "user_paused",
] as const;
function summary(input: unknown): PublicProjectTextPlanSummary {
  const r = pluginUiFields(input, [
    "planId",
    "projectId",
    "threadId",
    "revision",
    "currentPlanRevision",
    "state",
    "activeStepId",
    "pauseReason",
    "createdAt",
    "updatedAt",
  ]);
  const revision = integer(r.revision),
    currentPlanRevision = integer(r.currentPlanRevision);
  const state = oneOf(r.state, [
    "ready",
    "running",
    "waitingSelection",
    "paused",
    "completed",
    "revoked",
  ] as const);
  const pauseReason =
    r.pauseReason === null ? null : oneOf(r.pauseReason, pauseReasons);
  const createdAt = timestamp(r.createdAt),
    updatedAt = timestamp(r.updatedAt);
  if (
    currentPlanRevision > revision ||
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    (state === "paused" && pauseReason === null) ||
    (state !== "paused" && pauseReason !== null) ||
    ((state === "running" || state === "waitingSelection") &&
      r.activeStepId === null) ||
    (state === "completed" && r.activeStepId !== null)
  )
    fail();
  return Object.freeze({
    planId: parseProjectTextId(r.planId),
    projectId: parseProjectTextId(r.projectId),
    threadId: parseProjectTextId(r.threadId),
    revision,
    currentPlanRevision,
    state,
    activeStepId:
      r.activeStepId === null ? null : parseProjectTextId(r.activeStepId),
    pauseReason,
    createdAt,
    updatedAt,
  });
}
function sources(input: unknown): PublicProjectTextPlanSources {
  const r = pluginUiFields(input, ["brief", "outline"]);
  const b = pluginUiFields(r.brief, ["briefRevision", "contentDigest"]);
  const o =
    r.outline === null
      ? null
      : pluginUiFields(r.outline, [
          "artifactId",
          "contentRevision",
          "contentDigest",
        ]);
  return Object.freeze({
    brief: Object.freeze({
      briefRevision: integer(b.briefRevision),
      contentDigest: digest(b.contentDigest),
    }),
    outline:
      o === null
        ? null
        : Object.freeze({
            artifactId: parseProjectTextId(o.artifactId),
            contentRevision: integer(o.contentRevision),
            contentDigest: digest(o.contentDigest),
          }),
  });
}
function definition(input: unknown): PublicProjectTextPlanDefinition {
  const r = pluginUiFields(input, [
    "planId",
    "planRevision",
    "start",
    "target",
    "episodeMode",
    "episodeIds",
    "adoption",
    "instruction",
    "sources",
  ]);
  const start = stage(r.start),
    target = stage(r.target);
  const episodeMode = oneOf(r.episodeMode, [
    "none",
    "newOutline",
    "selectedOutline",
    "independentScripts",
  ] as const);
  assertDefinitionShape(start, target, episodeMode);
  const ids = episodeIds(r.episodeIds, episodeMode === "none");
  if (episodeMode === "none" && ids.length !== 0) fail();
  const source = sources(r.sources);
  if (
    episodeMode === "selectedOutline"
      ? source.outline === null
      : source.outline !== null
  )
    fail();
  return Object.freeze({
    planId: parseProjectTextId(r.planId),
    planRevision: integer(r.planRevision),
    start,
    target,
    episodeMode,
    episodeIds: ids,
    adoption: oneOf(r.adoption, adoptionModes),
    instruction: instruction(r.instruction),
    sources: source,
  });
}
function result(input: unknown): PublicProjectTextPlanResult {
  const r = pluginUiFields(input, [
    "kind",
    "briefRevision",
    "artifactId",
    "artifactRevision",
    "contentRevision",
    "contentDigest",
  ]);
  const kind = stage(r.kind);
  const briefRevision =
    r.briefRevision === null ? null : integer(r.briefRevision);
  const artifactId =
    r.artifactId === null ? null : parseProjectTextId(r.artifactId);
  const artifactRevision =
    r.artifactRevision === null ? null : integer(r.artifactRevision);
  const contentRevision =
    r.contentRevision === null ? null : integer(r.contentRevision);
  if (
    kind === "brief"
      ? briefRevision === null ||
        artifactId !== null ||
        artifactRevision !== null ||
        contentRevision !== null
      : briefRevision !== null ||
        artifactId === null ||
        artifactRevision === null ||
        contentRevision === null ||
        contentRevision > artifactRevision
  )
    fail();
  return Object.freeze({
    kind,
    briefRevision,
    artifactId,
    artifactRevision,
    contentRevision,
    contentDigest: digest(r.contentDigest),
  });
}
function selection(input: unknown): PublicProjectTextPlanSelection {
  const r = pluginUiFields(input, [
    "mode",
    "artifactId",
    "artifactRevision",
    "contentRevision",
    "contentDigest",
  ]);
  const artifactRevision = integer(r.artifactRevision),
    contentRevision = integer(r.contentRevision);
  if (contentRevision > artifactRevision) fail();
  return Object.freeze({
    mode: oneOf(r.mode, adoptionModes),
    artifactId: parseProjectTextId(r.artifactId),
    artifactRevision,
    contentRevision,
    contentDigest: digest(r.contentDigest),
  });
}
function step(input: unknown): PublicProjectTextPlanStep {
  const r = pluginUiFields(input, [
    "stepId",
    "ordinal",
    "kind",
    "episodeId",
    "attempt",
    "revision",
    "state",
    "sources",
    "run",
    "result",
    "selection",
    "terminal",
  ]);
  const kind = stage(r.kind),
    episodeId = r.episodeId === null ? null : parseProjectTextId(r.episodeId);
  if (kind === "script" ? episodeId === null : episodeId !== null) fail();
  const state = oneOf(r.state, [
    "ready",
    "admitted",
    "waitingSelection",
    "succeeded",
    "paused",
    "failed",
    "revoked",
  ] as const);
  const sr = r.sources === null ? null : sources(r.sources);
  if (kind !== "script" && sr?.outline !== null && sr?.outline !== undefined)
    fail();
  const runValue =
    r.run === null
      ? null
      : pluginUiFields(r.run, ["runId", "stageAdmissionDigest"]);
  const run =
    runValue === null
      ? null
      : Object.freeze({
          runId: parseProjectTextId(runValue.runId),
          stageAdmissionDigest: digest(runValue.stageAdmissionDigest),
        });
  const outcome = r.result === null ? null : result(r.result);
  const selected = r.selection === null ? null : selection(r.selection);
  const t =
    r.terminal === null
      ? null
      : pluginUiFields(r.terminal, [
          "status",
          "runRevision",
          "throughSequence",
        ]);
  const terminal =
    t === null
      ? null
      : Object.freeze({
          status: oneOf(t.status, ["completed", "failed", "canceled"] as const),
          runRevision: integer(t.runRevision),
          throughSequence: integer(t.throughSequence),
        });
  if (
    (run !== null && sr === null) ||
    ((outcome !== null || terminal !== null || state === "admitted") &&
      run === null) ||
    (outcome !== null && outcome.kind !== kind)
  )
    fail();
  if (
    selected !== null &&
    (outcome === null ||
      kind === "brief" ||
      selected.artifactId !== outcome.artifactId ||
      selected.contentRevision !== outcome.contentRevision ||
      selected.contentDigest !== outcome.contentDigest)
  )
    fail();
  if (
    state === "waitingSelection" &&
    (kind === "brief" || terminal?.status !== "completed" || outcome === null)
  )
    fail();
  if (
    state === "succeeded" &&
    (terminal?.status !== "completed" ||
      outcome === null ||
      (kind !== "brief" && selected === null))
  )
    fail();
  return Object.freeze({
    stepId: parseProjectTextId(r.stepId),
    ordinal: integer(r.ordinal, 1, 18),
    kind,
    episodeId,
    attempt: integer(r.attempt),
    revision: integer(r.revision),
    state,
    sources: sr,
    run,
    result: outcome,
    selection: selected,
    terminal,
  });
}
function view(input: unknown): PublicProjectTextPlanView {
  const r = pluginUiFields(input, ["plan", "definition", "steps"]);
  const plan = summary(r.plan),
    d = definition(r.definition);
  if (
    plan.planId !== d.planId ||
    plan.currentPlanRevision !== d.planRevision ||
    !Array.isArray(r.steps) ||
    r.steps.length < 1 ||
    r.steps.length > 18
  )
    fail();
  const steps = r.steps.map(step);
  if (
    new Set(steps.map((s) => s.stepId)).size !== steps.length ||
    steps.some((s, i) => i > 0 && s.ordinal <= steps[i - 1]!.ordinal) ||
    steps.filter((s) => s.state === "admitted").length > 1 ||
    (plan.activeStepId !== null &&
      !steps.some((s) => s.stepId === plan.activeStepId))
  )
    fail();
  for (const s of steps) {
    if (
      stages.indexOf(s.kind) < stages.indexOf(d.start) ||
      stages.indexOf(s.kind) > stages.indexOf(d.target) ||
      (s.kind === "script" && !d.episodeIds.includes(s.episodeId!))
    )
      fail();
    if (
      s.kind === "script" &&
      s.sources !== null &&
      (d.episodeMode === "independentScripts"
        ? s.sources.outline !== null
        : s.sources.outline === null)
    )
      fail();
    if (s.selection !== null && s.selection.mode !== d.adoption) fail();
  }
  if (plan.state === "completed" && steps.some((s) => s.state !== "succeeded"))
    fail();
  return Object.freeze({ plan, definition: d, steps: Object.freeze(steps) });
}
function compareIds(a: string, b: string): number {
  const x = new TextEncoder().encode(a),
    y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++)
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}
export function parseProjectTextPlansActionResponse(
  requestInput: ProjectTextPlansActionRequest,
  input: unknown,
): ProjectTextPlansResponseMap[ProjectTextPlansAction] {
  return checked(() => {
    const request = parseProjectTextPlansActionRequest(requestInput);
    const method = request.action.slice("crewon.project-text-plans.v1.".length);
    const value = parsePluginUiJsonValue(input, {
      maxBytes:
        method === "list"
          ? MAX_PROJECT_TEXT_PLANS_INPUT_BYTES
          : MAX_PROJECT_TEXT_PLANS_VIEW_BYTES,
    });
    if (request.action === PROJECT_TEXT_PLANS_METHOD_ACTIONS.list) {
      const r = pluginUiFields(value, ["plans", "nextPlanId"]);
      if (!Array.isArray(r.plans) || r.plans.length > request.input.limit)
        fail();
      const plans = r.plans.map(summary);
      if (
        plans.some(
          (p, i) =>
            p.projectId !== request.input.projectId ||
            (i > 0 && compareIds(plans[i - 1]!.planId, p.planId) >= 0) ||
            (request.input.afterPlanId !== null &&
              compareIds(request.input.afterPlanId, p.planId) >= 0),
        )
      )
        fail();
      const nextPlanId =
        r.nextPlanId === null ? null : parseProjectTextId(r.nextPlanId);
      if (
        nextPlanId !== null &&
        (plans.length === 0 || nextPlanId !== plans.at(-1)!.planId)
      )
        fail();
      return Object.freeze({ plans: Object.freeze(plans), nextPlanId });
    }
    if (request.action === PROJECT_TEXT_PLANS_METHOD_ACTIONS.get) {
      const r = pluginUiFields(value, ["view"]);
      const found = r.view === null ? null : view(r.view);
      if (
        found !== null &&
        (found.plan.projectId !== request.input.projectId ||
          found.plan.planId !== request.input.planId)
      )
        fail();
      return Object.freeze({ view: found });
    }
    const r = pluginUiFields(value, ["disposition", "view"]);
    const disposition = oneOf(r.disposition, [
        "committed",
        "replayed",
      ] as const),
      found = view(r.view);
    if (found.plan.projectId !== request.input.projectId) fail();
    if (request.action === PROJECT_TEXT_PLANS_METHOD_ACTIONS.start) {
      const d = found.definition,
        e = request.input.episodes;
      if (
        found.plan.threadId !== request.input.threadId ||
        d.start !== request.input.start ||
        d.target !== request.input.target ||
        d.adoption !== request.input.adoption ||
        d.instruction !== request.input.instruction ||
        d.sources.brief.briefRevision !== request.input.expectedBriefRevision ||
        d.episodeMode !== (e?.kind ?? "none")
      )
        fail();
      if (
        e?.kind === "newOutline"
          ? d.episodeIds.length !== e.episodeCount
          : e !== null && d.episodeIds.join("\0") !== e.episodeIds.join("\0")
      )
        fail();
    } else {
      if (
        found.plan.planId !== request.input.planId ||
        found.plan.revision !== request.input.expectedRevision + 1
      )
        fail();
      if (
        request.action === PROJECT_TEXT_PLANS_METHOD_ACTIONS.reviseRemaining
      ) {
        const d = found.definition,
          e = request.input.episodes;
        if (
          d.start !== request.input.start ||
          d.target !== request.input.target ||
          d.adoption !== request.input.adoption ||
          d.instruction !== request.input.instruction ||
          d.sources.brief.briefRevision !==
            request.input.expectedBriefRevision ||
          d.episodeMode !== (e?.kind ?? "none")
        )
          fail();
        if (
          e?.kind === "newOutline"
            ? d.episodeIds.length !== e.episodeCount
            : e !== null && d.episodeIds.join("\0") !== e.episodeIds.join("\0")
        )
          fail();
      }
    }
    return Object.freeze({ disposition, view: found });
  });
}
export const projectTextPlansCodec: ProjectTextPlansCodec = Object.freeze({
  parseRequest: parseProjectTextPlansActionRequest,
  parseResponse: parseProjectTextPlansActionResponse,
});
