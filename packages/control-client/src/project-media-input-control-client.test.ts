import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";
import { parseSaveMediaInputRequest } from "@crewon/contracts/project-media-inputs";

const command = parseSaveMediaInputRequest({
  projectId: "project/雨夜",
  mediaInputId: null,
  expectedInputRevision: 0,
  item: { kind: "character-reference", assetId: "character" },
  briefRevision: 1,
  script: null,
  workflowId: "krea2-reference-four-view",
  configurationRevision: 1,
  prompt: "保持原人物。",
  references: {
    character: {
      projectId: "project/雨夜",
      assetId: "character",
      kind: "character",
      expectedAssetRevision: 4,
      contentRevision: 1,
      referenceRevision: 1,
    },
  },
  idempotencyKey: "original-confirmed-input-key",
});
const {
  expectedInputRevision: _,
  idempotencyKey: __,
  mediaInputId: ___,
  ...content
} = command;
const input = {
  ...content,
  mediaInputId: "input/一",
  inputRevision: 1,
  createdAt: "2026-10-06T00:00:00.000Z",
  contentDigest: "sha256:" + "a".repeat(64),
};
function client(
  fetch: typeof globalThis.fetch,
  csrfToken: string | null = "named-csrf",
) {
  return new ControlApiClient({
    baseUrl: "https://control.test",
    accessToken: "named-session",
    csrfToken,
    origin: "https://ui.test",
    fetch,
  });
}
test("options client reads bounded reviewed catalog using encoded project and original transport", async () => {
  let calls = 0;
  const c = client(async (url, init) => {
    calls++;
    assert.equal(
      String(url),
      `https://control.test/api/v1/creative-projects/${encodeURIComponent(command.projectId)}/media-input-options`,
    );
    assert.equal(init?.method, "GET");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer named-session",
    );
    assert.equal(init?.redirect, "manual");
    return Response.json({
      configuration: { revision: 3, workflows: ["krea2-reference-four-view"] },
    });
  });
  assert.deepEqual(
    await c.projectMediaInputs.getOptions({ projectId: command.projectId }),
    {
      configuration: { revision: 3, workflows: ["krea2-reference-four-view"] },
    },
  );
  await assert.rejects(
    c.projectMediaInputs.getOptions({
      projectId: command.projectId,
      packageDigest: "foreign",
    } as { projectId: string }),
    ControlApiProtocolError,
  );
  await assert.rejects(
    c.projectMediaInputs.getOptions(
      { projectId: command.projectId },
      { signal: AbortSignal.abort() },
    ),
    ControlApiProtocolError,
  );
  assert.equal(calls, 1);
  for (const value of [
    {
      configuration: { revision: 0, workflows: ["krea2-reference-four-view"] },
    },
    { configuration: { revision: 1, workflows: ["unreviewed"] } },
    { configuration: null, authority: true },
    {
      configuration: {
        revision: 1,
        workflows: ["krea2-reference-four-view", "krea2-reference-four-view"],
      },
    },
    { configuration: null, padding: "x".repeat(1024) },
  ])
    await assert.rejects(
      client(async () => Response.json(value)).projectMediaInputs.getOptions({
        projectId: command.projectId,
      }),
      ControlApiProtocolError,
    );
  assert.deepEqual(
    await client(async () =>
      Response.json({ configuration: null }),
    ).projectMediaInputs.getOptions({ projectId: command.projectId }),
    { configuration: null },
  );
});
test("shared media input client uses original headers, encoded path and a lazy bounded group", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const c = client(async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return Response.json(
      init!.method === "POST"
        ? { disposition: "committed", input }
        : { state: { input, latestInputRevision: 1 } },
    );
  });
  assert.equal(c.projectMediaInputs, c.projectMediaInputs);
  assert.equal(calls.length, 0);
  assert.deepEqual(
    (await c.projectMediaInputs.saveInput(command)).input,
    input,
  );
  const query = {
    projectId: command.projectId,
    mediaInputId: input.mediaInputId,
    inputRevision: 1,
  };
  assert.deepEqual(
    (await c.projectMediaInputs.loadInput(query)).state?.input,
    input,
  );
  assert.equal(
    calls[0]!.url,
    `https://control.test/api/v1/creative-projects/${encodeURIComponent(command.projectId)}/media-inputs`,
  );
  assert.equal(
    calls[1]!.url,
    `${calls[0]!.url}/${encodeURIComponent(input.mediaInputId)}?inputRevision=1`,
  );
  const headers = new Headers(calls[0]!.init.headers);
  for (const [name, value] of [
    ["authorization", "Bearer named-session"],
    ["x-csrf-token", "named-csrf"],
    ["origin", "https://ui.test"],
    ["idempotency-key", command.idempotencyKey],
  ])
    assert.equal(headers.get(name!), value);
  assert.equal(calls[0]!.init.credentials, "include");
  assert.equal(calls[0]!.init.redirect, "manual");
  const { projectId: p, idempotencyKey: key, ...body } = command;
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), body);
});
test("metadata client rejects authority, missing CSRF, cancelled request and bad response without retry", async () => {
  let calls = 0;
  const c = client(async () => {
    calls++;
    return Response.json({
      disposition: "committed",
      input: { ...input, prompt: "wrong-prompt" },
    });
  });
  await assert.rejects(
    c.projectMediaInputs.saveInput({
      ...command,
      target: {},
    } as typeof command),
    ControlApiProtocolError,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    client(async () => {
      calls++;
      return Response.json({});
    }, null).projectMediaInputs.saveInput(command),
    ControlApiProtocolError,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    c.projectMediaInputs.saveInput(command, { signal: AbortSignal.abort() }),
    ControlApiProtocolError,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    c.projectMediaInputs.saveInput(command),
    ControlApiProtocolError,
  );
  assert.equal(calls, 1);
  for (const value of [
    {
      state: {
        input: { ...input, projectId: "foreign" },
        latestInputRevision: 1,
      },
    },
    { state: { input, latestInputRevision: 2 } },
    { state: null, actorId: "foreign" },
  ]) {
    await assert.rejects(
      client(async () => Response.json(value)).projectMediaInputs.loadInput({
        projectId: command.projectId,
        mediaInputId: input.mediaInputId,
        inputRevision: null,
      }),
      ControlApiProtocolError,
    );
  }
});

