import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  PimSandboxMutationOutcomeUnknownError,
  PimThreadSandbox,
} from "./pim-sandbox-client.ts";

const execFileAsync = promisify(execFile);

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
      if (request.script_content.includes("diffBase64")) {
        return executionResponse(
          JSON.stringify({
            isGitRepository: true,
            branch: "main",
            head: "a".repeat(40),
            changedFiles: 1,
            additions: 2,
            deletions: 1,
            statsComplete: true,
            diffTruncated: false,
            diffBase64: Buffer.from(
              "diff --git a/src/task.ts b/src/task.ts\n",
            ).toString("base64"),
          }),
        );
      }
      if (request.script_content.includes("include_diff = False")) {
        return executionResponse(
          JSON.stringify({
            isGitRepository: true,
            branch: "main",
            head: "a".repeat(40),
            changedFiles: 1,
            additions: 2,
            deletions: 1,
            statsComplete: true,
          }),
        );
      }
      if (
        request.script_content.includes("def summarize(before, after, env):")
      ) {
        return executionResponse(
          JSON.stringify({
            cwd: "/workspace/src",
            exitCode: 0,
            stdoutBase64: Buffer.from("tracked output\n").toString("base64"),
            stdoutTruncated: false,
            stderrBase64: "",
            stderrTruncated: false,
            workspaceChanges: {
              schemaVersion: "crewon.workspace-change-summary.v0",
              paths: ["src/task.ts"],
              additions: 4,
              deletions: 2,
              statsComplete: true,
            },
          }),
        );
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
  assert.deepEqual(await sandbox.readGitSummary(), {
    cwd: "/workspace",
    isGitRepository: true,
    branch: "main",
    head: "a".repeat(40),
    changedFiles: 1,
    additions: 2,
    deletions: 1,
    statsComplete: true,
  });
  assert.deepEqual(await sandbox.readDiff(), {
    cwd: "/workspace",
    diff: "diff --git a/src/task.ts b/src/task.ts\n",
    isGitRepository: true,
    branch: "main",
    head: "a".repeat(40),
    changedFiles: 1,
    additions: 2,
    deletions: 1,
    statsComplete: true,
    diffTruncated: false,
  });
  assert.deepEqual(await sandbox.runCommand({ command: "cd src && pwd" }), {
    cwd: "/workspace/src",
    exitCode: 0,
    stderr: "",
    stdout: "command output",
  });
  assert.deepEqual(
    await sandbox.runTrackedCommand({ command: "cd src && touch task.ts" }),
    {
      command: {
        cwd: "/workspace/src",
        exitCode: 0,
        stderr: "",
        stdout: "tracked output\n",
      },
      workspaceChanges: {
        schemaVersion: "crewon.workspace-change-summary.v0",
        paths: ["src/task.ts"],
        additions: 4,
        deletions: 2,
        statsComplete: true,
      },
    },
  );

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
  const diffRequest = requests
    .map(({ init }) => {
      try {
        return JSON.parse(String(init.body)) as { script_content?: string };
      } catch {
        return {};
      }
    })
    .find(({ script_content }) => script_content?.includes("diffBase64"));
  assert.match(diffRequest?.script_content ?? "", /symbolic-ref/u);
  assert.match(diffRequest?.script_content ?? "", /--cached/u);
  assert.match(diffRequest?.script_content ?? "", /--no-index/u);
  assert.match(diffRequest?.script_content ?? "", /--shortstat/u);
  assert.match(diffRequest?.script_content ?? "", /ls-files/u);
  const summaryRequest = requests
    .map(({ init }) => {
      try {
        return JSON.parse(String(init.body)) as { script_content?: string };
      } catch {
        return {};
      }
    })
    .find(({ script_content }) =>
      script_content?.includes("include_diff = False"),
    );
  assert.match(summaryRequest?.script_content ?? "", /--shortstat/u);
  assert.doesNotMatch(summaryRequest?.script_content ?? "", /diffBase64/u);
  assert.doesNotMatch(
    summaryRequest?.script_content ?? "",
    /base64\.b64encode/u,
  );
  const trackedRequest = requests
    .map(({ init }) => {
      try {
        return JSON.parse(String(init.body)) as {
          language?: string;
          script_content?: string;
        };
      } catch {
        return {};
      }
    })
    .find(({ script_content }) =>
      script_content?.includes("def summarize(before, after, env):"),
    );
  assert.equal(trackedRequest?.language, "python");
  assert.match(trackedRequest?.script_content ?? "", /GIT_INDEX_FILE/u);
  assert.match(trackedRequest?.script_content ?? "", /--numstat/u);
  assert.match(trackedRequest?.script_content ?? "", /--no-renames/u);
  assert.match(trackedRequest?.script_content ?? "", /statsComplete/u);
  assert.match(trackedRequest?.script_content ?? "", /max_summary = 16384/u);
  assert.match(trackedRequest?.script_content ?? "", /utf-16-be/u);
  assert.match(trackedRequest?.script_content ?? "", /ensure_ascii=False/u);
  assert.match(
    trackedRequest?.script_content ?? "",
    /selectors\.DefaultSelector/u,
  );
  assert.match(trackedRequest?.script_content ?? "", /os\.open\(root/u);
  assert.match(trackedRequest?.script_content ?? "", /libc\.prctl\(36, 1/u);
  assert.match(trackedRequest?.script_content ?? "", /terminate_descendants/u);
  assert.doesNotMatch(
    trackedRequest?.script_content ?? "",
    /TemporaryFile|workspace-change-ledger\.lock/u,
  );
  assert.match(
    trackedRequest?.script_content ?? "",
    /parts\[0\] == b'-' and parts\[1\] == b'-'/u,
  );
});

test("rejects malformed PIM Git metadata", async () => {
  const sandbox = new PimThreadSandbox({
    agentId: 111,
    baseUrl: "http://127.0.0.1:3000",
    username: "admin",
    password: "secret",
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/auth/login") {
        return jsonResponse({ access_token: "pim-token" });
      }
      if (url.pathname.endsWith("/sandbox")) {
        return jsonResponse({ status: "running" });
      }
      return executionResponse(
        JSON.stringify({
          isGitRepository: true,
          branch: "main\nforged",
          head: "not-a-commit",
          diffBase64: "%%%",
        }),
      );
    },
  });

  await assert.rejects(sandbox.readDiff(), /pim_sandbox_diff_invalid/u);
});

