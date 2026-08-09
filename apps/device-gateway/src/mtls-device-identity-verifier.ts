import type { IncomingMessage } from "node:http";

import { DeviceGatewayError } from "./device-gateway-error.ts";
import type { DeviceIdentityVerifierPort } from "./device-identity.ts";
import type { DeviceRegistration } from "./device-registry-config.ts";
import { verifiedMtlsPeerFingerprint } from "./mtls-peer-certificate.ts";

export class MtlsDeviceIdentityVerifier implements DeviceIdentityVerifierPort {
  readonly #registrations: ReadonlyMap<string, DeviceRegistration>;
  readonly #now: () => Date;

  constructor(
    registrations: readonly DeviceRegistration[],
    options: Readonly<{ now?: () => Date }> = {},
  ) {
    this.#registrations = new Map(
      registrations.map((registration) => [
        registration.fingerprint256,
        structuredClone(registration),
      ]),
    );
    this.#now = options.now ?? (() => new Date());
  }

  async verify(request: IncomingMessage) {
    const authenticatedAt = this.#now();
    const fingerprint = verifiedMtlsPeerFingerprint(request, authenticatedAt, {
      unauthorized: "device_mtls_unauthorized",
      invalid: "device_peer_certificate_invalid",
      expired: "device_peer_certificate_expired",
    });
    const registration = this.#registrations.get(fingerprint);
    if (registration === undefined) {
      throw new DeviceGatewayError("device_certificate_unregistered");
    }
    return {
      deviceId: registration.deviceId,
      credentialId: registration.credentialId,
      authenticationMethod: "mtls" as const,
      authenticatedAt: authenticatedAt.toISOString(),
    };
  }
}
