import { DELIVERY_LIMITS } from "./delivery.ts";

/** Base64 JSON envelope for the documented 10 MiB input limit, plus bounded metadata. */
export const DELIVERY_UPLOAD_BODY_BYTES =
  Math.ceil((DELIVERY_LIMITS.fileBytes * 4) / 3) + 4096;

/** This chooses a transport limit, never authority; every target still requires normal session/thread checks. */
export function deliveryRequestBodyLimit(input: {
  method: string;
  url: string | URL;
  defaultLimit: number;
}): number {
  if (input.method !== "POST") return input.defaultLimit;
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return input.defaultLimit;
  }
  if (url.href.includes("?") || url.href.includes("#"))
    return input.defaultLimit;
  const match =
    /^\/api\/v1\/threads\/([A-Za-z0-9._:%-]+)\/delivery\/inputs$/u.exec(
      url.pathname,
    );
  if (!match) return input.defaultLimit;
  let threadId: string;
  try {
    threadId = decodeURIComponent(match[1]);
  } catch {
    return input.defaultLimit;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(threadId))
    return input.defaultLimit;
  return DELIVERY_UPLOAD_BODY_BYTES;
}