test("returns an explicit non-repository PIM state", async () => {
  let includeDiff = true;
  const sandbox = new PimThreadSandbox({
    agentId: 111,
    baseUrl: "http://127.0.0.1:3000",
    username: "admin",
    password: "secret",
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/auth/login") {
        return jsonResponse({ access_token: "pim-token" });
      }
      if (url.pathname.endsWith("/sandbox")) {
        return jsonResponse({ status: "running" });
      }
      return executionResponse(
        JSON.stringify({
          isGitRepository: false,
          branch: null,
          head: null,
          changedFiles: 0,
          additions: 0,
          deletions: 0,
          statsComplete: false,
          ...(includeDiff ? { diffTruncated: false, diffBase64: "" } : {}),
        }),
      );
    },
  });

  includeDiff = false;
  assert.deepEqual(await sandbox.readGitSummary(), {
    cwd: "/workspace",
    isGitRepository: false,
    branch: null,
    head: null,
    changedFiles: 0,
    additions: 0,
    deletions: 0,
    statsComplete: false,
  });
  includeDiff = true;
  assert.deepEqual(await sandbox.readDiff(), {
    cwd: "/workspace",
    diff: "",
    isGitRepository: false,
    branch: null,
    head: null,
    changedFiles: 0,
    additions: 0,
    deletions: 0,
    statsComplete: false,
    diffTruncated: false,
  });
});

