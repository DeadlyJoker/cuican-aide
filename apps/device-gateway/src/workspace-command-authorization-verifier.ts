import { createPublicKey, verify, type KeyObject } from "node:crypto";

import {
  canonicalDeviceWorkspaceListCommandSigningPayload,
  type DeviceWorkspaceListCommand,
} from "@crewon/contracts";

import type { CommandSigningKeyRegistration } from "./device-registry-config.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";

/** Verifies the independent read-only Workspace command signature. */
export interface WorkspaceCommandAuthorizationVerifierPort {
  verify(command: DeviceWorkspaceListCommand): Promise<void>;
}

export class Ed25519WorkspaceCommandAuthorizationVerifier
  implements WorkspaceCommandAuthorizationVerifierPort
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
    const maxClockSkewMs = options.maxClockSkewMs ?? 300_000;
    if (
      registrations.length < 1 ||
      registrations.length > 32 ||
      !Number.isSafeInteger(maxClockSkewMs) ||
      maxClockSkewMs < 0 ||
      maxClockSkewMs > 3_600_000
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
    this.#maxClockSkewMs = maxClockSkewMs;
  }

  async verify(command: DeviceWorkspaceListCommand): Promise<void> {
    const key = this.#keys.get(command.authorization.keyId);
    if (key === undefined) {
      throw new DeviceGatewayError("device_authorization_key_unknown");
    }
    const now = this.#now().getTime();
    if (
      !Number.isFinite(now) ||
      Date.parse(command.authorization.issuedAt) > now + this.#maxClockSkewMs ||
      Date.parse(command.authorization.expiresAt) < now ||
      Date.parse(command.expiresAt) <= now
    ) {
      throw new DeviceGatewayError("device_authorization_expired");
    }
    const signature = Buffer.from(command.authorization.signature, "base64url");
    if (
      signature.byteLength !== 64 ||
      !verify(
        null,
        Buffer.from(
          canonicalDeviceWorkspaceListCommandSigningPayload(command),
          "utf8",
        ),
        key,
        signature,
      )
    ) {
      throw new DeviceGatewayError("device_authorization_signature_invalid");
    }
  }
}
