import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedCreativeProjectProxyRequest,
  creativeProjectProxyPolicy,
  CREATIVE_PROJECT_PROXY_RESPONSE_MAX_BYTES,
} from "./creative-project-proxy-policy.ts";
import { createWebBff } from "./web-bff.ts";

const root = "/api/v1/creative-projects/project-1/text-artifacts";
function policy(path: string, method = "GET") {
  const offset = path.indexOf("?");
  return creativeProjectProxyPolicy({
    pathname: offset < 0 ? path : path.slice(0, offset),
    search: offset < 0 ? "" : path.slice(offset),
    method,
  });
}
const allowed = {
  outcome: "allow",
  responseMaxBytes: CREATIVE_PROJECT_PROXY_RESPONSE_MAX_BYTES,
};
const imported = {
  expectedArtifactRevision: 0,
  briefRevision: 1,
  outline: null,
  content: {
    title: "导入第一集",
    scenes: [
      {
        sceneId: "scene-1",
        location: "工作室",
        timeOfDay: "夜",
        action: "拿起旧画。",
        dialogue: [],
      },
    ],
  },
};

test("text proxy declares exact methods and preserves opaque artifact and episode IDs", () => {
  for (const [path, method] of [
    [root, "GET"],
    [`${root}/outline`, "GET"],
    [`${root}/outline/candidates`, "POST"],
    [`${root}/scripts/${encodeURIComponent("集/百分%")}`, "GET"],
    [`${root}/scripts/episode-1/candidates`, "POST"],
    [`${root}/items/outline`, "GET"],
    [`${root}/items/scripts/revisions`, "GET"],
    [`${root}/items/${encodeURIComponent("成果/百分%")}/revisions/1`, "GET"],
    [`${root}/items/artifact-1/selection`, "PUT"],
    [`${root}/items/artifact-1/lock`, "PUT"],
  ]) {
    assert.deepEqual(policy(path!, method), allowed);
    assert.deepEqual(policy(path!, "DELETE"), {
      outcome: "deny",
      status: 405,
      code: "method_not_allowed",
    });
  }
  assert.deepEqual(policy(`${root}?limit=16&afterArtifactId=outline`), allowed);
  assert.deepEqual(
    policy(`${root}/items/outline/revisions?afterContentRevision=0&limit=16`),
    allowed,
  );
  for (const path of [
    `${root}/anything`,
    `${root}/items`,
    `${root}/items/a/revisions/0`,
    `${root}/items/a/revisions/01`,
    `${root}/scripts/ep/candidates/extra`,
    `${root}/items/a/selection/extra`,
    `${root}/scripts/%ZZ`,
    `${root}/items/%2e%2e`,
  ])
    assert.deepEqual(policy(path), {
      outcome: "deny",
      status: 404,
      code: "route_not_found",
    });
  for (const path of [
    `${root}?limit=17`,
    `${root}?limit=1&limit=2`,
    `${root}?principalId=forged`,
    `${root}/outline?afterArtifactId=x`,
    `${root}/items/a/revisions?afterContentRevision=-1`,
    `${root}/items/a/revisions?afterContentRevision=0&limit=17`,
  ])
    assert.deepEqual(policy(path), {
      outcome: "deny",
      status: 400,
      code: "creative_project_query_invalid",
    });
  assert.deepEqual(policy(`${root}/outline/candidates?limit=1`, "POST"), {
    outcome: "deny",
    status: 400,
    code: "creative_project_query_invalid",
  });
});

test("text proxy checks new write DTOs, including explicit imported script source", async () => {
  const signal = new AbortController().signal;
  const request = (path: string, body: unknown, method = "POST") =>
    new Request(`https://text-bff.example.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "idempotency-key": "text-once",
      },
      body: JSON.stringify(body),
    });
  const bytes = await boundedCreativeProjectProxyRequest(
    request(`${root}/scripts/episode-1/candidates`, imported),
    signal,
  );
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes!)), imported);
  for (const body of [
    { ...imported, principalId: "forged" },
    { ...imported, outline: undefined },
    { ...imported, expectedArtifactRevision: -1 },
    { ...imported, content: { ...imported.content, scenes: [] } },
  ])
    await assert.rejects(
      boundedCreativeProjectProxyRequest(
        request(`${root}/scripts/episode-1/candidates`, body),
        signal,
      ),
      /creative_project_request_invalid/u,
    );
  await boundedCreativeProjectProxyRequest(
    request(
      `${root}/items/outline/selection`,
      { expectedArtifactRevision: 2, contentRevision: 1 },
      "PUT",
    ),
    signal,
  );
  await boundedCreativeProjectProxyRequest(
    request(
      `${root}/items/outline/lock`,
      { expectedArtifactRevision: 3, locked: true },
      "PUT",
    ),
    signal,
  );
  await assert.rejects(
    boundedCreativeProjectProxyRequest(
      request(
        `${root}/items/outline/lock`,
        { expectedArtifactRevision: 3, locked: "true" },
        "PUT",
      ),
      signal,
    ),
    /creative_project_request_invalid/u,
  );
});

test("authenticated BFF transports text commands once and rejects forged identity before upstream", async () => {
  const origin = "https://text-bff.example.test";
  const calls: {
    url: string;
    method: string;
    identity: string | null;
    body: unknown;
  }[] = [];
  const app = createWebBff({
    publicOrigin: origin,
    controlTarget: "http://127.0.0.1:3210",
    controlBffToken: "text-bff-service-token-at-least-32-characters",
    controlCsrfToken: "text-control-csrf-token-at-least-32-characters",
    csrfSecret: "text-browser-csrf-secret-at-least-32-characters",
    identity: {
      resolve: async ({ cookie }) =>
        cookie === "text-session"
          ? {
              sessionId: "text-browser-session-at-least-32-characters",
              expiresAt: "2030-01-01T00:00:00.000Z",
              controlAccessToken:
                "text-control-identity-at-least-32-characters",
            }
          : null,
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push({
        url: request.url,
        method: request.method,
        identity: request.headers.get("authorization"),
        body: await request.json(),
      });
      return Response.json({ accepted: true });
    },
  });
  const session = await app.handle(
    new Request(`${origin}/control-api/session`, {
      headers: { cookie: "text-session" },
    }),
  );
  const { csrfToken } = (await session.json()) as { csrfToken: string };
  const write = (body: unknown) =>
    new Request(`${origin}${root}/scripts/episode-1/candidates`, {
      method: "POST",
      headers: {
        "cookie": "text-session",
        origin,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
        "idempotency-key": "text-once",
        "authorization": "Bearer forged-caller",
      },
      body: JSON.stringify(body),
    });
  assert.equal((await app.handle(write(imported))).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.url,
    `http://127.0.0.1:3210${root}/scripts/episode-1/candidates`,
  );
  assert.equal(calls[0]!.method, "POST");
  assert.equal(
    calls[0]!.identity,
    "Bearer text-control-identity-at-least-32-characters",
  );
  assert.deepEqual(calls[0]!.body, imported);
  assert.equal(
    (await app.handle(write({ ...imported, ownerPrincipalId: "forged" })))
      .status,
    400,
  );
  assert.equal(calls.length, 1);
});