test("returns large PIM Git statistics without transferring a raw diff", async () => {
  let scriptContent = "";
  const sandbox = new PimThreadSandbox({
    agentId: 111,
    baseUrl: "http://127.0.0.1:3000",
    username: "admin",
    password: "secret",
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/auth/login") {
        return jsonResponse({ access_token: "pim-token" });
      }
      if (url.pathname.endsWith("/sandbox")) {
        return jsonResponse({ status: "running" });
      }
      const request = JSON.parse(String(init.body)) as {
        script_content: string;
      };
      scriptContent = request.script_content;
      return executionResponse(
        JSON.stringify({
          isGitRepository: true,
          branch: "main",
          head: "a".repeat(40),
          changedFiles: 4_998,
          additions: 23_543,
          deletions: 1_211_211,
          statsComplete: true,
        }),
      );
    },
  });

  const summary = await sandbox.readGitSummary();

  assert.deepEqual(summary, {
    cwd: "/workspace",
    isGitRepository: true,
    branch: "main",
    head: "a".repeat(40),
    changedFiles: 4_998,
    additions: 23_543,
    deletions: 1_211_211,
    statsComplete: true,
  });
  assert.equal("diff" in summary, false);
  assert.doesNotMatch(scriptContent, /diffBase64|base64\.b64encode/u);
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

test("tracks text and binary Git-visible edits with an isolated index", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "crewon-tracked-command-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".crewon"), { recursive: true });
  writeFileSync(join(root, "src/text.txt"), "before\n");
  writeFileSync(join(root, ".crewon/private.txt"), "before\n");
  git(root, "init");
  git(root, "config", "user.email", "test@crewon.local");
  git(root, "config", "user.name", "CrewON Test");
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");

  const sandbox = localScriptSandbox(root);
  const tracked = await sandbox.runTrackedCommand({
    command:
      "printf 'after\\nmore\\n' > src/text.txt; printf '\\000\\001' > src/image.bin; printf hidden > .crewon/private.txt; python3 -c \"import sys; sys.stdout.write('x'*30000); sys.stderr.write('y'*30000)\"",
    timeoutSeconds: 10,
  });

  assert.deepEqual(tracked.workspaceChanges, {
    schemaVersion: "crewon.workspace-change-summary.v0",
    paths: ["src/image.bin", "src/text.txt"],
    additions: 2,
    deletions: 1,
    statsComplete: true,
  });
  assert.equal(tracked.command.stdout.startsWith("x".repeat(24 * 1024)), true);
  assert.equal(tracked.command.stderr.startsWith("y".repeat(24 * 1024)), true);
  assert.match(
    tracked.command.stdout,
    /\[stdout output truncated after 24576 bytes\]$/u,
  );
  assert.match(
    tracked.command.stderr,
    /\[stderr output truncated after 24576 bytes\]$/u,
  );
  assert.equal(git(root, "diff", "--cached", "--name-only"), "");
});

test("attributes only this command while preserving pre-existing index and worktree changes", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "crewon-tracked-existing-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "staged.txt"), "baseline\n");
  writeFileSync(join(root, "unstaged.txt"), "baseline\n");
  git(root, "init");
  git(root, "config", "user.email", "test@crewon.local");
  git(root, "config", "user.name", "CrewON Test");
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  writeFileSync(join(root, "staged.txt"), "already staged\n");
  git(root, "add", "staged.txt");
  writeFileSync(join(root, "unstaged.txt"), "already dirty\n");
  const cachedBefore = execFileSync("git", ["diff", "--cached", "--binary"], {
    cwd: root,
  });
  const worktreeBefore = execFileSync("git", ["diff", "--binary"], {
    cwd: root,
  });

  const tracked = await localScriptSandbox(root).runTrackedCommand({
    command: "printf 'created\\n' > command-only.txt",
    timeoutSeconds: 10,
  });

  assert.deepEqual(tracked.workspaceChanges, {
    schemaVersion: "crewon.workspace-change-summary.v0",
    paths: ["command-only.txt"],
    additions: 1,
    deletions: 0,
    statsComplete: true,
  });
  assert.deepEqual(
    execFileSync("git", ["diff", "--cached", "--binary"], { cwd: root }),
    cachedBefore,
  );
  assert.deepEqual(
    execFileSync("git", ["diff", "--binary"], { cwd: root }),
    worktreeBefore,
  );
});

