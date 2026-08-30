import { createPublicKey, verify, type KeyObject } from "node:crypto";

import {
  canonicalDeviceCommandSigningPayload,
  type DeviceExecutionCommand,
} from "@crewon/contracts";

import { DeviceGatewayError } from "./device-gateway-error.ts";
import type { CommandSigningKeyRegistration } from "./device-registry-config.ts";

/** Verifies Control Plane authorization before a command reaches a Device. */
export interface DeviceCommandAuthorizationVerifierPort {
  verify(command: DeviceExecutionCommand): Promise<void>;
}

export class Ed25519DeviceCommandAuthorizationVerifier
  implements DeviceCommandAuthorizationVerifierPort
{
  readonly #keys: ReadonlyMap<string, KeyObject>;
  readonly #now: () => Date;
  readonly #maxClockSkewMs: number;

  constructor(
    registrations: readonly CommandSigningKeyRegistration[],
    options: Readonly<{
      now?: () => Date;
      maxClockSkewMs?: number;
    }> = {},
  ) {
    if (
      registrations.length < 1 ||
      registrations.length > 32 ||
      !Number.isSafeInteger(options.maxClockSkewMs ?? 300_000) ||
      (options.maxClockSkewMs ?? 300_000) < 0 ||
      (options.maxClockSkewMs ?? 300_000) > 3_600_000
    ) {
      throw new DeviceGatewayError("device_signing_key_config_invalid");
    }
    const keys = new Map<string, KeyObject>();
    for (const registration of registrations) {
      if (keys.has(registration.keyId)) {
        throw new DeviceGatewayError("device_signing_key_config_invalid");
      }
      let key: KeyObject;
      try {
        key = createPublicKey(registration.publicKeyPem);
      } catch (error) {
        throw new DeviceGatewayError("device_signing_key_config_invalid", {
          cause: error,
        });
      }
      if (key.asymmetricKeyType !== "ed25519") {
        throw new DeviceGatewayError("device_signing_key_type_invalid");
      }
      keys.set(registration.keyId, key);
    }
    this.#keys = keys;
    this.#now = options.now ?? (() => new Date());
    this.#maxClockSkewMs = options.maxClockSkewMs ?? 300_000;
  }

  async verify(command: DeviceExecutionCommand): Promise<void> {
    const authorization = command.authorization;
    const key = this.#keys.get(authorization.keyId);
    if (key === undefined) {
      throw new DeviceGatewayError("device_authorization_key_unknown");
    }
    const now = this.#now().getTime();
    if (
      Date.parse(authorization.issuedAt) > now + this.#maxClockSkewMs ||
      Date.parse(authorization.expiresAt) < now
    ) {
      throw new DeviceGatewayError("device_authorization_expired");
    }
    const signature = Buffer.from(authorization.signature, "base64url");
    if (
      signature.byteLength !== 64 ||
      !verify(
        null,
        Buffer.from(canonicalDeviceCommandSigningPayload(command), "utf8"),
        key,
        signature,
      )
    ) {
      throw new DeviceGatewayError("device_authorization_signature_invalid");
    }
  }
}
