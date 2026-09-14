import { createHash } from "node:crypto";
import { safeRecordingText } from "./recordingSource.ts";

export function teachingUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192)
    throw new Error("recording_url_invalid");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("recording_url_invalid");
  return url.href;
}
export function recordingPage(value: string) {
  const url = new URL(teachingUrl(value));
  let redactNext = false;
  const path = url.pathname
    .split("/")
    .map((part) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(part);
      } catch {
        return "{runtime}";
      }
      const sensitive =
        redactNext ||
        safeRecordingText(decoded) === null ||
        /[{}]/.test(decoded);
      redactNext =
        /^(token|secret|password|auth|session|key|credential)$/i.test(decoded);
      return sensitive ? "{runtime}" : encodeURIComponent(decoded);
    })
    .join("/");
  const query = [...url.searchParams.keys()]
    .slice(0, 20)
    .map(
      (key) =>
        `${!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) ? "parameter" : key}={runtime}`,
    )
    .join("&");
  const routeTemplate = `${url.origin}${path}${query ? "?" + query : ""}`;
  return {
    origin: url.origin,
    routeTemplate,
    routeDigest:
      `sha256:${createHash("sha256").update(routeTemplate).digest("hex")}` as const,
  };
}