test("list client encodes project/cursor, preserves authentication and rejects foreign or unbounded pages", async () => {
  let calls = 0;
  let foreign = false;
  const c = client(async (url, init) => {
    calls++;
    const parsed = new URL(String(url));
    assert.equal(
      parsed.pathname,
      `/api/v1/creative-projects/${encodeURIComponent(command.projectId)}/media-inputs`,
    );
    assert.equal(parsed.searchParams.get("afterMediaInputId"), "input/零 &+");
    assert.equal(parsed.searchParams.get("limit"), "1");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "manual");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer named-session",
    );
    return Response.json({
      inputs: [
        {
          projectId: foreign ? "foreign" : command.projectId,
          mediaInputId: "input/龟",
          latestInputRevision: 1,
          item: input.item,
          workflowId: input.workflowId,
          createdAt: input.createdAt,
        },
      ],
      nextMediaInputId: null,
    });
  }, null);
  const query = {
    projectId: command.projectId,
    afterMediaInputId: "input/零 &+",
    limit: 1,
  };
  const page = await c.projectMediaInputs.listInputs(query);
  assert.equal(page.inputs.length, 1);
  foreign = true;
  await assert.rejects(
    c.projectMediaInputs.listInputs(query),
    ControlApiProtocolError,
  );
  await assert.rejects(
    c.projectMediaInputs.listInputs({ ...query, limit: 17 }),
    ControlApiProtocolError,
  );
  assert.equal(calls, 2);
});
