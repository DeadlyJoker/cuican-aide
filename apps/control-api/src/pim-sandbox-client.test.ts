import assert from "node:assert/strict";
import test from "node:test";

import { PimThreadSandbox } from "./pim-sandbox-client.ts";

test("reads files and runs commands through the PIM Agent sandbox", async () => {
  const requests: Array<{ init: RequestInit; url: URL }> = [];
  const sandbox = new PimThreadSandbox({
    agentId: 111,
    baseUrl: "http://127.0.0.1:3000",
    username: "admin",
    password: "secret",
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      requests.push({ init, url });
      if (url.pathname === "/api/v1/auth/login") {
        return jsonResponse({ access_token: "pim-token" });
      }
      if (url.pathname.endsWith("/sandbox")) {
        return jsonResponse({ status: "running" });
      }
      const request = JSON.parse(String(init.body)) as {
        language: string;
        script_content: string;
      };
      if (request.script_content.includes("target.iterdir()")) {
        return executionResponse(
          JSON.stringify({
            path: "/workspace",
            entries: [
              {
                kind: "directory",
                name: "src",
                path: "/workspace/src",
                size: 64,
              },
              {
                kind: "file",
                name: "README.md",
                path: "/workspace/README.md",
                size: 18,
              },
            ],
            truncated: false,
          }),
        );
      }
      if (request.script_content.includes("target.read_bytes()")) {
        return executionResponse(
          JSON.stringify({
            path: "/workspace/README.md",
            content: Buffer.from("# CrewON sandbox\n").toString("base64"),
            byteLength: 18,
            truncated: false,
          }),
        );
      }
      if (request.script_content.includes("git diff")) {
        return executionResponse("diff --git a/src/task.ts b/src/task.ts\n");
      }
      const marker = request.script_content.match(
        /__CREWON_CWD_[a-f0-9]+__/u,
      )?.[0];
      assert.ok(marker);
      return executionResponse(`command output\n${marker}/workspace/src\n`);
    },
  });

  assert.deepEqual(await sandbox.listDirectory(), {
    root: "/workspace",
    path: "/workspace",
    entries: [
      {
        kind: "directory",
        name: "src",
        path: "/workspace/src",
        size: 64,
      },
      {
        kind: "file",
        name: "README.md",
        path: "/workspace/README.md",
        size: 18,
      },
    ],
    truncated: false,
  });
  assert.deepEqual(await sandbox.readFile("/workspace/README.md"), {
    path: "/workspace/README.md",
    content: "# CrewON sandbox\n",
    byteLength: 18,
    truncated: false,
  });
  assert.deepEqual(await sandbox.readDiff(), {
    cwd: "/workspace",
    diff: "diff --git a/src/task.ts b/src/task.ts\n",
  });
  assert.deepEqual(await sandbox.runCommand({ command: "cd src && pwd" }), {
    cwd: "/workspace/src",
    exitCode: 0,
    stderr: "",
    stdout: "command output",
  });

  assert.equal(
    requests.filter(({ url }) => url.pathname === "/api/v1/auth/login").length,
    1,
  );
  assert.equal(
    requests.filter(({ url }) => url.pathname.endsWith("/sandbox")).length,
    1,
  );
  for (const request of requests.slice(1)) {
    assert.equal(
      new Headers(request.init.headers).get("authorization"),
      "Bearer pim-token",
    );
  }
});

test("rejects paths outside /workspace before calling PIM", async () => {
  let called = false;
  const sandbox = new PimThreadSandbox({
    agentId: 111,
    baseUrl: "http://localhost:3000",
    username: "admin",
    password: "secret",
    fetch: async () => {
      called = true;
      return jsonResponse({});
    },
  });

  await assert.rejects(
    sandbox.readFile("/etc/passwd"),
    /pim_sandbox_path_invalid/u,
  );
  assert.equal(called, false);
});

function executionResponse(stdout: string): Response {
  return jsonResponse({ exit_code: 0, stdout, stderr: "" });
}

function jsonResponse(body: unknown): Response {
  return Response.json(body, { status: 200 });
}
