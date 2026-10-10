import type { Locale } from "../lib/i18n";

/** Keep provider codes available without making them the user-facing explanation. */
export function transcriptFailurePresentation(
  message: string | null | undefined,
  additionalDetails: string | null | undefined,
  locale: Locale,
): { message: string; details: string | null } {
  const rawMessage = message?.trim() || "";
  const providerCode = /^responses_provider_[a-z_]+$/.test(rawMessage);
  let explanation = rawMessage;
  if (providerCode || !rawMessage) {
    if (rawMessage === "responses_provider_server_is_overloaded") {
      explanation =
        locale === "zh"
          ? "模型服务暂时繁忙，请稍后重试。"
          : "The model service is busy. Please try again shortly.";
    } else if (rawMessage === "responses_provider_invalid_prompt") {
      explanation =
        locale === "zh"
          ? "模型服务未接受本次请求，任务未完成。"
          : "The model service did not accept this request. The task did not complete.";
    } else {
      explanation =
        locale === "zh"
          ? "模型连接失败，当前任务没有完成。"
          : "Model connection failed, so this turn did not complete.";
    }
  }
  const details = [providerCode ? rawMessage : null, additionalDetails?.trim()]
    .filter(Boolean)
    .join("\n");
  return { message: explanation, details: details || null };
}
