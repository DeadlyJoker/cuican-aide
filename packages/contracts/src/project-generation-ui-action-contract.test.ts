import assert from "node:assert/strict";
import test from "node:test";
import { ContractValidationError } from "./contract-validation-error.ts";
import {
  CREATIVE_PROJECT_UI_ACTIONS,
  CREWON_CREATIVE_PROJECTS_API_VERSION,
  CREWON_CREATIVE_PROJECTS_SERVICE,
  parseCreativeProjectUiActionRequest,
  parseCreativeProjectUiActionResponse,
} from "./creative-project-ui-action-contract.ts";
import { parseCreateExtensionTaskRequest } from "./extension-control-contract.ts";
import {
  CREWON_PROJECT_GENERATIONS_API_VERSION,
  CREWON_PROJECT_GENERATIONS_SERVICE,
  PROJECT_GENERATION_UI_ACTIONS,
  parseProjectGenerationUiActionRequest,
  parseProjectGenerationUiActionResponse,
  type ProjectGenerationUiAction,
  type ProjectGenerationUiActionRequest,
  type ProjectGenerationUiInput,
  type ProjectGenerationUiReceipt,
  type ProjectGenerationUiReference,
} from "./project-generation-ui-action-contract.ts";

const action: ProjectGenerationUiAction =
  "crewon.project-generations.v1.generateConcept";
const projectId = "project/中文 %2F\\末尾";
const assetId = "asset\\中文/%2F 输入";

function freshInput() {
  return {
    reference: {
      projectId,
      assetId,
      assetRevision: 2,
      expectedProjectRevision: 7,
      expectedAssetMetadataRevision: 3,
    },
    threadId: "thread/中文%2F",
    expectedThreadRevision: 4,
    idempotencyKey: "concept-generation-stable-key",
  };
}
function freshReceipt() {
  return {
    disposition: "committed" as const,
    threadId: freshInput().threadId,
    threadRevision: 5,
    runId: "run-中文%2F",
    messageId: "message/中文\\%",
    configurationRevision: 9,
  };
}
function request(input: unknown = freshInput()) {
  return parseProjectGenerationUiActionRequest({ action, input });
}
function rejects(work: () => unknown) {
  assert.throws(work, ContractValidationError);
}
function without(value: object, field: string): Record<string, unknown> {
  const copied: Record<string, unknown> = { ...value };
  delete copied[field];
  return copied;
}

test("one dedicated generation action accepts only saved identity and independent CAS values", () => {
  assert.equal(
    CREWON_PROJECT_GENERATIONS_SERVICE,
    "crewon.project-generations",
  );
  assert.equal(CREWON_PROJECT_GENERATIONS_API_VERSION, "1");
  assert.deepEqual(PROJECT_GENERATION_UI_ACTIONS, [action]);
  assert.ok(Object.isFrozen(PROJECT_GENERATION_UI_ACTIONS));
  const reference: ProjectGenerationUiReference = freshInput().reference;
  const input: ProjectGenerationUiInput = { ...freshInput(), reference };
  const checked: ProjectGenerationUiActionRequest = request(input);
  const receipt: ProjectGenerationUiReceipt =
    parseProjectGenerationUiActionResponse(checked, freshReceipt());
  assert.deepEqual(checked, { action, input });
  assert.deepEqual(receipt, freshReceipt());
  assert.equal(checked.input.reference.assetRevision, 2);
  assert.equal(checked.input.reference.expectedAssetMetadataRevision, 3);
  assert.equal(checked.input.reference.expectedProjectRevision, 7);
  assert.deepEqual(Object.keys(receipt), [
    "disposition",
    "threadId",
    "threadRevision",
    "runId",
    "messageId",
    "configurationRevision",
  ]);
});

