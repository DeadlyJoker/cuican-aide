import assert from "node:assert/strict";
import test from "node:test";
import { parsePublicCreativeProject } from "./creative-project-control-response.ts";
import {
  PROJECT_FOUNDATION_UI_METHOD_ACTIONS as actions,
  ProjectFoundationContractError,
  parseProjectFoundationParameters,
  parseProjectFoundationUiRequest,
  parseProjectFoundationUiResponse,
  type ProjectFoundationCreationParameters,
  type ProjectFoundationUiInputMap,
  type ProjectFoundationUiMethod,
  type ProjectFoundationUiRequestFor,
  type PublicProjectFoundation,
  type PublicProjectProposal,
} from "./project-foundation.ts";

const digest = `sha256:${"a".repeat(64)}`;
const secondDigest = `sha256:${"b".repeat(64)}`;
const time = "2026-10-08T00:00:00.000Z";
const creative: ProjectFoundationCreationParameters = {
  genre: null,
  episodeMode: "series",
  episodeCount: null,
  episodeDurationSeconds: null,
  aspectRatio: "16:9",
  visualStyle: null,
  needsCharacters: true,
  needsArt: true,
  adaptation: null,
};
const novel: ProjectFoundationCreationParameters = {
  ...creative,
  episodeCount: 120,
  episodeDurationSeconds: { minimum: 120, maximum: 300 },
  visualStyle: "semi-realistic",
  adaptation: {
    strategy: "core",
    retainedCharacters: ["林雨"],
    retainedScenes: ["初见"],
  },
};
const upload = { uploadId: "uploaded-book", fileDigest: secondDigest };
const createInput: ProjectFoundationUiInputMap["createProject"] = {
  title: "雨夜",
  briefText: "两个人在雨夜重逢",
  origin: "creative",
  parameters: creative,
  creativeStartMode: "confirm-plan",
  sourceUpload: null,
  idempotencyKey: "create-1",
};
const project = {
  projectId: "p",
  kind: "short-drama",
  title: "雨夜",
  revision: 2,
  state: "active",
  latestBriefRevision: 1,
  createdAt: time,
  updatedAt: time,
};
const brief = {
  projectId: "p",
  briefRevision: 1,
  text: createInput.briefText,
  contentDigest: digest,
  createdAt: time,
};
function foundation(): PublicProjectFoundation {
  return {
    schemaVersion: "crewon.project-foundation.v1",
    projectId: "p",
    origin: "creative",
    revision: 1,
    parametersRevision: 1,
    parameters: creative,
    source: null,
    confirmedProposal: null,
    creativeStartMode: "confirm-plan",
    createdAt: time,
    updatedAt: time,
  };
}
const source = {
  schemaVersion: "crewon.project-source.v1",
  projectId: "p",
  revision: 1,
  digest,
  fileDigest: secondDigest,
  fileName: "故事.txt",
  format: "txt",
  byteLength: 30,
  characterLength: 12,
  createdAt: time,
};
function proposal(revision = 1): PublicProjectProposal {
  return {
    schemaVersion: "crewon.project-proposal.v1",
    projectId: "p",
    revision,
    kind: "creative-plan",
    foundationRevision: 1,
    parametersRevision: 1,
    source: null,
    text: "雨夜重逢后一起寻找失踪的人。",
    contentDigest: digest,
    createdAt: time,
  };
}
function request<M extends ProjectFoundationUiMethod>(
  method: M,
  input: ProjectFoundationUiInputMap[M],
) {
  return { action: actions[method], input } as ProjectFoundationUiRequestFor<M>;
}
const change = {
  projectId: "p",
  expectedFoundationRevision: 1,
  idempotencyKey: "change-1",
};
const inputs: ProjectFoundationUiInputMap = {
  createProject: createInput,
  getFoundation: { projectId: "p" },
  updateParameters: { ...change, parameters: creative },
  appendSource: { ...change, sourceUpload: upload },
  getSource: { projectId: "p", sourceRevision: 1 },
  readSourcePage: {
    projectId: "p",
    sourceRevision: 1,
    sourceDigest: digest,
    startOffset: 0,
    limit: 3,
  },
  listSourceChapters: {
    projectId: "p",
    sourceRevision: 1,
    sourceDigest: digest,
    afterStartOffset: null,
    limit: 2,
  },
  saveProposal: {
    ...change,
    expectedProposalRevision: 0,
    kind: "creative-plan",
    text: proposal().text,
  },
  confirmProposal: { ...change, proposalRevision: 1, proposalDigest: digest },
  chooseCreativeStartMode: { ...change, creativeStartMode: "direct-script" },
  getProposal: { projectId: "p", proposalRevision: 1 },
  listProposals: { projectId: "p", afterProposalRevision: 0, limit: 2 },
};

