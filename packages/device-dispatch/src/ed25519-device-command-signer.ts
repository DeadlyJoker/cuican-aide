import {
  createPrivateKey,
  KeyObject,
  sign,
  type PrivateKeyInput,
} from "node:crypto";

import {
  canonicalUnsignedDeviceCommandSigningPayload,
  parseDeviceExecutionCommand,
  type DeviceExecutionCommand,
  type UnsignedDeviceExecutionCommand,
} from "@crewon/contracts";
import { ToolBrokerError } from "@crewon/tool-broker";

import type {
  DeviceCommandSignerPort,
  DeviceCommandSignInput,
} from "./device-tool-runtime.ts";

/** Open Ed25519 signer whose private key stays outside deployment manifests. */
export class Ed25519DeviceCommandSigner implements DeviceCommandSignerPort {
  readonly #keyId: string;
  readonly #privateKey: KeyObject;
  readonly #now: () => Date;
  readonly #authorizationTtlMs: number;

  constructor(config: {
    keyId: string;
    privateKey: KeyObject | PrivateKeyInput;
    now?: () => Date;
    authorizationTtlMs?: number;
  }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(config.keyId)) {
      throw new ToolBrokerError("device_signing_key_id_invalid");
    }
    const authorizationTtlMs = config.authorizationTtlMs ?? 300_000;
    if (
      !Number.isSafeInteger(authorizationTtlMs) ||
      authorizationTtlMs < 1 ||
      authorizationTtlMs > 3_600_000
    ) {
      throw new ToolBrokerError("device_signing_ttl_invalid");
    }
    let privateKey: KeyObject;
    try {
      privateKey =
        config.privateKey instanceof KeyObject
          ? config.privateKey
          : createPrivateKey(config.privateKey);
    } catch (error) {
      throw new ToolBrokerError("device_signing_key_invalid", {
        cause: error,
      });
    }
    if (
      privateKey.type !== "private" ||
      privateKey.asymmetricKeyType !== "ed25519"
    ) {
      throw new ToolBrokerError("device_signing_key_invalid");
    }
    this.#keyId = config.keyId;
    this.#privateKey = privateKey;
    this.#now = config.now ?? (() => new Date());
    this.#authorizationTtlMs = authorizationTtlMs;
  }

  async sign(input: DeviceCommandSignInput): Promise<DeviceExecutionCommand> {
    const now = this.#now();
    const nowMs = now.getTime();
    const commandExpiryMs = Date.parse(input.command.expiresAt);
    if (!Number.isFinite(nowMs) || commandExpiryMs <= nowMs) {
      throw new ToolBrokerError("device_signing_lease_expired");
    }
    const authorizationExpiresAt = new Date(
      Math.min(commandExpiryMs, nowMs + this.#authorizationTtlMs),
    ).toISOString();
    const unsigned: UnsignedDeviceExecutionCommand = {
      ...input.command,
      authorization: {
        schemaVersion: "crewon.device-authorization.v0",
        scheme: "ed25519",
        keyId: this.#keyId,
        issuedAt: now.toISOString(),
        expiresAt: authorizationExpiresAt,
        approvalProof: input.approvalProof,
      },
    };
    return parseDeviceExecutionCommand({
      ...unsigned,
      authorization: {
        ...unsigned.authorization,
        signature: sign(
          null,
          Buffer.from(
            canonicalUnsignedDeviceCommandSigningPayload(unsigned),
            "utf8",
          ),
          this.#privateKey,
        ).toString("base64url"),
      },
    });
  }
}