test("request envelopes, inputs and references reject missing, extra and authority fields", () => {
  const input = freshInput();
  for (const field of ["action", "input"])
    rejects(() =>
      parseProjectGenerationUiActionRequest(without({ action, input }, field)),
    );
  for (const field of Object.keys(input))
    rejects(() => request(without(input, field)));
  for (const field of Object.keys(input.reference))
    rejects(() =>
      request({ ...input, reference: without(input.reference, field) }),
    );
  for (const field of [
    "actor",
    "actorId",
    "ownerPrincipalId",
    "tenantId",
    "spaceId",
    "payer",
    "profileId",
    "capability",
    "authority",
    "prompt",
    "target",
    "pluginId",
    "agentVersionId",
    "configurationRevision",
    "briefRevision",
    "input",
  ]) {
    rejects(() =>
      parseProjectGenerationUiActionRequest({
        action,
        input,
        [field]: "injected",
      }),
    );
    rejects(() => request({ ...input, [field]: "injected" }));
    rejects(() =>
      request({
        ...input,
        reference: { ...input.reference, [field]: "injected" },
      }),
    );
  }
  for (const wrongAction of [
    "generateConcept",
    "crewon.project-generations.v0.generateConcept",
    "crewon.project-generations.v2.generateConcept",
    "crewon.project-generations.v1.query",
    "crewon.project-generations.v1.getAccepted",
    "crewon.creative-projects.v1.generateConcept",
    "other.project-generations.v1.generateConcept",
    null,
  ])
    rejects(() =>
      parseProjectGenerationUiActionRequest({ action: wrongAction, input }),
    );
  for (const invalid of [null, undefined, [], "request", 1]) {
    rejects(() => parseProjectGenerationUiActionRequest(invalid));
    rejects(() =>
      parseProjectGenerationUiActionRequest({ action, input: invalid }),
    );
    rejects(() => request({ ...input, reference: invalid }));
  }
});

test("request and response snapshots are detached and deeply frozen for exact retries", () => {
  const source = freshInput();
  const original = freshInput();
  const checked = request(source);
  assert.notEqual(checked.input, source);
  assert.notEqual(checked.input.reference, source.reference);
  for (const snapshot of [checked, checked.input, checked.input.reference])
    assert.ok(Object.isFrozen(snapshot));
  source.reference.projectId = "changed-project";
  source.reference.assetRevision = 99;
  source.expectedThreadRevision = 99;
  source.idempotencyKey = "changed-key";
  assert.deepEqual(checked, { action, input: original });
  assert.equal(
    Reflect.set(checked.input.reference, "assetRevision", 99),
    false,
  );
  assert.equal(Reflect.set(checked.input, "idempotencyKey", "new-key"), false);
  const retry = parseProjectGenerationUiActionRequest(checked);
  assert.deepEqual(retry, checked);
  assert.notEqual(retry.input.reference, checked.input.reference);
  const rawReceipt = freshReceipt();
  const receipt = parseProjectGenerationUiActionResponse(checked, rawReceipt);
  rawReceipt.runId = "changed-run";
  rawReceipt.threadRevision = 99;
  assert.deepEqual(receipt, freshReceipt());
  assert.ok(Object.isFrozen(receipt));
  assert.equal(Reflect.set(receipt, "runId", "changed-run"), false);
});