for (const method of Object.keys(actions) as ProjectFoundationUiMethod[])
  test(`new protocol roundtrips detached ${method} business input`, () => {
    const input = request(method, inputs[method]);
    const parsed = parseProjectFoundationUiRequest(input);
    assert.deepEqual(parsed, input);
    assert.notEqual(parsed.input, input.input);
    assert.ok(Object.isFrozen(parsed.input));
  });

test("creative and novel creation retain explicit distinct initial routes and 120 episodes", () => {
  const single = { ...creative, episodeMode: "single", episodeCount: 1 };
  assert.equal(
    parseProjectFoundationParameters(single, "creative").episodeCount,
    1,
  );
  assert.equal(
    parseProjectFoundationParameters(novel, "novel").episodeCount,
    120,
  );
  const novelCreate = request("createProject", {
    ...createInput,
    origin: "novel",
    parameters: novel,
    creativeStartMode: null,
    sourceUpload: upload,
  });
  assert.deepEqual(parseProjectFoundationUiRequest(novelCreate), novelCreate);
  for (const input of [
    {
      ...createInput,
      origin: "novel",
      parameters: novel,
      creativeStartMode: null,
      sourceUpload: null,
    },
    {
      ...createInput,
      origin: "novel",
      parameters: novel,
      sourceUpload: upload,
    },
    { ...createInput, creativeStartMode: null },
    { ...createInput, parameters: novel },
    {
      ...createInput,
      origin: "novel",
      parameters: { ...novel, episodeDurationSeconds: null },
      creativeStartMode: null,
      sourceUpload: upload,
    },
    { ...createInput, parameters: { ...single, episodeCount: null } },
    {
      ...createInput,
      parameters: {
        ...creative,
        episodeDurationSeconds: { minimum: 301, maximum: 300 },
      },
    },
  ])
    assert.throws(
      () =>
        parseProjectFoundationUiRequest(
          request("createProject", input as typeof createInput),
        ),
      ProjectFoundationContractError,
    );
});

test("rejects grants, raw files, widened namespaces, getters and oversized pagination", () => {
  let calls = 0;
  const getter = { ...createInput };
  Object.defineProperty(getter, "parameters", {
    enumerable: true,
    get() {
      calls++;
      return creative;
    },
  });
  const labels = ["林雨"];
  Object.defineProperty(labels, "0", {
    enumerable: true,
    get() {
      calls++;
      return "other";
    },
  });
  for (const input of [
    { ...createInput, owner: "somebody" },
    { ...createInput, authority: "enabled" },
    { ...createInput, sourceUpload: { ...upload, content: "raw book" } },
    getter,
    {
      ...createInput,
      origin: "novel",
      parameters: {
        ...novel,
        adaptation: { ...novel.adaptation, retainedCharacters: labels },
      },
      creativeStartMode: null,
      sourceUpload: upload,
    },
  ])
    assert.throws(
      () =>
        parseProjectFoundationUiRequest({
          action: actions.createProject,
          input,
        }),
      ProjectFoundationContractError,
    );
  assert.equal(calls, 0);
  assert.throws(
    () =>
      parseProjectFoundationUiRequest({
        action: "crewon.project-foundation.v2.createProject",
        input: createInput,
      }),
    ProjectFoundationContractError,
  );
  for (const [method, input] of [
    ["readSourcePage", { ...inputs.readSourcePage, limit: 1025 }],
    ["listSourceChapters", { ...inputs.listSourceChapters, limit: 51 }],
    ["listProposals", { ...inputs.listProposals, limit: 5 }],
    ["readSourcePage", { ...inputs.readSourcePage, sourceDigest: "fake" }],
  ] as const)
    assert.throws(
      () => parseProjectFoundationUiRequest(request(method, input)),
      ProjectFoundationContractError,
    );
  assert.throws(
    () =>
      parseProjectFoundationParameters(
        {
          ...novel,
          adaptation: {
            ...novel.adaptation,
            retainedCharacters: ["café", "cafe\u0301"],
          },
        },
        "novel",
      ),
    ProjectFoundationContractError,
  );
});

