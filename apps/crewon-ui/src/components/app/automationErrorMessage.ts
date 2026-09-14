import {
  ControlApiClientError,
  ControlApiProtocolError,
} from "@crewon/control-client";

const unknownOutcomeMessage =
  "执行结果暂未确认。请恢复连接后刷新日程并查看绑定对话，确认运行历史后再操作。";

const skillErrors: Readonly<Record<string, string>> = {
  automation_skill_unavailable:
    "Skill 服务暂时不可用。请恢复连接后重试，原日程配置仍保留。",
  skill_not_found:
    "找不到绑定的 Skill 版本。请返回 Skill 重新选择可用版本，再添加到日程。",
  skill_not_active:
    "绑定的 Skill 版本尚未激活或已停用。请在 Skill 中激活该版本后重试。",
  skill_access_denied: "当前账号已无权执行这个 Skill。请恢复访问权限后重试。",
  skill_digest_mismatch:
    "Skill 版本校验未通过。请返回 Skill 重新确认固定版本，再添加到日程。",
  skill_parameters_invalid:
    "Skill 参数不符合版本要求。请检查参数；需要更改字段或可选值时，请返回 Skill 重新填写。",
  skill_dependency_unavailable:
    "Skill 所需工具或连接不可用。请恢复依赖和工具授权后重试。",
  skill_delivery_target_denied:
    "无法访问交付目标。请恢复该对话的权限，或返回 Skill 重新选择交付目标。",
  skill_budget_exceeded:
    "执行预算或额度不足。请检查可用预算，恢复后重试。",
  skill_context_too_large:
    "Skill 参数或内容超过执行限制。请缩短参数内容，或返回 Skill 减少步骤后重试。",
  automation_delivery_target_mismatch:
    "交付目标与日程对话不一致。请返回 Skill 选择当前对话的交付目标，再添加到日程。",
  automation_skill_snapshot_mismatch:
    "这次执行的版本快照与日程不一致。请刷新日程并检查运行历史，再重新执行。",
  automation_parameter_bindings_invalid:
    "日期参数绑定无效。请检查参数的取值方式后重试。",
};

export function automationErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (error instanceof Error && error.message === "请选择未来的执行时间")
    return error.message;
  if (
    error instanceof ControlApiProtocolError &&
    error.code === "control_automation_create_intent_invalid"
  )
    return "Skill 参数或日期绑定无效。请检查参数和交付目标后重试。";
  if (error instanceof TypeError || error instanceof ControlApiProtocolError)
    return unknownOutcomeMessage;
  if (!(error instanceof ControlApiClientError)) return fallback;
  const skillMessage = knownSkillError(error.code);
  if (skillMessage) return skillMessage;
  if (error.category === "unknownOutcome") return unknownOutcomeMessage;
  return fallback;
}

export function skillScheduleRecoveryMessage(code: string | null): string {
  return (
    (code === null ? undefined : knownSkillError(code)) ??
    "请检查 Skill 版本、参数、工具连接和交付权限，恢复后可手动重试。"
  );
}

function knownSkillError(code: string): string | undefined {
  const parameterErrors = [
    "skill_parameter_name_invalid",
    "skill_parameter_type_invalid",
    "skill_parameter_unknown",
    "skill_parameter_required",
    "skill_parameter_enum_invalid",
    "automation_skill_binding_invalid",
  ];
  const sizeErrors = [
    "skill_parameter_too_large",
    "skill_parameters_too_large",
    "skill_method_too_large",
    "skill_context_too_large",
  ];
  const dependencyErrors = [
    "skill_tool_refs_mismatch",
    "skill_tool_refs_invalid",
  ];
  const canonical = parameterErrors.includes(code)
    ? "skill_parameters_invalid"
    : sizeErrors.includes(code)
      ? "skill_context_too_large"
      : dependencyErrors.includes(code)
        ? "skill_dependency_unavailable"
        : code;
  return Object.hasOwn(skillErrors, canonical)
    ? skillErrors[canonical]
    : undefined;
}
