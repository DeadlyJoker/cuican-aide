import {
  createPrivateKey,
  KeyObject,
  sign,
  type PrivateKeyInput,
} from "node:crypto";

import {
  canonicalUnsignedDeviceWorkspaceListCommandSigningPayload,
  parseDeviceWorkspaceListCommand,
  type DeviceWorkspaceListCommand,
  type UnsignedDeviceWorkspaceListCommand,
} from "@crewon/contracts";

export type DeviceWorkspaceListCommandSignInput = Readonly<{
  command: Omit<DeviceWorkspaceListCommand, "authorization">;
}>;

/** Owns the Workspace command-signing key without exposing raw key material. */
export interface DeviceWorkspaceListCommandSignerPort {
  sign(
    input: DeviceWorkspaceListCommandSignInput,
  ): Promise<DeviceWorkspaceListCommand>;
}

export class DeviceWorkspaceListSigningError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "DeviceWorkspaceListSigningError";
    this.code = code;
  }
}

/** Signs only the independent Workspace payload; Tool payloads are never reused. */
export class Ed25519DeviceWorkspaceListCommandSigner
  implements DeviceWorkspaceListCommandSignerPort
{
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
      throw new DeviceWorkspaceListSigningError(
        "device_workspace_signing_key_id_invalid",
      );
    }
    const authorizationTtlMs = config.authorizationTtlMs ?? 300_000;
    if (
      !Number.isSafeInteger(authorizationTtlMs) ||
      authorizationTtlMs < 1 ||
      authorizationTtlMs > 3_600_000
    ) {
      throw new DeviceWorkspaceListSigningError(
        "device_workspace_signing_ttl_invalid",
      );
    }
    let privateKey: KeyObject;
    try {
      privateKey =
        config.privateKey instanceof KeyObject
          ? config.privateKey
          : createPrivateKey(config.privateKey);
    } catch (error) {
      throw new DeviceWorkspaceListSigningError(
        "device_workspace_signing_key_invalid",
        { cause: error },
      );
    }
    if (
      privateKey.type !== "private" ||
      privateKey.asymmetricKeyType !== "ed25519"
    ) {
      throw new DeviceWorkspaceListSigningError(
        "device_workspace_signing_key_invalid",
      );
    }
    this.#keyId = config.keyId;
    this.#privateKey = privateKey;
    this.#now = config.now ?? (() => new Date());
    this.#authorizationTtlMs = authorizationTtlMs;
  }

  async sign(
    input: DeviceWorkspaceListCommandSignInput,
  ): Promise<DeviceWorkspaceListCommand> {
    const now = this.#now();
    const nowMs = now.getTime();
    const commandExpiryMs = Date.parse(input.command.expiresAt);
    if (!Number.isFinite(nowMs) || commandExpiryMs <= nowMs) {
      throw new DeviceWorkspaceListSigningError(
        "device_workspace_signing_lease_expired",
      );
    }
    const unsigned: UnsignedDeviceWorkspaceListCommand = {
      ...input.command,
      authorization: {
        schemaVersion: "crewon.device-authorization.v0",
        scheme: "ed25519",
        keyId: this.#keyId,
        issuedAt: now.toISOString(),
        expiresAt: new Date(
          Math.min(commandExpiryMs, nowMs + this.#authorizationTtlMs),
        ).toISOString(),
        approvalProof: null,
      },
    };
    return parseDeviceWorkspaceListCommand({
      ...unsigned,
      authorization: {
        ...unsigned.authorization,
        signature: sign(
          null,
          Buffer.from(
            canonicalUnsignedDeviceWorkspaceListCommandSigningPayload(unsigned),
            "utf8",
          ),
          this.#privateKey,
        ).toString("base64url"),
      },
    });
  }
}