test("legacy project shape stays exact; public foundation rejects internal owner or actor", () => {
  assert.deepEqual(parsePublicCreativeProject(project), project);
  assert.throws(() =>
    parsePublicCreativeProject({ ...project, origin: "novel" }),
  );
  const expected = request("getFoundation", inputs.getFoundation);
  assert.deepEqual(
    parseProjectFoundationUiResponse({ foundation: null }, expected),
    { foundation: null },
  );
  assert.deepEqual(
    parseProjectFoundationUiResponse({ foundation: foundation() }, expected),
    { foundation: foundation() },
  );
  for (const record of [
    { ...foundation(), ownerPrincipalId: "owner" },
    { ...foundation(), tenantId: "tenant" },
    { ...foundation(), projectId: "other" },
    { ...foundation(), parametersRevision: 2 },
    {
      ...foundation(),
      creativeStartMode: "direct-script",
      confirmedProposal: { revision: 1, digest },
    },
  ])
    assert.throws(
      () => parseProjectFoundationUiResponse({ foundation: record }, expected),
      ProjectFoundationContractError,
    );
});

test("source pages preserve whitespace, scalar offsets, empty end and requested revision", () => {
  const expected = request("readSourcePage", inputs.readSourcePage);
  const page = {
    sourceRevision: 1,
    startOffset: 0,
    endOffset: 3,
    content: "雨😀a",
    nextOffset: 3,
  };
  assert.deepEqual(parseProjectFoundationUiResponse({ page }, expected), {
    page,
  });
  assert.equal(
    parseProjectFoundationUiResponse(
      { page: { ...page, content: " \n\t" } },
      expected,
    ).page.content,
    " \n\t",
  );
  assert.deepEqual(
    parseProjectFoundationUiResponse(
      { page: { ...page, endOffset: 0, content: "", nextOffset: null } },
      expected,
    ).page.content,
    "",
  );
  for (const changed of [
    { ...page, sourceRevision: 2 },
    { ...page, startOffset: 1 },
    { ...page, endOffset: 4 },
    { ...page, nextOffset: 4 },
    { ...page, content: "雨\ud800a" },
    { ...page, content: "aa", endOffset: 2, nextOffset: 2 },
  ])
    assert.throws(
      () => parseProjectFoundationUiResponse({ page: changed }, expected),
      ProjectFoundationContractError,
    );
});

test("chapter and proposal history pagination stays pinned and strictly ordered", () => {
  const expected = request("listSourceChapters", inputs.listSourceChapters);
  const chapters = [
    {
      projectId: "p",
      sourceRevision: 1,
      chapterId: "chapter-1",
      title: "第一章",
      startOffset: 0,
      endOffset: 6,
    },
    {
      projectId: "p",
      sourceRevision: 1,
      chapterId: "chapter-2",
      title: "第二章",
      startOffset: 6,
      endOffset: 12,
    },
  ];
  assert.equal(
    parseProjectFoundationUiResponse({ chapters, nextStartOffset: 6 }, expected)
      .chapters.length,
    2,
  );
  for (const changed of [
    { chapters, nextStartOffset: 12 },
    { chapters: [chapters[1], chapters[0]], nextStartOffset: null },
    {
      chapters: [{ ...chapters[0], sourceRevision: 2 }],
      nextStartOffset: null,
    },
    {
      chapters: [chapters[0], { ...chapters[1], chapterId: "chapter-1" }],
      nextStartOffset: null,
    },
  ])
    assert.throws(
      () => parseProjectFoundationUiResponse(changed, expected),
      ProjectFoundationContractError,
    );
  const history = request("listProposals", inputs.listProposals);
  const proposals = [proposal(1), proposal(2)];
  assert.equal(
    parseProjectFoundationUiResponse({ proposals, nextRevision: 2 }, history)
      .proposals.length,
    2,
  );
  assert.throws(
    () =>
      parseProjectFoundationUiResponse({ proposals, nextRevision: 3 }, history),
    ProjectFoundationContractError,
  );
  assert.throws(
    () =>
      parseProjectFoundationUiResponse(
        { proposals: [proposal(2), proposal(1)], nextRevision: null },
        history,
      ),
    ProjectFoundationContractError,
  );
});