test("retains edits made by a command that exits nonzero", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "crewon-tracked-nonzero-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init");
  git(root, "config", "user.email", "test@crewon.local");
  git(root, "config", "user.name", "CrewON Test");
  writeFileSync(join(root, "baseline.txt"), "baseline\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");

  const tracked = await localScriptSandbox(root).runTrackedCommand({
    command: "printf 'written\\n' > failed.txt; exit 7",
    timeoutSeconds: 10,
  });

  assert.equal(tracked.command.exitCode, 7);
  assert.deepEqual(tracked.workspaceChanges, {
    schemaVersion: "crewon.workspace-change-summary.v0",
    paths: ["failed.txt"],
    additions: 1,
    deletions: 0,
    statsComplete: true,
  });
});

test("aborts the in-flight PIM request and leaves the mutation outcome unknown", async () => {
  const controller = new AbortController();
  let executionSignal: AbortSignal | null = null;
  const sandbox = new PimThreadSandbox({
    agentId: 111,
    baseUrl: "http://127.0.0.1:3000",
    username: "admin",
    password: "secret",
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/auth/login") {
        return jsonResponse({ access_token: "pim-token" });
      }
      if (url.pathname.endsWith("/sandbox")) {
        return jsonResponse({ status: "running" });
      }
      executionSignal = init.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    },
  });

  const running = sandbox.runTrackedCommand(
    { command: "sleep 60" },
    controller.signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new Error("stop requested"));

  await assert.rejects(running, /stop requested/u);
  assert.equal((executionSignal as AbortSignal | null)?.aborted, true);
});

test("lets a later caller abort sandbox initialization without stopping the first caller", async () => {
  const fixture = sandboxInitializationFixture();
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = fixture.sandbox.runCommand(
    { command: "printf first" },
    firstController.signal,
  );
  await waitFor(() => fixture.sandboxRequests === 1);
  const second = fixture.sandbox.runCommand(
    { command: "printf second" },
    secondController.signal,
  );
  const secondOutcome = settled(second);

  secondController.abort(new Error("second stopped"));
  const beforeInitialization = await settlesPromptly(secondOutcome);
  fixture.releaseInitialization();

  assert.equal(beforeInitialization?.status, "rejected");
  assert.match(String(beforeInitialization?.reason), /second stopped/u);
  assert.equal((await settled(first)).status, "fulfilled");
  assert.equal(fixture.sandboxRequests, 1);
  assert.equal(fixture.executionRequests, 1);
});

test("does not let the first caller abort shared sandbox initialization for a later caller", async () => {
  const fixture = sandboxInitializationFixture();
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = fixture.sandbox.runCommand(
    { command: "printf first" },
    firstController.signal,
  );
  const firstOutcome = settled(first);
  await waitFor(() => fixture.sandboxRequests === 1);
  const second = fixture.sandbox.runCommand(
    { command: "printf second" },
    secondController.signal,
  );
  const secondOutcome = settled(second);

  firstController.abort(new Error("first stopped"));
  const beforeInitialization = await settlesPromptly(firstOutcome);
  fixture.releaseInitialization();

  assert.equal(beforeInitialization?.status, "rejected");
  assert.match(String(beforeInitialization?.reason), /first stopped/u);
  assert.equal((await secondOutcome).status, "fulfilled");
  assert.equal(fixture.sandboxRequests, 1);
  assert.equal(fixture.executionRequests, 1);
});

test("bounds authentication and execution response bodies", async () => {
  const oversizedLogin = new PimThreadSandbox({
    agentId: 111,
    baseUrl: "http://127.0.0.1:3000",
    username: "admin",
    password: "secret",
    fetch: async () => streamedResponse("x".repeat(17 * 1024)),
  });
  await assert.rejects(
    oversizedLogin.readGitSummary(),
    /pim_sandbox_login_response_too_large/u,
  );

  const oversizedExecution = new PimThreadSandbox({
    agentId: 111,
    baseUrl: "http://127.0.0.1:3000",
    username: "admin",
    password: "secret",
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/auth/login") {
        return jsonResponse({ access_token: "pim-token" });
      }
      if (url.pathname.endsWith("/sandbox")) {
        return jsonResponse({ status: "running" });
      }
      return streamedResponse("x".repeat(257 * 1024));
    },
  });
  await assert.rejects(
    oversizedExecution.readGitSummary(),
    /pim_sandbox_response_too_large/u,
  );
});

