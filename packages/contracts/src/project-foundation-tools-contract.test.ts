import assert from "node:assert/strict";
import test from "node:test";
import {
  CREWON_PROJECT_FOUNDATION_TOOLS_SERVICE,
  PROJECT_FOUNDATION_TOOL_OPERATIONS as operations,
  PROJECT_FOUNDATION_TOOL_OPERATION_IDS,
  ProjectFoundationToolsContractError,
  parseProjectFoundationToolsRequest,
  parseProjectFoundationToolsResponse,
  type ProjectFoundationToolsInputMap,
  type ProjectFoundationToolsMethod,
  type ProjectFoundationToolsRequestFor,
  type ProjectFoundationToolsProposalMetadata,
  type PublicProjectFoundationRunScope,
} from "./project-foundation-tools.ts";
const digest = `sha256:${"a".repeat(64)}`;
const foreignDigest = `sha256:${"b".repeat(64)}`;
const at = "2026-10-08T00:00:00.000Z";
const pointer = { revision: 1, digest };
const inputs: ProjectFoundationToolsInputMap = {
  readScope: {},
  getFoundation: { projectId: "p" },
  getSource: { projectId: "p", sourceRevision: 1, sourceDigest: digest },
  readSourcePage: {
    projectId: "p",
    sourceRevision: 1,
    sourceDigest: digest,
    startOffset: 0,
    limit: 1024,
  },
  listSourceChapters: {
    projectId: "p",
    sourceRevision: 1,
    sourceDigest: digest,
    limit: 16,
  },
  getProposal: {
    projectId: "p",
    proposalRevision: 1,
    proposalDigest: digest,
    startOffset: 0,
    limit: 1024,
  },
  listProposals: { projectId: "p", afterProposalRevision: 0, limit: 4 },
  saveProposal: {
    projectId: "p",
    expectedFoundationRevision: 1,
    expectedProposalRevision: 0,
    kind: "creative-plan",
    text: "雨夜😀",
  },
};
function request<M extends ProjectFoundationToolsMethod>(
  method: M,
  input = inputs[method],
): ProjectFoundationToolsRequestFor<M> {
  return { operation: operations[method], request: input };
}
function metadata(revision = 1): ProjectFoundationToolsProposalMetadata {
  return {
    schemaVersion: "crewon.project-proposal.v1",
    projectId: "p",
    revision,
    kind: "creative-plan",
    foundationRevision: 1,
    parametersRevision: 1,
    source: null,
    contentDigest: digest,
    characterLength: 3,
    createdAt: at,
  };
}
function scope(): PublicProjectFoundationRunScope {
  return {
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
}
const parameters = {
  genre: null,
  episodeMode: "series" as const,
  episodeCount: null,
  episodeDurationSeconds: null,
  aspectRatio: "9:16" as const,
  visualStyle: null,
  needsCharacters: true,
  needsArt: true,
  adaptation: null,
};
const foundation = {
  schemaVersion: "crewon.project-foundation.v1",
  projectId: "p",
  origin: "creative",
  revision: 1,
  parametersRevision: 1,
  parameters,
  source: null,
  confirmedProposal: null,
  creativeStartMode: "confirm-plan",
  createdAt: at,
  updatedAt: at,
};
const source = {
  schemaVersion: "crewon.project-source.v1",
  projectId: "p",
  revision: 1,
  digest,
  fileDigest: foreignDigest,
  fileName: "小说.txt",
  format: "txt",
  byteLength: 12,
  characterLength: 3,
  createdAt: at,
};
const page = {
  startOffset: 0,
  endOffset: 3,
  content: "雨夜😀",
  nextOffset: null,
  characterLength: 3,
};
test("Node protocol is independent and accepts exactly the eight bounded business request shapes", () => {
  assert.equal(
    CREWON_PROJECT_FOUNDATION_TOOLS_SERVICE,
    "crewon.project-foundation-tools",
  );
  assert.deepEqual(Object.values(operations), [
    "foundation_scope",
    "foundation_read",
    "foundation_source",
    "foundation_source_page",
    "foundation_chapters",
    "foundation_proposal",
    "foundation_proposals",
    "foundation_proposal_save",
  ]);
  for (const method of Object.keys(inputs) as ProjectFoundationToolsMethod[]) {
    const raw = request(method);
    const result = parseProjectFoundationToolsRequest(raw);
    assert.deepEqual(result, raw);
    assert.notEqual(result.request, raw.request);
    assert.ok(Object.isFrozen(result.request));
    assert.throws(
      () => parseProjectFoundationToolsRequest({ ...raw, command: {} }),
      ProjectFoundationToolsContractError,
    );
    for (const field of [
      "owner",
      "actor",
      "scope",
      "pin",
      "sourceUpload",
      "rawBytes",
      "idempotencyKey",
    ])
      assert.throws(
        () =>
          parseProjectFoundationToolsRequest({
            ...raw,
            request: { ...raw.request, [field]: "foreign" },
          }),
        ProjectFoundationToolsContractError,
      );
  }
  for (const operation of [
    "foundation_confirm",
    "foundation_create",
    "script_save",
    "crewon.project-foundation.v1.saveProposal",
  ])
    assert.throws(
      () => parseProjectFoundationToolsRequest({ operation, request: {} }),
      ProjectFoundationToolsContractError,
    );
});
test("requests reject exhausted revisions, unsupported kinds, oversized Unicode and out-of-range page budgets", () => {
  for (const [method, patch] of [
    ["readSourcePage", { limit: 1025 }],
    ["readSourcePage", { startOffset: -1 }],
    ["getFoundation", { parametersStartOffset: -1 }],
    ["getFoundation", { parametersStartOffset: 8193 }],
    ["getFoundation", { parametersStartOffset: null }],
    ["getFoundation", { parametersLimit: 0 }],
    ["getFoundation", { parametersLimit: 1025 }],
    ["getProposal", { limit: 0 }],
    ["getProposal", { startOffset: 8193 }],
    ["listSourceChapters", { limit: 17 }],
    ["listSourceChapters", { afterStartOffset: -1 }],
    ["listSourceChapters", { afterStartOffset: null }],
    ["listProposals", { limit: 5 }],
    ["listProposals", { afterProposalRevision: -1 }],
    ["saveProposal", { expectedProposalRevision: Number.MAX_SAFE_INTEGER }],
    ["saveProposal", { text: "汉".repeat(2731) }],
    ["saveProposal", { text: "a".repeat(24 * 1024) }],
    ["saveProposal", { text: "\ud800" }],
    ["saveProposal", { text: " \n " }],
    ["saveProposal", { kind: "confirmed" }],
  ] as const)
    assert.throws(
      () =>
        parseProjectFoundationToolsRequest({
          operation: operations[method],
          request: { ...inputs[method], ...patch },
        }),
      ProjectFoundationToolsContractError,
    );
});
test("Node parameters paging is optional strict business data and leaves the host Foundation DTO complete", () => {
  assert.deepEqual(request("getFoundation").request, { projectId: "p" });
  const expected = request("getFoundation", {
    projectId: "p",
    parametersStartOffset: 0,
    parametersLimit: 1024,
  });
  assert.deepEqual(expected.request, {
    projectId: "p",
    parametersStartOffset: 0,
    parametersLimit: 1024,
  });
  assert.deepEqual(
    parseProjectFoundationToolsResponse({ foundation }, expected).foundation,
    foundation,
  );
});
test("scope is small immutable hints and forbids owner, installation and UI authority fields", () => {
  const expected = request("readScope");
  const result = parseProjectFoundationToolsResponse(
    { scope: scope() },
    expected,
  );
  assert.deepEqual(result.scope, scope());
  assert.ok(Object.isFrozen(result.scope.allowedOperations));
  for (const patch of [
    { tenantId: "tenant" },
    { ownerPrincipalId: "owner" },
    { installation: {} },
    { taskInputDigest: digest },
    { parametersRevision: 2 },
    {
      allowedOperations: [
        ...PROJECT_FOUNDATION_TOOL_OPERATION_IDS,
        "foundation_confirm",
      ],
    },
    { allowedOperations: [...PROJECT_FOUNDATION_TOOL_OPERATION_IDS].reverse() },
    { confirmedProposal: pointer },
    { projectId: "a".repeat(8192) },
  ])
    assert.throws(
      () =>
        parseProjectFoundationToolsResponse(
          { scope: { ...scope(), ...patch } },
          expected,
        ),
      ProjectFoundationToolsContractError,
    );
  assert.throws(
    () => parseProjectFoundationToolsResponse({ scope: null }, expected),
    ProjectFoundationToolsContractError,
  );
});
test("Foundation and source metadata preserve their exact public shapes and requested project/digest", () => {
  assert.equal(
    parseProjectFoundationToolsResponse(
      { foundation },
      request("getFoundation"),
    ).foundation.revision,
    1,
  );
  assert.equal(
    parseProjectFoundationToolsResponse({ source }, request("getSource")).source
      .fileName,
    "小说.txt",
  );
  for (const patch of [
    { projectId: "foreign" },
    { ownerPrincipalId: "foreign" },
    { revision: 2 },
    { digest: foreignDigest },
  ])
    assert.throws(
      () =>
        parseProjectFoundationToolsResponse(
          { source: { ...source, ...patch } },
          request("getSource"),
        ),
      ProjectFoundationToolsContractError,
    );
  assert.throws(
    () =>
      parseProjectFoundationToolsResponse(
        { foundation: { ...foundation, projectId: "foreign" } },
        request("getFoundation"),
      ),
    ProjectFoundationToolsContractError,
  );
});
test("full valid Foundation parameters use their independent budget rather than being truncated to scope size", () => {
  const retainedCharacters: string[] = [];
  const novelParameters = {
    ...parameters,
    episodeDurationSeconds: { minimum: 60, maximum: 120 },
    visualStyle: "semi-realistic",
    adaptation: { strategy: "core", retainedCharacters, retainedScenes: [] },
  };
  while (retainedCharacters.length < 64) {
    const next = `${retainedCharacters.length}:` + "a".repeat(150);
    retainedCharacters.push(next);
    if (Buffer.byteLength(JSON.stringify(novelParameters)) > 8000) {
      retainedCharacters.pop();
      break;
    }
  }
  const response = {
    foundation: {
      ...foundation,
      origin: "novel",
      parameters: novelParameters,
      creativeStartMode: null,
      source: pointer,
    },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(novelParameters)) < 8192);
  assert.ok(Buffer.byteLength(JSON.stringify(response)) > 8192);
  assert.equal(
    parseProjectFoundationToolsResponse(response, request("getFoundation"))
      .foundation.parameters.adaptation!.retainedCharacters.length,
    retainedCharacters.length,
  );
});
test("scalar pages preserve whitespace and emoji, reach exact EOF and reject changed digests/cursors", () => {
  const expected = request("readSourcePage");
  assert.deepEqual(
    parseProjectFoundationToolsResponse(
      { sourceRevision: 1, sourceDigest: digest, page },
      expected,
    ).page,
    page,
  );
  const whitespace = { ...page, content: " \n\t", characterLength: 3 };
  assert.equal(
    parseProjectFoundationToolsResponse(
      { sourceRevision: 1, sourceDigest: digest, page: whitespace },
      expected,
    ).page.content,
    " \n\t",
  );
  const eof = request("readSourcePage", {
    ...inputs.readSourcePage,
    startOffset: 3,
  });
  assert.equal(
    parseProjectFoundationToolsResponse(
      {
        sourceRevision: 1,
        sourceDigest: digest,
        page: { ...page, startOffset: 3, content: "" },
      },
      eof,
    ).page.content,
    "",
  );
  for (const patch of [
    { sourceDigest: foreignDigest },
    { sourceRevision: 2 },
    { page: { ...page, endOffset: 4 } },
    { page: { ...page, nextOffset: 3 } },
    { page: { ...page, content: "雨夜\ud800" } },
    { page: { ...page, startOffset: 1 } },
    { page: { ...page, content: "雨夜😀", characterLength: 4 } },
    { page: { ...page, content: "a".repeat(32 * 1024) } },
  ])
    assert.throws(
      () =>
        parseProjectFoundationToolsResponse(
          { sourceRevision: 1, sourceDigest: digest, page, ...patch },
          expected,
        ),
      ProjectFoundationToolsContractError,
    );
});
test("chapter pages are ordered, unique, bounded and use the actual last-start cursor", () => {
  const expected = request("listSourceChapters", {
    ...inputs.listSourceChapters,
    limit: 2,
  });
  const chapter = {
    projectId: "p",
    sourceRevision: 1,
    chapterId: "c1",
    title: "第一章",
    startOffset: 0,
    endOffset: 2,
  };
  const chapters = [
    chapter,
    { ...chapter, chapterId: "c2", startOffset: 2, endOffset: 3 },
  ];
  assert.equal(Object.hasOwn(expected.request, "afterStartOffset"), false);
  const afterZero = request("listSourceChapters", {
    ...inputs.listSourceChapters,
    afterStartOffset: 0,
  });
  assert.deepEqual(
    parseProjectFoundationToolsResponse(
      { chapters: [chapters[1]], nextStartOffset: null },
      afterZero,
    ).chapters,
    [chapters[1]],
  );
  assert.throws(
    () =>
      parseProjectFoundationToolsResponse(
        { chapters, nextStartOffset: null },
        afterZero,
      ),
    ProjectFoundationToolsContractError,
  );
  assert.equal(
    parseProjectFoundationToolsResponse(
      { chapters, nextStartOffset: 2 },
      expected,
    ).chapters.length,
    2,
  );
  assert.deepEqual(
    parseProjectFoundationToolsResponse(
      { chapters: [], nextStartOffset: null },
      expected,
    ).chapters,
    [],
  );
  for (const response of [
    { chapters, nextStartOffset: 3 },
    { chapters: [], nextStartOffset: 0 },
    { chapters: [chapter, chapter], nextStartOffset: null },
    { chapters: [...chapters].reverse(), nextStartOffset: null },
    { chapters: [{ ...chapter, sourceRevision: 2 }], nextStartOffset: null },
    { chapters: [{ ...chapter, projectId: "foreign" }], nextStartOffset: null },
    {
      chapters: [{ ...chapter, startOffset: 2, endOffset: 2 }],
      nextStartOffset: null,
    },
  ])
    assert.throws(
      () => parseProjectFoundationToolsResponse(response, expected),
      ProjectFoundationToolsContractError,
    );
});
test("proposal body is independently paged by immutable digest and history never includes text", () => {
  const expected = request("getProposal");
  assert.equal(
    parseProjectFoundationToolsResponse(
      { proposal: metadata(), page },
      expected,
    ).page!.content,
    "雨夜😀",
  );
  assert.deepEqual(
    parseProjectFoundationToolsResponse(
      { proposal: null, page: null },
      expected,
    ),
    { proposal: null, page: null },
  );
  for (const response of [
    { proposal: null, page },
    { proposal: { ...metadata(), contentDigest: foreignDigest }, page },
    { proposal: { ...metadata(), projectId: "foreign" }, page },
    { proposal: { ...metadata(), text: "whole body" }, page },
    { proposal: { ...metadata(), characterLength: 4 }, page },
  ])
    assert.throws(
      () => parseProjectFoundationToolsResponse(response, expected),
      ProjectFoundationToolsContractError,
    );
  const history = request("listProposals");
  const proposals = [1, 2, 3, 4].map(metadata);
  assert.equal(
    parseProjectFoundationToolsResponse({ proposals, nextRevision: 4 }, history)
      .proposals.length,
    4,
  );
  for (const response of [
    { proposals, nextRevision: 3 },
    { proposals: [metadata(1), metadata(1)], nextRevision: null },
    { proposals: [{ ...metadata(), text: "whole body" }], nextRevision: null },
    {
      proposals: [{ ...metadata(), ownerPrincipalId: "owner" }],
      nextRevision: null,
    },
  ])
    assert.throws(
      () => parseProjectFoundationToolsResponse(response, history),
      ProjectFoundationToolsContractError,
    );
});
test("sixteen maximum Unicode chapter titles and identities fit the explicit chapter response budget", () => {
  const projectId = "项".repeat(128);
  const expected = request("listSourceChapters", {
    ...inputs.listSourceChapters,
    projectId,
  });
  const chapters = Array.from({ length: 16 }, (_, index) => ({
    projectId,
    sourceRevision: 1,
    chapterId: "章".repeat(125) + `${index}`,
    title: "文".repeat(320),
    startOffset: index * 2,
    endOffset: index * 2 + 2,
  }));
  const response = { chapters, nextStartOffset: null };
  assert.ok(Buffer.byteLength(JSON.stringify(response)) > 8192);
  assert.ok(Buffer.byteLength(JSON.stringify(response)) < 32 * 1024);
  assert.equal(
    parseProjectFoundationToolsResponse(response, expected).chapters.length,
    16,
  );
});
test("candidate ACK has the original Foundation revision and proposal CAS, without auto-confirmation or content echo", () => {
  const expected = request("saveProposal");
  const ack = {
    kind: "save-proposal",
    disposition: "committed",
    foundationRevision: 1,
    proposal: metadata(),
  };
  assert.equal(
    parseProjectFoundationToolsResponse(ack, expected).foundationRevision,
    1,
  );
  assert.equal(
    parseProjectFoundationToolsResponse(
      { ...ack, disposition: "replayed" },
      expected,
    ).disposition,
    "replayed",
  );
  for (const patch of [
    { foundationRevision: 2 },
    { kind: "confirm-proposal" },
    { confirmedProposal: pointer },
    { foundation },
    { proposal: { ...metadata(), revision: 2 } },
    { proposal: { ...metadata(), characterLength: 4 } },
    { proposal: { ...metadata(), text: inputs.saveProposal.text } },
  ])
    assert.throws(
      () => parseProjectFoundationToolsResponse({ ...ack, ...patch }, expected),
      ProjectFoundationToolsContractError,
    );
});
test("codec rejects accessor/hooks/revoked proxies before reading business values", () => {
  let calls = 0;
  const getter = { ...inputs.saveProposal };
  Object.defineProperty(getter, "text", {
    enumerable: true,
    get() {
      calls++;
      return "executed";
    },
  });
  assert.throws(
    () => parseProjectFoundationToolsRequest(request("saveProposal", getter)),
    ProjectFoundationToolsContractError,
  );
  const bad = {
    ...scope(),
    toJSON() {
      calls++;
      return {};
    },
  };
  assert.throws(
    () =>
      parseProjectFoundationToolsResponse({ scope: bad }, request("readScope")),
    ProjectFoundationToolsContractError,
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.throws(
    () => parseProjectFoundationToolsRequest(revoked.proxy),
    ProjectFoundationToolsContractError,
  );
  assert.equal(calls, 0);
});
