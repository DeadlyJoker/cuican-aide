import type { IncomingMessage } from "node:http";

import type { GatewayRegistration } from "./device-registry-config.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import type { GatewayIdentityVerifierPort } from "./gateway-identity.ts";
import { verifiedMtlsPeerFingerprint } from "./mtls-peer-certificate.ts";

export class MtlsGatewayIdentityVerifier
  implements GatewayIdentityVerifierPort
{
  readonly #registrations: ReadonlyMap<string, GatewayRegistration>;
  readonly #now: () => Date;

  constructor(
    registrations: readonly GatewayRegistration[],
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
      unauthorized: "gateway_mtls_unauthorized",
      invalid: "gateway_peer_certificate_invalid",
      expired: "gateway_peer_certificate_expired",
    });
    const registration = this.#registrations.get(fingerprint);
    if (registration === undefined) {
      throw new DeviceGatewayError("gateway_certificate_unregistered");
    }
    return {
      gatewayId: registration.gatewayId,
      credentialId: registration.credentialId,
      authenticationMethod: "mtls" as const,
      authenticatedAt: authenticatedAt.toISOString(),
    };
  }
}
