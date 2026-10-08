import assert from "node:assert/strict";
import test from "node:test";
import {
  createProjectFoundationToolsClient,
  PROJECT_FOUNDATION_TOOL_OPERATIONS,
  PROJECT_FOUNDATION_TOOL_OPERATION_IDS,
  ProjectFoundationToolsContractError,
} from "../dist/project-foundation-tools.js";

// This data-client fixture supplies no Store, Run, installation or execution authority.
const digest = `sha256:${"a".repeat(64)}`;
const time = "2026-10-08T00:00:00.000Z";
const scope = {
  projectId: "p",
  threadId: "thread",
  runId: "run",
  bindingId: "binding",
  bindingRevision: 1,
  foundationRevision: 1,
  parametersRevision: 1,
  parametersDigest: digest,
  source: null,
  confirmedProposal: null,
  latestProposal: null,
  allowedOperations: PROJECT_FOUNDATION_TOOL_OPERATION_IDS,
  contentDigest: digest,
};
function service(patch = {}) {
  return {
    ...Object.fromEntries(
      Object.keys(PROJECT_FOUNDATION_TOOL_OPERATIONS).map((method) => [
        method,
        async () => {
          throw new Error("unused");
        },
      ]),
    ),
    ...patch,
  };
}
function metadata() {
  return {
    schemaVersion: "crewon.project-proposal.v1",
    projectId: "p",
    revision: 1,
    kind: "creative-plan",
    foundationRevision: 1,
    parametersRevision: 1,
    source: null,
    contentDigest: digest,
    characterLength: 3,
    createdAt: time,
  };
}
test("Node client preserves original command identity and does not inspect or traverse its fields", async () => {
  let calls = 0;
  const command = Object.create(null);
  Object.defineProperty(command, "authorization", {
    get() {
      calls++;
      throw new Error("opaque");
    },
  });
  const host = service({
    readScope: async (input) => {
      assert.equal(input.command, command);
      assert.deepEqual(input.request, {});
      assert.ok(Object.isFrozen(input.request));
      assert.ok(Object.isFrozen(input));
      return { scope };
    },
  });
  const client = createProjectFoundationToolsClient(host);
  const result = await client.readScope({ command, request: {} });
  assert.deepEqual(result.scope, scope);
  assert.ok(Object.isFrozen(result.scope));
  assert.equal(calls, 0);
  assert.ok(Object.isFrozen(client));
  assert.equal("confirmProposal" in client, false);
});
test("request is detached before first await and candidate ACK never echoes or confirms text", async () => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const request = {
    projectId: "p",
    expectedFoundationRevision: 1,
    expectedProposalRevision: 0,
    kind: "creative-plan",
    text: "雨夜😀",
  };
  const command = {};
  const client = createProjectFoundationToolsClient(
    service({
      saveProposal: async (input) => {
        assert.equal(input.command, command);
        await blocked;
        assert.equal(input.request.text, "雨夜😀");
        assert.equal(input.request.expectedProposalRevision, 0);
        return {
          kind: "save-proposal",
          disposition: "committed",
          foundationRevision: 1,
          proposal: metadata(),
        };
      },
    }),
  );
  const pending = client.saveProposal({ command, request });
  request.text = "changed";
  request.expectedProposalRevision = 9;
  release();
  const result = await pending;
  assert.equal(result.foundationRevision, 1);
  assert.equal("text" in result.proposal, false);
  assert.equal("confirmedProposal" in result, false);
});
test("malformed/foreign/oversized ACK is rejected after service call", async () => {
  for (const response of [
    { scope: { ...scope, actor: {} } },
    {
      scope: {
        ...scope,
        allowedOperations: [
          ...PROJECT_FOUNDATION_TOOL_OPERATION_IDS,
          "foundation_confirm",
        ],
      },
    },
    { scope: { ...scope, projectId: "a".repeat(8192) } },
  ])
    await assert.rejects(
      createProjectFoundationToolsClient(
        service({ readScope: async () => response }),
      ).readScope({ command: {}, request: {} }),
      ProjectFoundationToolsContractError,
    );
  await assert.rejects(
    createProjectFoundationToolsClient(
      service({
        saveProposal: async () => ({
          kind: "save-proposal",
          disposition: "committed",
          foundationRevision: 2,
          proposal: metadata(),
        }),
      }),
    ).saveProposal({
      command: {},
      request: {
        projectId: "p",
        expectedFoundationRevision: 1,
        expectedProposalRevision: 0,
        kind: "creative-plan",
        text: "雨夜😀",
      },
    }),
    ProjectFoundationToolsContractError,
  );
});
test("input/client getters and invalid business fields are rejected without evaluating callbacks", async () => {
  let calls = 0;
  const host = service({
    readScope: async () => {
      calls++;
      return { scope };
    },
  });
  const descriptorHost = { ...host };
  Object.defineProperty(descriptorHost, "readScope", {
    enumerable: true,
    get() {
      calls++;
      return host.readScope;
    },
  });
  assert.throws(
    () => createProjectFoundationToolsClient(descriptorHost),
    ProjectFoundationToolsContractError,
  );
  const client = createProjectFoundationToolsClient(host);
  const input = { command: {}, request: {} };
  Object.defineProperty(input, "request", {
    enumerable: true,
    get() {
      calls++;
      return {};
    },
  });
  await assert.rejects(
    client.readScope(input),
    ProjectFoundationToolsContractError,
  );
  await assert.rejects(
    client.readScope({ command: {}, request: { owner: "foreign" } }),
    ProjectFoundationToolsContractError,
  );
  await assert.rejects(
    client.saveProposal({
      command: {},
      request: {
        projectId: "p",
        expectedFoundationRevision: 1,
        expectedProposalRevision: 0,
        kind: "creative-plan",
        text: "candidate",
        idempotencyKey: "caller",
      },
    }),
    ProjectFoundationToolsContractError,
  );
  assert.equal(calls, 0);
});
