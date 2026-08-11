import { inspect } from "node:util";

import type {
  CrewonRemoteMcpBearerSink,
  CrewonRemoteMcpCredentialLeasePort,
} from "@crewon/mcp-runtime";

import {
  NetworkEgressError,
  type NetworkEgressInput,
  type NetworkEgressPolicy,
} from "./network-egress.ts";
import type {
  RemoteMcpBindingIdentity,
  RemoteMcpCompositionDependencies,
} from "./remote-mcp-composition.ts";
import type {
  RuntimeNativeCredentialBindingAuthority,
  RuntimeNativeCredentialBindings,
} from "./runtime-native-bootstrap.ts";

export interface RuntimeNativeRemoteMcpOwner {
  readonly dependencies: RemoteMcpCompositionDependencies;
  destroy(): void;
}

/** Consumes native credentials once and binds them to the pinned production manifest. */
export function createRuntimeNativeRemoteMcpOwner(input: Readonly<{
  credentials: RuntimeNativeCredentialBindings;
  expectedAuthority: RuntimeNativeCredentialBindingAuthority;
  manifestBindings: readonly RemoteMcpBindingIdentity[];
}>): RuntimeNativeRemoteMcpOwner {
  const expected = input.expectedAuthority;
  const manifests = new Map<string, RemoteMcpBindingIdentity>();
  const credentialIds = new Set<string>();
  for (const identity of input.manifestBindings) {
    if (
      identity.tenantId !== expected.tenantId ||
      identity.agentVersionId !== expected.agentVersionId
    ) continue;
    const key = identityKey(identity);
    if (identity.mode !== "production" || manifests.has(key)) {
      throw invalid();
    }
    manifests.set(key, identity);
    credentialIds.add(identity.credentialBindingId);
  }
  const secrets = new Map<string, SecretSlot>();
  try {
    input.credentials.consume(expected, (bindings) => {
      for (const binding of bindings) {
        if (!credentialIds.has(binding.credentialBindingId) || secrets.has(binding.credentialBindingId)) {
          throw invalid();
        }
        secrets.set(
          binding.credentialBindingId,
          { master: Buffer.from(binding.bearerToken, "utf8") },
        );
      }
      if (secrets.size !== credentialIds.size) throw invalid();
    });
  } catch {
    destroySecrets(secrets);
    throw invalid();
  }
  let destroyed = false;
  const owner: RuntimeNativeRemoteMcpOwner = {
    dependencies: {
      mode: "production",
      credentialLeaseFactory: (identity) => {
        const manifest = manifests.get(identityKey(identity));
        if (destroyed || manifest === undefined || !sameIdentity(identity, manifest)) {
          throw invalid();
        }
        const slot = secrets.get(identity.credentialBindingId);
        if (slot === undefined) throw invalid();
        return credentialLeasePort(slot);
      },
      tenantEgressFactory: (identity) => {
        const manifest = manifests.get(identityKey(identity));
        if (destroyed || manifest === undefined || !sameIdentity(identity, manifest)) {
          throw invalid();
        }
        return { policy: boundProductionPolicy(manifest) };
      },
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      destroySecrets(secrets);
      manifests.clear();
    },
  };
  return redact(owner);
}

type SecretSlot = { master: Buffer | null };

function credentialLeasePort(slot: SecretSlot): CrewonRemoteMcpCredentialLeasePort {
  return {
    acquire: ({ signal }) => {
      if (signal.aborted || slot.master === null) throw invalid();
      const leaseSecret = Buffer.from(slot.master);
      let available = true;
      return {
        apply(sink: CrewonRemoteMcpBearerSink) {
          if (!available || signal.aborted) throw invalid();
          sink.applyBearer(leaseSecret.toString("utf8"));
        },
        release() {
          if (!available) return;
          available = false;
          leaseSecret.fill(0);
        },
      };
    },
  };
}

function boundProductionPolicy(
  identity: RemoteMcpBindingIdentity,
): NetworkEgressPolicy {
  return {
    authorize(input: NetworkEgressInput) {
      if (
        input.tenantId !== identity.tenantId ||
        input.scopeId !== identity.serverBindingId ||
        input.endpoint.href !== new URL(identity.endpoint).href
      ) {
        throw new NetworkEgressError("remote_mcp_network_binding_mismatch");
      }
      return { approvedAddresses: input.addresses.map(({ address }) => address) };
    },
  };
}

function identityKey(identity: RemoteMcpBindingIdentity): string {
  return JSON.stringify([
    identity.mode,
    identity.tenantId,
    identity.agentVersionId,
    identity.contentDigest,
    identity.materializationDigest,
    identity.serverBindingId,
    identity.credentialBindingId,
    identity.endpoint,
  ]);
}

function sameIdentity(
  left: RemoteMcpBindingIdentity,
  right: RemoteMcpBindingIdentity,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.mode === right.mode &&
    left.agentVersionId === right.agentVersionId &&
    left.contentDigest === right.contentDigest &&
    left.materializationDigest === right.materializationDigest &&
    left.serverBindingId === right.serverBindingId &&
    left.credentialBindingId === right.credentialBindingId &&
    left.endpoint === right.endpoint
  );
}

function destroySecrets(secrets: Map<string, SecretSlot>): void {
  for (const slot of secrets.values()) {
    slot.master?.fill(0);
    slot.master = null;
  }
  secrets.clear();
}

function redact<T extends object>(value: T): T {
  Object.defineProperty(value, inspect.custom, {
    configurable: false,
    enumerable: false,
    value: () => "RuntimeNativeRemoteMcpOwner([REDACTED])",
  });
  return value;
}

function invalid(): Error {
  return new Error("runtime_native_remote_mcp_invalid");
}
