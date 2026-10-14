import type { Turn } from "@crewon/app-server-protocol/v2/Turn";
import type { Locale } from "../i18n";

export function threadFailurePresentation(
  error: Turn["error"],
  locale: Locale,
) {
  switch (error?.message) {
    case "installed_plugin_request_authority_unavailable":
    case "project_conversation_execution_unavailable":
    case "project_asset_stage_execution_unavailable":
    case "project_media_input_stage_execution_unavailable":
      return {
        title:
          locale === "zh" ? "插件执行暂不可用" : "Plugin execution unavailable",
        message:
          locale === "zh"
            ? "当前插件的执行服务尚未准备好，请等待服务恢复后再试。"
            : "The plugin execution service is not ready. Try again when it is available.",
        diagnostic: error.message,
      };
    case "responses_provider_server_is_overloaded":
      return {
        title: locale === "zh" ? "模型服务繁忙" : "Model service busy",
        message:
          locale === "zh"
            ? "当前模型服务暂时过载。请稍后重试，或选择其他模型。"
            : "The model service is overloaded. Try again later or select another model.",
        diagnostic: error.message,
      };
    case "responses_provider_invalid_prompt":
      return {
        title: locale === "zh" ? "模型请求被拒绝" : "Model request rejected",
        message:
          locale === "zh"
            ? "模型服务未能接受本次请求，请查看错误详情。"
            : "The model service could not accept this request. See the error details.",
        diagnostic: error.message,
      };
    default:
      return {
        title: locale === "zh" ? "模型连接失败" : "Model connection failed",
        message:
          error?.message ||
          (locale === "zh"
            ? "模型连接失败，当前任务没有完成。"
            : "Model connection failed, so this turn did not complete."),
        diagnostic: null,
      };
  }
}
