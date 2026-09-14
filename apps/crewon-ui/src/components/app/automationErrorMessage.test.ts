import { ControlApiClientError } from "@crewon/control-client";
import { describe, expect, it } from "vitest";
import { automationErrorMessage } from "./automationErrorMessage";

describe("Skill schedule recovery messages", () => {
  it.each([
    ["automation_skill_unavailable", "恢复连接"],
    ["skill_authority_unavailable", "恢复连接"],
    ["automation_skill_backend_unsupported", "本地服务"],
    ["skill_disabled", "激活该版本"],
    ["skill_version_not_found", "重新选择"],
    ["skill_ref_mismatch", "重新确认固定版本"],
    ["skill_store_corrupt", "重新确认固定版本"],
    ["skill_scope_mismatch", "恢复访问权限"],
    ["skill_tool_unavailable", "恢复依赖"],
    ["skill_not_found", "重新选择"],
    ["skill_not_active", "激活该版本"],
    ["skill_access_denied", "恢复访问权限"],
    ["skill_digest_mismatch", "重新确认固定版本"],
    ["skill_parameters_invalid", "检查参数"],
    ["skill_dependency_unavailable", "恢复依赖"],
    ["skill_delivery_target_denied", "重新选择交付目标"],
    ["skill_budget_exceeded", "预算"],
    ["automation_skill_snapshot_mismatch", "检查运行历史"],
    ["skill_parameter_type_invalid", "检查参数"],
    ["skill_parameter_enum_invalid", "检查参数"],
    ["skill_parameter_unknown", "检查参数"],
    ["skill_tool_refs_mismatch", "恢复依赖"],
    ["skill_context_too_large", "缩短参数"],
  ])("offers a specific recovery action for %s", (code, action) => {
    expect(
      automationErrorMessage(
        new ControlApiClientError({
          status: 422,
          category: "validation",
          code,
          requestId: "r-1",
        }),
        "generic",
      ),
    ).toContain(action);
  });

  it("preserves unknown-outcome guidance instead of suggesting an immediate fresh execution", () => {
    expect(
      automationErrorMessage(
        new ControlApiClientError({
          status: 503,
          category: "unknownOutcome",
          code: "unknown",
          requestId: "r-1",
        }),
        "generic",
      ),
    ).toContain("确认运行历史后再操作");
  });
});
