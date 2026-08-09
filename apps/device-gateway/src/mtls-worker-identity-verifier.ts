import type { IncomingMessage } from "node:http";

import type { WorkerRegistration } from "./device-registry-config.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import { verifiedMtlsPeerFingerprint } from "./mtls-peer-certificate.ts";
import type { WorkerIdentityVerifierPort } from "./worker-identity.ts";

export class MtlsWorkerIdentityVerifier implements WorkerIdentityVerifierPort {
  readonly #registrations: ReadonlyMap<string, WorkerRegistration>;
  readonly #now: () => Date;

  constructor(
    registrations: readonly WorkerRegistration[],
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
      unauthorized: "worker_mtls_unauthorized",
      invalid: "worker_peer_certificate_invalid",
      expired: "worker_peer_certificate_expired",
    });
    const registration = this.#registrations.get(fingerprint);
    if (registration === undefined) {
      throw new DeviceGatewayError("worker_certificate_unregistered");
    }
    return {
      workerId: registration.workerId,
      credentialId: registration.credentialId,
      authenticationMethod: "mtls" as const,
      authenticatedAt: authenticatedAt.toISOString(),
    };
  }
}
