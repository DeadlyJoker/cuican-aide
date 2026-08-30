import type { IncomingMessage } from "node:http";
import { TLSSocket } from "node:tls";

import { DeviceGatewayError } from "./device-gateway-error.ts";

export function verifiedMtlsPeerFingerprint(
  request: IncomingMessage,
  now: Date,
  codes: Readonly<{
    unauthorized: string;
    invalid: string;
    expired: string;
  }>,
): string {
  if (!(request.socket instanceof TLSSocket) || !request.socket.authorized) {
    throw new DeviceGatewayError(codes.unauthorized);
  }
  const certificate = request.socket.getPeerCertificate();
  if (
    certificate === null ||
    typeof certificate !== "object" ||
    typeof certificate.fingerprint256 !== "string" ||
    typeof certificate.valid_from !== "string" ||
    typeof certificate.valid_to !== "string"
  ) {
    throw new DeviceGatewayError(codes.invalid);
  }
  const validFrom = Date.parse(certificate.valid_from);
  const validTo = Date.parse(certificate.valid_to);
  const nowMs = now.getTime();
  if (
    !Number.isFinite(nowMs) ||
    Number.isNaN(validFrom) ||
    Number.isNaN(validTo) ||
    nowMs < validFrom ||
    nowMs > validTo
  ) {
    throw new DeviceGatewayError(codes.expired);
  }
  return certificate.fingerprint256;
}