test("mutation responses match exact business input and do not implicitly confirm a proposal", () => {
  const base = {
    kind: "create-project",
    disposition: "committed",
    project,
    foundation: foundation(),
    brief,
    source: null,
    proposal: null,
  };
  const creation = request("createProject", inputs.createProject);
  assert.deepEqual(parseProjectFoundationUiResponse(base, creation), base);
  assert.throws(
    () =>
      parseProjectFoundationUiResponse(
        { ...base, project: { ...project, title: "other" } },
        creation,
      ),
    ProjectFoundationContractError,
  );
  const novelFoundation = {
    ...foundation(),
    origin: "novel",
    parameters: novel,
    creativeStartMode: null,
    source: { revision: 1, digest },
  };
  const novelCreation = request("createProject", {
    ...createInput,
    origin: "novel",
    parameters: novel,
    creativeStartMode: null,
    sourceUpload: upload,
  });
  assert.equal(
    parseProjectFoundationUiResponse(
      { ...base, foundation: novelFoundation, source },
      novelCreation,
    ).foundation.origin,
    "novel",
  );
  assert.throws(
    () =>
      parseProjectFoundationUiResponse(
        {
          ...base,
          foundation: novelFoundation,
          source: { ...source, fileDigest: digest },
        },
        novelCreation,
      ),
    ProjectFoundationContractError,
  );
  const saved = {
    ...base,
    kind: "save-proposal",
    brief: null,
    proposal: proposal(),
  };
  assert.equal(
    parseProjectFoundationUiResponse(
      saved,
      request("saveProposal", inputs.saveProposal),
    ).foundation.confirmedProposal,
    null,
  );
  assert.throws(
    () =>
      parseProjectFoundationUiResponse(
        { ...saved, proposal: { ...proposal(), text: "unrequested" } },
        request("saveProposal", inputs.saveProposal),
      ),
    ProjectFoundationContractError,
  );
  const confirmed = {
    ...saved,
    kind: "confirm-proposal",
    foundation: {
      ...foundation(),
      revision: 2,
      confirmedProposal: { revision: 1, digest },
    },
  };
  assert.equal(
    parseProjectFoundationUiResponse(
      confirmed,
      request("confirmProposal", inputs.confirmProposal),
    ).foundation.confirmedProposal?.revision,
    1,
  );
  assert.throws(
    () =>
      parseProjectFoundationUiResponse(
        {
          ...confirmed,
          foundation: {
            ...confirmed.foundation,
            source: { revision: 1, digest },
          },
        },
        request("confirmProposal", inputs.confirmProposal),
      ),
    ProjectFoundationContractError,
  );
});

test("parameter revision advances independently after multiple other foundation changes", () => {
  const parameters = { ...creative, episodeCount: 8 };
  const expected = request("updateParameters", {
    ...inputs.updateParameters,
    expectedFoundationRevision: 5,
    parameters,
  });
  const response = {
    kind: "update-parameters",
    disposition: "committed",
    project,
    foundation: {
      ...foundation(),
      revision: 6,
      parametersRevision: 2,
      parameters,
    },
    brief: null,
    source: null,
    proposal: null,
  };
  assert.equal(
    parseProjectFoundationUiResponse(response, expected).foundation
      .parametersRevision,
    2,
  );
});

test("first source is revision one and confirmation references the preceding foundation version", () => {
  const novelCreation = request("createProject", {
    ...createInput,
    origin: "novel",
    parameters: novel,
    creativeStartMode: null,
    sourceUpload: upload,
  });
  const invalidCreation = {
    kind: "create-project",
    disposition: "committed",
    project,
    brief,
    proposal: null,
    foundation: {
      ...foundation(),
      origin: "novel",
      parameters: novel,
      creativeStartMode: null,
      source: { revision: 4, digest },
    },
    source: { ...source, revision: 4 },
  };
  assert.throws(
    () => parseProjectFoundationUiResponse(invalidCreation, novelCreation),
    ProjectFoundationContractError,
  );
  const confirmation = {
    kind: "confirm-proposal",
    disposition: "committed",
    project,
    brief: null,
    source: null,
    foundation: {
      ...foundation(),
      revision: 2,
      confirmedProposal: { revision: 1, digest },
    },
    proposal: { ...proposal(), foundationRevision: 2 },
  };
  assert.throws(
    () =>
      parseProjectFoundationUiResponse(
        confirmation,
        request("confirmProposal", inputs.confirmProposal),
      ),
    ProjectFoundationContractError,
  );
  const replay = {
    ...confirmation,
    disposition: "replayed",
    proposal: proposal(),
  };
  assert.equal(
    parseProjectFoundationUiResponse(
      replay,
      request("confirmProposal", {
        ...inputs.confirmProposal,
        expectedFoundationRevision: 2,
      }),
    ).foundation.revision,
    2,
  );
});

test("bounded history page fits maximum escaped proposal text without truncation", () => {
  const text = "\\".repeat(8192);
  const expected = request("listProposals", {
    projectId: "p",
    afterProposalRevision: 0,
    limit: 3,
  });
  const proposals = [1, 2, 3].map((revision) => ({
    ...proposal(revision),
    text,
  }));
  const input = { proposals, nextRevision: 3 };
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < 60 * 1024);
  const result = parseProjectFoundationUiResponse(input, expected);
  assert.equal(result.proposals[2]!.text.length, 8192);
  assert.equal(result.nextRevision, 3);
  assert.throws(
    () =>
      parseProjectFoundationUiRequest(
        request("listProposals", { ...expected.input, limit: 4 }),
      ),
    ProjectFoundationContractError,
  );
});
