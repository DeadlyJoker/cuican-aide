import type { ToolPermissionMode } from "@crewon/contracts";
import { CommandComposerSelect } from "./CommandComposer";

export type TaskToolPermissionMode = Exclude<ToolPermissionMode, "fullAccess">;
export type TaskToolPermissionSelectProps = {
  value: TaskToolPermissionMode;
  onChange: (value: TaskToolPermissionMode) => void;
  disabled?: boolean;
  scope: "execution" | "schedule";
};

export function TaskToolPermissionSelect({
  value,
  onChange,
  disabled = false,
  scope,
}: TaskToolPermissionSelectProps) {
  const taskScope = scope === "execution" ? "整个本次任务" : "每次日程任务";
  const requestDetail = "需要审批的工具操作暂停等待用户";
  const delegateDetail = `CrewON 代为批准${taskScope}的工具操作`;
  return (
    <div className="grid gap-2">
      <span>工具操作审批</span>
      <CommandComposerSelect<TaskToolPermissionMode>
        ariaLabel={
          scope === "execution" ? "本次任务工具审批" : "日程任务工具审批"
        }
        className="w-full"
        contentClassName="w-[min(420px,var(--radix-select-content-available-width))]"
        menuTitle="工具操作如何批准？"
        disabled={disabled}
        value={value}
        onChange={onChange}
        options={[
          {
            value: "requestApproval",
            label: "请求批准",
            icon: "hand",
            detail: requestDetail,
          },
          {
            value: "approveForMe",
            label: "帮我批准",
            icon: "shield-check",
            detail: delegateDetail,
          },
        ]}
      />
      <p className="m-0 text-xs leading-relaxed text-[var(--text-muted)]">
        {value === "approveForMe" ? delegateDetail : requestDetail}。
      </p>
      <p className="m-0 text-xs leading-relaxed text-[var(--text-muted)]">
        此设置适用于{taskScope}
        ，包括文件交付，不仅是表格操作；不替代浏览器或资源授权。
      </p>
    </div>
  );
}
