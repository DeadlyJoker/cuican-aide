import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PROJECT_FOUNDATION_TOOL_OPERATIONS } from "@crewon/plugin-sdk/project-foundation-tools";
export const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "40.0.0";
const plugin = (
  await import(
    process.env.CREWON_SHORT_DRAMA_PLUGIN_DIR
      ? pathToFileURL(
          join(process.env.CREWON_SHORT_DRAMA_PLUGIN_DIR, "node.mjs"),
        ).href
      : `../dist/${version}/node.mjs`
  )
).default;
export const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
export const sha = (value) =>
  "sha256:" + createHash("sha256").update(value).digest("hex");
export const at = "2026-10-08T00:00:00.000Z";
export const projectId = "unit-project",
  sourceDigest = sha("source"),
  proposalDigest = sha("proposal");
export const query = { projectId, sourceRevision: 1, sourceDigest };
export const foundation = {
  schemaVersion: "crewon.project-foundation.v1",
  projectId,
  origin: "novel",
  revision: 1,
  parametersRevision: 1,
  parameters: {
    genre: null,
    episodeMode: "series",
    episodeCount: null,
    episodeDurationSeconds: { minimum: 120, maximum: 180 },
    aspectRatio: "9:16",
    visualStyle: "semi-realistic",
    needsCharacters: true,
    needsArt: true,
    adaptation: {
      strategy: "core",
      retainedCharacters: ["林雨"],
      retainedScenes: [],
    },
  },
  source: { revision: 1, digest: sourceDigest },
  confirmedProposal: null,
  creativeStartMode: null,
  createdAt: at,
  updatedAt: at,
};
export const scope = {
  projectId,
  threadId: "unit-thread",
  runId: "unit-run",
  bindingId: "unit-binding",
  bindingRevision: 1,
  foundationRevision: 1,
  parametersRevision: 1,
  parametersDigest: sha("parameters"),
  source: foundation.source,
  confirmedProposal: null,
  latestProposal: null,
  allowedOperations: Object.values(PROJECT_FOUNDATION_TOOL_OPERATIONS),
  contentDigest: sha("scope"),
};
export const proposal = {
  schemaVersion: "crewon.project-proposal.v1",
  projectId,
  revision: 1,
  kind: "novel-adaptation",
  foundationRevision: 1,
  parametersRevision: 1,
  source: foundation.source,
  contentDigest: proposalDigest,
  characterLength: 3,
  createdAt: at,
};
export function payload(result) {
  return JSON.parse(JSON.parse(result.result.output).resultJsonParts.join(""));
}
/** Named public DTO ports exercise the installed ESM/SDK, not a real SQL/Run authority. */
export function fixture({
  missing = false,
  overrides = {},
  approval = "none",
} = {}) {
  let factory,
    oldCalls = 0;
  const calls = [],
    host = {
      readScope: async () => ({ scope }),
      getFoundation: async () => ({ foundation }),
      getSource: async () => ({
        source: {
          schemaVersion: "crewon.project-source.v1",
          projectId,
          revision: 1,
          digest: sourceDigest,
          fileDigest: sha("file"),
          fileName: "雨夜.txt",
          format: "txt",
          byteLength: 12,
          characterLength: 4,
          createdAt: at,
        },
      }),
      readSourcePage: async () => ({
        sourceRevision: 1,
        sourceDigest,
        page: {
          startOffset: 1,
          endOffset: 2,
          content: "😀",
          nextOffset: 2,
          characterLength: 4,
        },
      }),
      listSourceChapters: async () => ({
        chapters: [
          {
            projectId,
            sourceRevision: 1,
            chapterId: "chapter-1",
            title: "第一章",
            startOffset: 0,
            endOffset: 4,
          },
        ],
        nextStartOffset: null,
      }),
      getProposal: async () => ({
        proposal,
        page: {
          startOffset: 0,
          endOffset: 3,
          content: "雨😀夜",
          nextOffset: null,
          characterLength: 3,
        },
      }),
      listProposals: async () => ({
        proposals: [proposal],
        nextRevision: null,
      }),
      saveProposal: async () => ({
        kind: "save-proposal",
        disposition: "committed",
        foundationRevision: 1,
        proposal,
      }),
      ...overrides,
    };
  const tracked = Object.fromEntries(
    Object.keys(PROJECT_FOUNDATION_TOOL_OPERATIONS).map((method) => [
      method,
      async (input) => {
        calls.push({ method, ...input });
        return host[method](input);
      },
    ]),
  );
  plugin.setup({
    identity: {
      pluginId: "crewon.short-drama",
      version,
      packageDigest: sha("package"),
    },
    services: {
      getOptional(name, apiVersion) {
        if (name === "crewon.project-foundation-tools") {
          assert.equal(apiVersion, "1");
          return missing ? undefined : tracked;
        }
        if (name === "crewon.project-tools")
          return {
            async getProject() {
              oldCalls++;
              throw Error("old grant called");
            },
          };
        if (name === "crewon.project-context")
          return {
            async readScope() {
              oldCalls++;
              return { scope: null };
            },
          };
        if (name === "crewon.execution")
          return {
            register(value) {
              factory = value;
              return { dispose() {} };
            },
          };
      },
      provide() {
        return { dispose() {} };
      },
    },
    onDispose() {},
  });
  assert.ok(factory);
  const context = {
    identity: {
      pluginId: "crewon.short-drama",
      version,
      packageDigest: sha("package"),
    },
    scope: {
      tenantId: "unit-tenant",
      spaceId: "unit-space",
      profileId: "unit-profile",
    },
    run: {
      runId: "unit-run",
      threadId: "unit-thread",
      bindingDigest: sha("binding"),
      inputDigest: sha("input"),
      source: null,
    },
    configuration: {
      revision: 1,
      contentDigest: sha("config"),
      parameters: {
        baseUrl: "https://no-network.example/",
        preset: "krea2-portrait",
      },
      credentialBindings: [],
    },
    target: {
      executionAuthority: "crewonKernel",
      agentVersionId: "unit-agent",
      agentVersionContentDigest: sha("agent"),
      materializationDigest: sha("material"),
      authorityId: "unit-authority",
      runtimeGeneration: "unit-generation",
      policySnapshotId: "unit-policy",
      workspaceBindingId: null,
    },
  };
  const create = () =>
      factory.create(context, { approvalRequirement: approval }),
    runtime = create();
  let index = 0;
  function command(method, request, owner = runtime) {
    index++;
    const name =
        "crewon_short_drama__" + PROJECT_FOUNDATION_TOOL_OPERATIONS[method],
      input = JSON.stringify(request),
      policy = owner.executionPolicy("function", name) ?? {
        effect: "readOnly",
      },
      actionIntent = {
        schemaVersion: "crewon.action-intent.v0",
        runId: context.run.runId,
        segmentId: "unit-segment",
        callId: "unit-call-" + index,
        tool: { kind: "function", name, inputDigest: sha(input) },
        policySnapshotId: context.target.policySnapshotId,
        workspaceBindingId: null,
        ...policy,
      };
    return {
      schemaVersion: "crewon.tool-invocation.v0",
      executionId: "unit-execution-" + index,
      idempotencyKey: "unit-key-" + index,
      runId: context.run.runId,
      segmentId: actionIntent.segmentId,
      callId: actionIntent.callId,
      kind: "function",
      name,
      input,
      actionDigest: sha(canonical(actionIntent)),
      actionIntent,
      executionLease: {
        workItemId: "unit-work",
        stepId: "unit-step",
        attemptId: "unit-attempt",
        leaseId: "unit-lease",
        leaseEpoch: 1,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
      approvalProof: null,
    };
  }
  return { runtime, create, command, calls, host, oldCalls: () => oldCalls };
}
export const saveRequest = {
  projectId,
  expectedFoundationRevision: 1,
  expectedProposalRevision: 0,
  kind: "novel-adaptation",
  text: "雨😀夜",
};