test("descriptor validation never invokes accessors or serialization hooks at any boundary", () => {
  let calls = 0;
  const hook = () => {
    calls++;
    return "injected";
  };
  const raw = freshInput();
  const records = [
    {
      value: { action, input: raw },
      field: "input",
      parse: parseProjectGenerationUiActionRequest,
    },
    { value: raw, field: "threadId", parse: request },
    {
      value: raw.reference,
      field: "projectId",
      parse: (reference: unknown) => request({ ...freshInput(), reference }),
    },
    {
      value: freshReceipt(),
      field: "runId",
      parse: (output: unknown) =>
        parseProjectGenerationUiActionResponse(request(), output),
    },
  ];
  for (const { value, field, parse } of records) {
    const accessor = { ...value };
    Object.defineProperty(accessor, field, { enumerable: true, get: hook });
    rejects(() => parse(accessor));
    const nonEnumerable = { ...value };
    Object.defineProperty(nonEnumerable, field, { enumerable: false });
    rejects(() => parse(nonEnumerable));
    rejects(() =>
      parse(Object.assign(Object.create({ inherited: true }), value)),
    );
    rejects(() => parse({ ...value, [Symbol("hidden")]: true }));
    const hidden = { ...value };
    Object.defineProperty(hidden, "hidden", { value: true });
    rejects(() => parse(hidden));
    rejects(() => parse({ ...value, toJSON: hook }));
  }
  const input = Object.assign(Object.create(null), freshInput());
  input.reference = Object.assign(Object.create(null), raw.reference);
  const envelope = Object.assign(Object.create(null), { action, input });
  assert.deepEqual(parseProjectGenerationUiActionRequest(envelope), request());
  const receipt = Object.assign(Object.create(null), freshReceipt());
  assert.deepEqual(
    parseProjectGenerationUiActionResponse(request(), receipt),
    freshReceipt(),
  );
  assert.equal(calls, 0);
});

test("saved revisions are positive numeric safe integers without coercion or INT32 truncation", () => {
  const invalid = [
    "2",
    "02",
    0,
    -0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    null,
    true,
    2n,
    new Number(2),
  ];
  for (const field of [
    "assetRevision",
    "expectedProjectRevision",
    "expectedAssetMetadataRevision",
  ])
    for (const value of invalid)
      rejects(() =>
        request({
          ...freshInput(),
          reference: { ...freshInput().reference, [field]: value },
        }),
      );
  for (const value of [...invalid, Number.MAX_SAFE_INTEGER])
    rejects(() => request({ ...freshInput(), expectedThreadRevision: value }));
  const input = {
    ...freshInput(),
    reference: {
      ...freshInput().reference,
      assetRevision: Number.MAX_SAFE_INTEGER,
      expectedProjectRevision: Number.MAX_SAFE_INTEGER,
      expectedAssetMetadataRevision: 2_147_483_648,
    },
    expectedThreadRevision: Number.MAX_SAFE_INTEGER - 1,
  };
  const checked = request(input);
  assert.deepEqual(checked.input, input);
  assert.equal(
    parseProjectGenerationUiActionResponse(checked, {
      ...freshReceipt(),
      threadRevision: Number.MAX_SAFE_INTEGER,
      configurationRevision: 2_147_483_647,
    }).threadRevision,
    Number.MAX_SAFE_INTEGER,
  );
});

test("opaque project and asset IDs retain metadata UTF-16 bounds and exact Unicode identity", () => {
  for (const id of [
    projectId,
    assetId,
    "中".repeat(128),
    "😀".repeat(64),
    "a".repeat(128),
    "a/b\\c%2F d",
  ]) {
    const checked = request({
      ...freshInput(),
      reference: { ...freshInput().reference, projectId: id, assetId: id },
    });
    assert.equal(checked.input.reference.projectId, id);
    assert.equal(checked.input.reference.assetId, id);
  }
  for (const id of [
    "",
    ".",
    "..",
    " leading",
    "trailing ",
    "a\nb",
    "a\u0000b",
    "a\u007fb",
    "\ud800",
    "\udc00",
    "a\ud800b",
    "a".repeat(129),
    "😀".repeat(65),
  ])
    for (const field of ["projectId", "assetId"])
      rejects(() =>
        request({
          ...freshInput(),
          reference: { ...freshInput().reference, [field]: id },
        }),
      );
});