test("classifies post-dispatch transport and protocol failures as unknown mutation outcomes", async () => {
  for (const executionResponse of [
    () => new Response("unavailable", { status: 503 }),
    () => streamedResponse("not json"),
    () => jsonResponse({ exit_code: 124, stdout: "", stderr: "timeout" }),
  ]) {
    const sandbox = new PimThreadSandbox({
      agentId: 111,
      baseUrl: "http://127.0.0.1:3000",
      username: "admin",
      password: "secret",
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/auth/login") {
          return jsonResponse({ access_token: "pim-token" });
        }
        if (url.pathname.endsWith("/sandbox")) {
          return jsonResponse({ status: "running" });
        }
        return executionResponse();
      },
    });

    await assert.rejects(
      sandbox.runTrackedCommand({ command: "printf written > changed.txt" }),
      (error) => error instanceof PimSandboxMutationOutcomeUnknownError,
    );
  }
});

test("does not retry a mutating exec after an ambiguous 401 response", async () => {
  let execRequests = 0;
  const sandbox = new PimThreadSandbox({
    agentId: 111,
    baseUrl: "http://127.0.0.1:3000",
    username: "admin",
    password: "secret",
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/auth/login") {
        return jsonResponse({ access_token: "pim-token" });
      }
      if (url.pathname.endsWith("/sandbox")) {
        return jsonResponse({ status: "running" });
      }
      execRequests += 1;
      return new Response("unauthorized", { status: 401 });
    },
  });

  await assert.rejects(
    sandbox.runTrackedCommand({ command: "printf written > changed.txt" }),
    (error) => error instanceof PimSandboxMutationOutcomeUnknownError,
  );
  assert.equal(execRequests, 1);
});

test("serializes tracked commands across PIM clients sharing one workspace", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "crewon-tracked-lock-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init");
  git(root, "config", "user.email", "test@crewon.local");
  git(root, "config", "user.name", "CrewON Test");
  writeFileSync(join(root, "baseline.txt"), "baseline\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  const first = localScriptSandbox(root);
  const second = localScriptSandbox(root);

  const [firstResult, secondResult] = await Promise.all([
    first.runTrackedCommand({
      command: "printf a > first-a.txt; sleep 0.4; printf b > first-b.txt",
      timeoutSeconds: 10,
    }),
    second.runTrackedCommand({
      command: "printf c > second.txt",
      timeoutSeconds: 10,
    }),
  ]);

  assert.deepEqual(firstResult.workspaceChanges.paths, [
    "first-a.txt",
    "first-b.txt",
  ]);
  assert.deepEqual(secondResult.workspaceChanges.paths, ["second.txt"]);
});

