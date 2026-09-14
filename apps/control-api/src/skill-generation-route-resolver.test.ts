import assert from "node:assert/strict";
import test from "node:test";
import {
  compileAgentVersion,
  createAgentVersionAsset,
  type AgentVersionSource,
} from "@crewon/agent-version";
import type { AgentVersionAsset, RunRoute } from "@crewon/application";
import { NodeSha256ContentDigester } from "./standalone-adapters.ts";
import { createConfiguredSkillGenerationRouteResolver } from "./skill-generation-route-resolver.ts";

const actor = { principalId: "p", actorId: "a", tenantId: "t", spaceId: "s" };
const route: RunRoute = {
  authorityId: "authority",
  agentVersionId: "generator",
  runtimeGeneration: "generation",
  policySnapshotId: "policy",
  workspaceBindingId: null,
};
const digester = new NodeSha256ContentDigester();
function asset(overrides: Partial<AgentVersionSource> = {}): AgentVersionAsset {
  return createAgentVersionAsset({
    tenantId: actor.tenantId,
    createdAt: "2026-09-14T00:00:00Z",
    version: compileAgentVersion(
      {
        schemaVersion: "crewon.agent-version-source.v0",
        agentVersionId: route.agentVersionId,
        runtimeGeneration: route.runtimeGeneration,
        policySnapshotId: route.policySnapshotId,
        instructions: "Generate JSON",
        model: {
          adapterName: "direct-responses",
          adapterVersion: "1",
          modelId: "selected-model",
          contextWindowTokens: 128000,
          autoCompactAtTokens: 96000,
        },
        execution: { streamMaxRetries: 2, maxToolRounds: 0 },
        resources: { workspaceRequired: false, governedContextDigest: null },
        tools: [],
        ...overrides,
      },
      digester,
    ),
  });
}
const input = { actor, threadId: "thread", agentVersionId: null };

test("generation routes use the fixed no-tool version through existing release admission", async () => {
  const requests: unknown[] = [];
  const queries: unknown[] = [];
  const resolver = createConfiguredSkillGenerationRouteResolver({
    generationAgentVersionId: route.agentVersionId,
    digester,
    routes: {
      resolveRoute: async (request) => {
        requests.push(request);
        return route;
      },
    },
    store: {
      loadAgentVersion: async (query) => {
        queries.push(query);
        return asset();
      },
    },
  });
  assert.deepEqual(await resolver.resolveRoute(input), route);
  assert.deepEqual(requests, [
    { ...input, agentVersionId: route.agentVersionId },
  ]);
  assert.deepEqual(queries, [
    { tenantId: actor.tenantId, agentVersionId: route.agentVersionId },
  ]);
  assert.deepEqual(
    await resolver.resolveRoute({
      ...input,
      agentVersionId: route.agentVersionId,
    }),
    route,
  );
  await assert.rejects(
    resolver.resolveRoute({
      ...input,
      agentVersionId: "unsafe-selected-agent",
    }),
    /skill_generation_agent_selection_invalid/,
  );
  assert.equal(requests.length, 2);
});

test("generation routes fail closed for tools, positive budgets, provider authority, digest, scope, and route drift", async () => {
  const unsafeAssets = [
    asset({
      tools: [
        {
          schemaVersion: "crewon.tool-definition.v0",
          kind: "function",
          name: "browser",
          description: "Browser",
          execution: "serial",
          inputSchema: { type: "object" },
        },
      ],
    }),
    asset({ execution: { streamMaxRetries: 0, maxToolRounds: 1 } }),
    asset({
      model: {
        adapterName: "cloud-agent",
        adapterVersion: "1",
        modelId: "provider",
        contextWindowTokens: 128000,
        autoCompactAtTokens: null,
      },
    }),
    { ...asset(), contentDigest: `sha256:${"0".repeat(64)}` },
    { ...asset(), tenantId: "other" },
    asset({ runtimeGeneration: "other" }),
    asset({ policySnapshotId: "other" }),
    asset({
      resources: { workspaceRequired: true, governedContextDigest: null },
    }),
    null,
  ];
  for (const stored of unsafeAssets) {
    const resolver = createConfiguredSkillGenerationRouteResolver({
      digester,
      routes: { resolveRoute: async () => route },
      store: { loadAgentVersion: async () => stored },
    });
    await assert.rejects(resolver.resolveRoute(input), /skill_generation_/);
  }
  const rejected = createConfiguredSkillGenerationRouteResolver({
    digester,
    routes: {
      resolveRoute: async () => {
        throw new Error("release_admission_denied");
      },
    },
    store: {
      loadAgentVersion: async () => assert.fail("may not bypass release"),
    },
  });
  await assert.rejects(
    rejected.resolveRoute(input),
    /release_admission_denied/,
  );
});

test("an existing zero-tool default is usable without a configured generation ID", async () => {
  const resolver = createConfiguredSkillGenerationRouteResolver({
    digester,
    routes: { resolveRoute: async () => route },
    store: { loadAgentVersion: async () => asset() },
  });
  assert.deepEqual(await resolver.resolveRoute(input), route);
});