test("thread, key and message IDs retain original task UTF-8 limits while run IDs forbid paths", () => {
  for (const id of [
    "a".repeat(128),
    "😀".repeat(32),
    "中".repeat(42) + "ab",
    "opaque/a\\b%2F c",
  ]) {
    const checked = request({
      ...freshInput(),
      threadId: id,
      idempotencyKey: id,
    });
    assert.equal(checked.input.threadId, id);
    assert.equal(checked.input.idempotencyKey, id);
    assert.equal(
      parseProjectGenerationUiActionResponse(checked, {
        ...freshReceipt(),
        threadId: id,
        messageId: id,
      }).messageId,
      id,
    );
  }
  const invalid = [
    "",
    " leading",
    "trailing ",
    "a\nb",
    "a\u0000b",
    "a\u007fb",
    "\ud800",
    "\udc00",
    "a".repeat(129),
    "😀".repeat(33),
    "中".repeat(43),
  ];
  for (const id of invalid) {
    for (const field of ["threadId", "idempotencyKey"])
      rejects(() => request({ ...freshInput(), [field]: id }));
    for (const field of ["threadId", "messageId", "runId"])
      rejects(() =>
        parseProjectGenerationUiActionResponse(request(), {
          ...freshReceipt(),
          [field]: id,
        }),
      );
  }
  for (const runId of [".", "..", "path/run", "path\\run"])
    rejects(() =>
      parseProjectGenerationUiActionResponse(request(), {
        ...freshReceipt(),
        runId,
      }),
    );
  assert.equal(
    parseProjectGenerationUiActionResponse(request(), {
      ...freshReceipt(),
      runId: "opaque%2F中文",
    }).runId,
    "opaque%2F中文",
  );
});

test("JSON copying enforces the 24 KiB encoded budget before field validation", () => {
  for (const oversized of [
    "a".repeat(24 * 1024),
    "\\".repeat(12 * 1024),
    "中".repeat(8192),
  ]) {
    assert.throws(
      () => request({ ...freshInput(), idempotencyKey: oversized }),
      (error: unknown) =>
        error instanceof ContractValidationError &&
        error.code === "plugin_ui_json_bytes_exceeded",
    );
    assert.throws(
      () =>
        parseProjectGenerationUiActionResponse(request(), {
          ...freshReceipt(),
          messageId: oversized,
        }),
      (error: unknown) =>
        error instanceof ContractValidationError &&
        error.code === "plugin_ui_json_bytes_exceeded",
    );
  }
  const cyclic: Record<string, unknown> = { ...freshInput() };
  cyclic.extra = cyclic;
  rejects(() => request(cyclic));
  let nested: unknown = "leaf";
  for (let depth = 0; depth < 18; depth++) nested = { nested };
  rejects(() => request({ ...freshInput(), extra: nested }));
  const sparse: unknown[] = [];
  sparse.length = 1;
  rejects(() => request({ ...freshInput(), reference: sparse }));
});

