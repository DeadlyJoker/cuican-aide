import { ApplicationError } from "./application-error.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";

/** Office receipts predate the sha256: prefix used by the shared digest port. */
export function officeIdempotencyDigest(
  digester: ContentDigester,
  value: string,
): string {
  const digest = digester.sha256(value);
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(digest))
    throw new ApplicationError("internal", "office_idempotency_digest_invalid");
  return digest.slice("sha256:".length);
}
