const MAX_TEXT_LENGTH = 512;

const SENSITIVE_WORDS =
  /password|passwd|passphrase|(?:^|[^a-z])pwd|secret|token|cookie|credential|authorization|authentication|(?:^|[^a-z])auth(?:$|[^a-z])|(?:api|access|refresh)[\s_-]*key|(?:^|[^a-z])key(?:$|[^a-z])|session|csrf|xsrf|one[\s_-]*time|(?:^|[^a-z])otp|(?:^|[^a-z])pin(?:$|[^a-z])|security[\s_-]*(?:code|answer)|card[\s_-]*(?:number|code)|private[\s_-]*key|username|user[\s_-]*name|login|登录|密[码钥]|令牌|验证码/i;
const SENSITIVE_AUTOCOMPLETE =
  /(?:^|\s)(?:current-password|new-password|one-time-code|username|webauthn|cc-[a-z-]+)(?:\s|$)/i;
export const ORDINARY_INPUT_TYPES = new Set([
  "text",
  "search",
  "number",
  "date",
  "month",
  "week",
  "time",
  "datetime-local",
  "range",
  "color",
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
]);
/** Shared second filter for the host. Rejected content is never truncated and retained. */
export function safeRecordingText(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH) return null;
  if (/[^\P{C}\t\n\r]/u.test(value) || SENSITIVE_WORDS.test(value)) return null;
  if (
    /bearer\s+|basic\s+[a-z0-9+/=]+|-----BEGIN|[a-z0-9+/_=-]{24,}|\beyJ[a-z0-9_-]+\./i.test(
      value,
    )
  )
    return null;
  // URL user-info and query values can contain credentials even in an ordinary field.
  if (/[a-z][a-z0-9+.-]*:\/\/[^\s]+[?@#]/i.test(value)) return null;
  return value;
}

export function sensitiveRecordingControl(element: Element): boolean {
  const type = element.getAttribute("type")?.toLowerCase();
  if (type && !ORDINARY_INPUT_TYPES.has(type)) return true;
  const autocomplete = element.getAttribute("autocomplete") ?? "";
  if (SENSITIVE_AUTOCOMPLETE.test(autocomplete)) return true;
  for (const name of [
    "id",
    "name",
    "aria-label",
    "placeholder",
    "data-testid",
  ]) {
    const attribute = element.getAttribute(name);
    if (
      attribute &&
      (attribute.length > MAX_TEXT_LENGTH || SENSITIVE_WORDS.test(attribute))
    )
      return true;
  }
  return false;
}