test("committed and replayed receipts preserve exact thread identity and original next revision", () => {
  const checked = request();
  for (const disposition of ["committed", "replayed"] as const) {
    const receipt = { ...freshReceipt(), disposition };
    assert.deepEqual(
      parseProjectGenerationUiActionResponse(checked, receipt),
      receipt,
    );
    rejects(() =>
      parseProjectGenerationUiActionResponse(checked, {
        ...receipt,
        threadId: "other-thread",
      }),
    );
    for (const threadRevision of [
      4,
      6,
      "5",
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      rejects(() =>
        parseProjectGenerationUiActionResponse(checked, {
          ...receipt,
          threadRevision,
        }),
      );
    for (const configurationRevision of [
      "9",
      0,
      -1,
      1.5,
      2_147_483_648,
      Number.MAX_SAFE_INTEGER,
      null,
    ])
      rejects(() =>
        parseProjectGenerationUiActionResponse(checked, {
          ...receipt,
          configurationRevision,
        }),
      );
  }
  for (const disposition of [
    "unknown",
    "unknownOutcome",
    "succeeded",
    "no-op",
    false,
    null,
  ])
    rejects(() =>
      parseProjectGenerationUiActionResponse(checked, {
        ...freshReceipt(),
        disposition,
      }),
    );
});

test("receipts remain exactly six fields and revalidate caller-supplied expectations", () => {
  const checked = request();
  for (const field of Object.keys(freshReceipt()))
    rejects(() =>
      parseProjectGenerationUiActionResponse(
        checked,
        without(freshReceipt(), field),
      ),
    );
  for (const field of [
    "reference",
    "projectId",
    "assetId",
    "actorId",
    "result",
    "operationId",
    "receipt",
    "target",
    "prompt",
    "inputDigest",
  ])
    rejects(() =>
      parseProjectGenerationUiActionResponse(checked, {
        ...freshReceipt(),
        [field]: "injected",
      }),
    );
  for (const output of [null, undefined, [], "receipt", 1])
    rejects(() => parseProjectGenerationUiActionResponse(checked, output));
  const forged = {
    ...checked,
    input: {
      ...checked.input,
      reference: { ...checked.input.reference, assetRevision: "2" },
    },
  } as unknown as ProjectGenerationUiActionRequest;
  rejects(() => parseProjectGenerationUiActionResponse(forged, freshReceipt()));
  const unknownAction = {
    ...checked,
    action: "crewon.creative-projects.v1.generateConcept",
  } as unknown as ProjectGenerationUiActionRequest;
  rejects(() =>
    parseProjectGenerationUiActionResponse(unknownAction, freshReceipt()),
  );
});

test("the fourteen metadata actions and original v0 task shape stay independent", () => {
  assert.equal(CREWON_CREATIVE_PROJECTS_SERVICE, "crewon.creative-projects");
  assert.equal(CREWON_CREATIVE_PROJECTS_API_VERSION, "1");
  assert.deepEqual(
    CREATIVE_PROJECT_UI_ACTIONS,
    [
      "listProjects",
      "getProject",
      "createProject",
      "renameProject",
      "setProjectState",
      "appendBrief",
      "getBrief",
      "listBriefs",
      "createConcept",
      "getConceptAsset",
      "listConceptAssets",
      "appendConceptRevision",
      "getConceptRevision",
      "listConceptRevisions",
    ].map((method) => `crewon.creative-projects.v1.${method}`),
  );
  rejects(() =>
    parseCreativeProjectUiActionRequest({ action, input: freshInput() }),
  );
  const prompt = " 已保存提示词\n窗边 ";
  const metadataInput = {
    projectId,
    request: {
      name: "概念",
      briefRevision: 1,
      prompt,
      expectedProjectRevision: 7,
    },
    idempotencyKey: "metadata-key",
  };
  const checked = parseCreativeProjectUiActionRequest({
    action: "crewon.creative-projects.v1.createConcept",
    input: metadataInput,
  });
  assert.deepEqual(checked.input, metadataInput);
  const at = "2026-10-03T00:00:00.000Z";
  const digest = `sha256:${"a".repeat(64)}`;
  const output = {
    disposition: "committed",
    project: {
      projectId,
      kind: "short-drama",
      title: "短剧",
      revision: 8,
      state: "active",
      latestBriefRevision: 1,
      createdAt: at,
      updatedAt: at,
    },
    asset: {
      projectId,
      assetId,
      name: "概念",
      revision: 1,
      latestAssetRevision: 1,
      createdAt: at,
      updatedAt: at,
    },
    assetRevision: {
      projectId,
      assetId,
      assetRevision: 1,
      briefRevision: 1,
      briefContentDigest: digest,
      prompt,
      contentDigest: digest,
      createdAt: at,
    },
  };
  assert.deepEqual(
    parseCreativeProjectUiActionResponse(checked, output),
    output,
  );
  const oldTask = {
    threadId: "legacy-thread",
    expectedThreadRevision: 2_147_483_648,
    intent: { kind: "generate", input: { prompt } },
  };
  assert.deepEqual(parseCreateExtensionTaskRequest(oldTask), oldTask);
  rejects(() => request(oldTask));
  rejects(() => parseCreateExtensionTaskRequest(freshInput()));
});
