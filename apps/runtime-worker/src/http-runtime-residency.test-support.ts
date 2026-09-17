import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  compileAgentVersion,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import { loadAgentVersionRuntimeFactory } from "./runtime-binding-config.ts";
import { digester } from "./shared-agent-runtime-cache.test-support.ts";

export function httpVersion(id: string): CompiledAgentVersion {
  return compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: id,
      runtimeGeneration: "ts-v0",
      policySnapshotId: "policy",
      instructions: "stable instructions",
      model: {
        adapterName: "direct-responses",
        adapterVersion: "1",
        modelId: "fixture-model",
        contextWindowTokens: 128000,
        autoCompactAtTokens: 96000,
      },
      execution: { maxToolRounds: 8, streamMaxRetries: 0 },
      resources: { workspaceRequired: false, governedContextDigest: null },
      tools: [],
    },
    digester,
  );
}
export function httpBinding(
  version: CompiledAgentVersion,
  options: {
    tenantId?: string;
    authorityId?: string;
    endpoint?: string;
    apiKeyEnvironment?: string | null;
    storeResponses?: boolean;
    toolRuntimeMode?: "shared" | "independent";
  } = {},
) {
  return {
    tenantId: options.tenantId ?? "tenant",
    agentVersionId: version.agentVersionId,
    contentDigest: version.contentDigest,
    authorityId: options.authorityId ?? "authority",
    workspaceBindingId: null,
    provider: {
      kind: "directResponses" as const,
      endpoint: options.endpoint ?? "http://127.0.0.1:9/v1/responses",
      apiKeyEnvironment: options.apiKeyEnvironment ?? null,
      storeResponses: options.storeResponses ?? true,
      requestProfile: "standard" as const,
      idleTimeoutMs: 60000,
      sequencePolicy: "required" as const,
    },
    mcpStdioConfigPath: null,
    deviceToolConfigPath: null,
    remoteMcpConfigPath: null,
    toolRuntimeMode: options.toolRuntimeMode ?? "shared",
  };
}
export function loadedHttpFactory(
  t: TestContext,
  bindings: ReturnType<typeof httpBinding>[],
  environment: Record<string, string> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "crewon-http-residency-")),
    path = join(root, "bindings.json");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: "crewon.agent-version-runtime-bindings.v0",
      bindings,
    }),
    { mode: 0o600 },
  );
  return loadAgentVersionRuntimeFactory(path, environment);
}
