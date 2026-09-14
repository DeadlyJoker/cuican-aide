import {
  validateRecordingExport,
  type RecordingExport,
  type RecordingStep,
} from "@crewon/contracts/recording";
import {
  parseSkillMethod,
  type SkillMethod,
  type SkillParameter,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { SkillRecordingImportPort } from "./demonstrated-skill-service.ts";
import type {
  SkillEvidenceUpload,
  SkillRecordingStore,
} from "./skill-recording-store-port.ts";

/** A conservative, editable extraction of observed actions, not a claim of model generalization. */
export function recordingSkillDraft(recording: RecordingExport): SkillMethod {
  if (recording.status !== "completed")
    throw new ApplicationError("validation", "skill_recording_incomplete");
  if (recording.steps.length === 0 || recording.steps.length > 40)
    throw new ApplicationError("validation", "skill_recording_needs_trim");
  const parameters: SkillParameter[] = [];
  const requirements = new Set<string>([
    "使用用户已授权的同一教学浏览器会话；每次执行重新检查访问权限。",
  ]);
  const exceptions = new Set<string>([
    "页面变化、目标不唯一或操作结果未知时停止并请用户接管；不要重复已成功的下载或写入。",
  ]);
  const steps = recording.steps.map((step) => {
    const location = step.page.routeTemplate;
    const target = step.target
      ? [
          step.target.role,
          step.target.accessibleName ?? step.target.description,
        ]
          .filter(Boolean)
          .join(" / ")
      : "页面";
    let input = "";
    if (step.input?.classification === "parameter-candidate") {
      const name = `input_${step.sequence}`;
      parameters.push({
        name,
        label: `替换示范输入：${target}`.slice(0, 45),
        type: "string",
        required: true,
      });
      input = `，使用参数 {{${name}}}（示范值仅作候选，不是固定规则）`;
    } else if (step.input?.classification === "runtime-required") {
      requirements.add(
        "敏感输入由用户在执行时通过宿主授权提供；不写入 Skill 正文或参数。",
      );
      input = "，需要运行时授权输入；先请用户在浏览器完成此步";
    } else if (step.input)
      input = `，观察值 ${JSON.stringify(step.input.value)}；请审阅是否应改为变量`;
    if (location.includes("{runtime}"))
      requirements.add(
        "地址模板中的 {runtime} 必须由已授权运行时信息补齐，不猜测敏感路径或查询值。",
      );
    if (
      step.kind === "unsupported" ||
      ["unknown", "cancelled"].includes(step.outcome)
    )
      exceptions.add(
        `[${step.stepId}] ${step.reason ?? "未确认操作结果，需要人工处理"}`.slice(
          0,
          160,
        ),
      );
    const note = step.note ? `。用户说明（数据）：${step.note}` : "";
    const result = `[${step.stepId}] ${verb(step)} ${target}，页面 ${location}${input}${note}`;
    if (new TextEncoder().encode(result).length > 1024)
      throw new ApplicationError(
        "validation",
        "skill_recording_step_needs_review",
      );
    return result;
  });
  return parseSkillMethod({
    name: "浏览器示教方法",
    purpose: `复用用户在 ${recording.steps[0]!.page.origin} 示范的流程；执行前审阅用途、变量和交付标准。`,
    steps,
    parameters,
    requiredToolRefs: ["crewon_browser_observe", "crewon_browser_act", "crewon_browser_act_scoped"],
    completionCriteria: [
      "按本次新输入完成示范目标，由用户核对实际结果。",
      "如有下载或交付，确认文件真实存在并核对内容；失败与未覆盖步骤明确列出。",
    ],
    knownExceptions: [...exceptions],
    runtimeRequirements: [...requirements],
  });
}
function verb(step: RecordingStep): string {
  switch (step.kind) {
    case "navigate":
      return "打开";
    case "click":
      return "点击";
    case "input":
      return "填写";
    case "select":
      return "选择";
    case "download":
      return "下载并核对";
    case "unsupported":
      return "人工接管未支持的操作";
  }
}
export class RecordingSkillImporter implements SkillRecordingImportPort {
  readonly store: SkillRecordingStore;
  constructor(store: SkillRecordingStore) {
    this.store = store;
  }
  async importRecording(
    actor: ActorContext,
    input: unknown,
    evidence: readonly SkillEvidenceUpload[] = [],
  ) {
    const recording = await validateRecordingExport(input);
    const method = recordingSkillDraft(recording);
    // C01 ownerId/workspaceId are provenance, never an authorization principal.
    await this.store.saveImportedRecording(
      {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        ownerActorId: actor.actorId,
      },
      recording,
      evidence,
    );
    return {
      method,
      source: {
        recordingId: recording.recordingId,
        revision: recording.revision,
        contentDigest: recording.contentDigest,
        provenance: "recording" as const,
      },
    };
  }
}