test(
  "kills detached descendants before taking the after snapshot",
  { skip: process.platform !== "linux" },
  async (context) => {
    const root = mkdtempSync(join(tmpdir(), "crewon-tracked-detached-"));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    git(root, "init");
    git(root, "config", "user.email", "test@crewon.local");
    git(root, "config", "user.name", "CrewON Test");
    writeFileSync(join(root, "baseline.txt"), "baseline\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "baseline");

    const tracked = await localScriptSandbox(root, false).runTrackedCommand({
      command:
        'python3 -c \'import os,time; os.setsid(); time.sleep(.4); open("late.txt","w").write("late")\' </dev/null >/dev/null 2>&1 &',
      timeoutSeconds: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 700));

    assert.equal(tracked.workspaceChanges.statsComplete, true);
    assert.deepEqual(tracked.workspaceChanges.paths, []);
    assert.equal(existsSync(join(root, "late.txt")), false);
  },
);

test(
  "fails closed when the host cannot prove detached-process cleanup",
  { skip: process.platform === "linux" },
  async (context) => {
    const root = mkdtempSync(join(tmpdir(), "crewon-tracked-no-subreaper-"));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    git(root, "init");
    git(root, "config", "user.email", "test@crewon.local");
    git(root, "config", "user.name", "CrewON Test");
    writeFileSync(join(root, "baseline.txt"), "baseline\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "baseline");

    const tracked = await localScriptSandbox(root, false).runTrackedCommand({
      command: "printf changed > changed.txt",
      timeoutSeconds: 10,
    });

    assert.deepEqual(tracked.workspaceChanges, {
      schemaVersion: "crewon.workspace-change-summary.v0",
      paths: [],
      additions: 0,
      deletions: 0,
      statsComplete: false,
    });
  },
);

function localScriptSandbox(
  root: string,
  emulateLinuxIsolation = process.platform !== "linux",
): PimThreadSandbox {
  return new PimThreadSandbox({
    agentId: 111,
    baseUrl: "http://127.0.0.1:3000",
    username: "admin",
    password: "secret",
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
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
      assert.equal(request.language, "python");
      const originalRoot = 'pathlib.Path("/workspace").resolve()';
      const localRoot = `pathlib.Path(${JSON.stringify(root)}).resolve()`;
      let script = request.script_content.replaceAll(originalRoot, localRoot);
      if (emulateLinuxIsolation) {
        script = script
          .replace(
            "process_isolation_supported = enable_subreaper()",
            "process_isolation_supported = True",
          )
          .replace(
            "isolation_complete = terminate_descendants() if not stream_cleanup_incomplete else False",
            "isolation_complete = not stream_cleanup_incomplete",
          );
      }
      const execution = await execFileAsync("python3", ["-c", script], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
      const envelope = JSON.parse(execution.stdout) as Record<string, unknown>;
      envelope.cwd = "/workspace";
      return executionResponse(JSON.stringify(envelope));
    },
  });
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function sandboxInitializationFixture() {
  const initialization = deferred<Response>();
  let sandboxRequests = 0;
  let executionRequests = 0;
  const sandbox = new PimThreadSandbox({
    agentId: 111,
    baseUrl: "http://127.0.0.1:3000",
    username: "admin",
    password: "secret",
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/auth/login") {
        return jsonResponse({ access_token: "pim-token" });
      }
      if (url.pathname.endsWith("/sandbox")) {
        sandboxRequests += 1;
        const abort = () =>
          initialization.reject(
            init.signal?.reason ?? new Error("initialization aborted"),
          );
        init.signal?.addEventListener("abort", abort, { once: true });
        try {
          return await initialization.promise;
        } finally {
          init.signal?.removeEventListener("abort", abort);
        }
      }
      executionRequests += 1;
      return executionResponse("");
    },
  });
  return {
    sandbox,
    get sandboxRequests() {
      return sandboxRequests;
    },
    get executionRequests() {
      return executionRequests;
    },
    releaseInitialization: () =>
      initialization.resolve(jsonResponse({ status: "running" })),
  };
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
}> {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

type Settled<T> =
  | Readonly<{ status: "fulfilled"; value: T }>
  | Readonly<{ status: "rejected"; reason: unknown }>;

function settled<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

async function settlesPromptly<T>(
  outcome: Promise<Settled<T>>,
): Promise<Settled<T> | null> {
  return Promise.race([
    outcome,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
  ]);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition_not_reached");
}

function executionResponse(stdout: string): Response {
  return jsonResponse({ exit_code: 0, stdout, stderr: "" });
}

function jsonResponse(body: unknown): Response {
  return Response.json(body, { status: 200 });
}

function streamedResponse(content: string): Response {
  const bytes = new TextEncoder().encode(content);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.byteLength; offset += 1024) {
          controller.enqueue(bytes.subarray(offset, offset + 1024));
        }
        controller.close();
      },
    }),
    { status: 200 },
  );
}
