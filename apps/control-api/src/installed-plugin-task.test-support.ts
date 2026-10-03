import { createHash } from "node:crypto";
import type { ActorContext } from "@crewon/application";
import { createExtensionRunBinding } from "@crewon/domain";
import { ProductionControlApiIdentity } from "./production-security-adapters.ts";

export const actor: ActorContext = Object.freeze({
  principalId: "fixture-person",
  actorId: "fixture-actor",
  tenantId: "fixture-tenant",
  spaceId: "fixture-space",
});
export const scope = Object.freeze({
  tenantId: actor.tenantId,
  spaceId: actor.spaceId,
  profileId: "fixture-profile",
});
export const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
export const request = {
  method: "POST",
  url: "/api/v1/plugins/ui/mounts/fixture-ref/actions",
  remoteAddress: "127.0.0.1",
  headers: {
    "authorization": "Bearer actual-fixture-token",
    "origin": "https://fixture-bff.example",
    "x-crewon-bff-authorization": "Bearer fixture-bff-token",
  },
};
export const document = {
  schemaVersion: "crewon.installed-plugin-control-tasks.v1",
  installRoot: "/fixture-installed-root",
  peer: {
    origin: "http://127.0.0.1:18442",
    tokenEnvironmentVariable: "FIXTURE_PEER_TOKEN",
  },
  packageAuthority: {
    url: "https://fixture-authority.example/packages",
    serviceTokenEnvironmentVariable: "FIXTURE_SERVICE_TOKEN",
  },
  quoteAuthority: {
    url: "https://fixture-authority.example/quotes",
    serviceTokenEnvironmentVariable: "FIXTURE_SERVICE_TOKEN",
  },
  timeoutMs: 1000,
  maximumPackages: 8,
};
export const environment = {
  FIXTURE_PEER_TOKEN: "fixture-peer-token-000000000000000000000",
  FIXTURE_SERVICE_TOKEN: "fixture-service-token-0000000000000000",
};
export const endpoint = {
  url: document.quoteAuthority.url,
  serviceToken: environment.FIXTURE_SERVICE_TOKEN,
};
const digest = digester.sha256("fixture");
export const binding = createExtensionRunBinding(
  {
    schemaVersion: "crewon.extension-run-binding.v0",
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    pluginId: "fixture.report",
    actorId: actor.actorId,
    runId: "fixture-run",
    threadId: "fixture-thread",
    configurationRevision: 1,
    configurationDigest: digest,
    inputDigest: digester.sha256('{"prompt":"fixture"}'),
    source: null,
    target: {
      executionAuthority: "crewonKernel",
      agentVersionId: "fixture-agent",
      agentVersionContentDigest: digest,
      materializationDigest: digest,
      authorityId: "fixture-authority",
      runtimeGeneration: "ts-v0",
      policySnapshotId: "fixture-policy",
      workspaceBindingId: null,
    },
  },
  digester,
);
export const quoteInput = {
  actor,
  binding,
  input: { prompt: "fixture" },
  commandRequestDigest: digest,
};
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function identityFixture() {
  let current: ActorContext = actor;
  let calls = 0;
  const identity = new ProductionControlApiIdentity({
    trustedBff: { verify() {} },
    tokens: {
      async verify({ accessToken, signal }) {
        signal.throwIfAborted();
        if (accessToken !== "actual-fixture-token")
          throw new Error("fixture-token-denied");
        calls++;
        return {
          issuer: "https://fixture-identity.example",
          audience: ["fixture-control"],
          issuedAt: "2026-10-03T00:00:00.000Z",
          expiresAt: "2026-10-03T00:05:00.000Z",
          ...current,
        };
      },
    },
    expectedIssuer: "https://fixture-identity.example",
    expectedAudience: "fixture-control",
    timeoutMs: 1000,
    cacheTtlMs: 5000,
    now: () => Date.parse("2026-10-03T00:00:00.000Z"),
  });
  return {
    identity,
    setActor: (value: ActorContext) => {
      current = value;
    },
    calls: () => calls,
  };
}
