import type { AutomationView } from "@crewon/contracts";
import { skillScheduleRecoveryMessage } from "./automationErrorMessage";

export function AutomationSkillStatus({
  definition,
}: {
  definition: AutomationView;
}) {
  if (!definition.skillInvocation) return null;
  return (
    <div className="grid min-w-0 gap-1">
      <small className="break-all">
        固定版本：{definition.skillInvocation.skill.skillId} ·{" "}
        {definition.skillInvocation.skill.versionId}
      </small>
      {definition.skillReadiness?.state === "blocked" ? (
        <div className="text-xs text-destructive" role="status">
          执行条件待恢复：
          {skillScheduleRecoveryMessage(definition.skillReadiness.code)}
        </div>
      ) : null}
    </div>
  );
}
