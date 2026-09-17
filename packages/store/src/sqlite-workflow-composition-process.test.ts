import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  compositionFixture,
  compositionNow,
  parallelVersion,
} from "./workflow-run-composition.test-support.ts";

test(
  "a process exiting after its first node write leaves no partial DAG, Step, Attempt or receipt",
  { timeout: 15_000 },
  async (t) => {
    const f = await compositionFixture(t, { asset: parallelVersion(2) }),
      before = f.snapshot();
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        childScript("admission-crash"),
      ],
      {
        env: {
          ...process.env,
          CREWON_COMPOSITION_DB: f.path,
          CREWON_COMPOSITION_INPUT: JSON.stringify(f.input),
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(child.status, 77, child.stderr);
    assert.deepEqual(f.snapshot(), before);
    const reopened = f.open().experimentalWorkflowRunCompositionStore();
    assert.equal(
      (await reopened.admitWorkflowNodes(f.input)).admissions.length,
      2,
    );
    assert.equal(f.snapshot().run_attempts!.length, 2);
  },
);

test(
  "a process exiting after terminal output persistence rolls back the Attempt and leaves no orphan wake",
  { timeout: 15_000 },
  async (t) => {
    const f = await compositionFixture(t),
      admitted = await f.composition.admitWorkflowNodes(f.input),
      before = f.snapshot();
    const input = {
      ...f.input,
      nodeId: "agent",
      claimId: admitted.admissions[0]!.claim.claimId,
      outcome: { status: "completed", value: { topic: "done" } },
    };
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        childScript("settlement-crash"),
      ],
      {
        env: {
          ...process.env,
          CREWON_COMPOSITION_DB: f.path,
          CREWON_COMPOSITION_INPUT: JSON.stringify(input),
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(child.status, 78, child.stderr);
    assert.deepEqual(f.snapshot(), before);
    await f
      .open()
      .experimentalWorkflowRunCompositionStore()
      .settleWorkflowNode({
        ...input,
        outcome: { status: "completed", value: { topic: "done" } },
      });
    assert.equal(f.snapshot().work_items!.length, 2);
  },
);

test(
  "two real processes obtain the same node admission after contending on one SQLite transaction",
  { timeout: 15_000 },
  async (t) => {
    const f = await compositionFixture(t);
    const children = ["one", "two"].map((prefix) =>
      spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          childScript("race"),
        ],
        {
          env: {
            ...process.env,
            CREWON_COMPOSITION_DB: f.path,
            CREWON_COMPOSITION_INPUT: JSON.stringify(f.input),
            CREWON_COMPOSITION_PREFIX: prefix,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      ),
    );
    t.after(() => {
      for (const child of children)
        if (child.exitCode === null) child.kill("SIGKILL");
    });
    const ready = children.map(
      (child) =>
        new Promise<void>((resolve, reject) => {
          child.stdout.once("data", (chunk) =>
            String(chunk).includes("ready")
              ? resolve()
              : reject(new Error(String(chunk))),
          );
          child.once("error", reject);
          child.once("exit", () =>
            reject(new Error("composition child exited before ready")),
          );
        }),
    );
    const completed = Promise.all(
      children.map(
        (child) =>
          new Promise<string>((resolve, reject) => {
            let output = "",
              error = "";
            child.stdout.on("data", (chunk) => {
              output += chunk;
            });
            child.stderr.on("data", (chunk) => {
              error += chunk;
            });
            child.once("exit", (code) =>
              code === 0 ? resolve(output) : reject(new Error(error)),
            );
            child.once("error", reject);
          }),
      ),
    );
    void completed.catch(() => {});
    await Promise.all(ready);
    for (const child of children) child.stdin.end("go");
    const results = (await completed).map((text) =>
      JSON.parse(text.trim().split("\n").at(-1)!),
    );
    assert.deepEqual(results[0], results[1]);
    assert.equal(f.snapshot().run_steps!.length, 1);
    assert.equal(f.snapshot().run_attempts!.length, 1);
    assert.equal(f.snapshot().workflow_node_passes!.length, 1);
  },
);

function childScript(mode: "admission-crash" | "settlement-crash" | "race") {
  return `
    import { SqliteRunStore } from ${JSON.stringify(new URL("./sqlite-run-store.ts", import.meta.url).href)};
    const store = new SqliteRunStore(process.env.CREWON_COMPOSITION_DB, { clock: { nowEpochMilliseconds: () => ${compositionNow} } });
    let ids = 0;
    const composition = store.experimentalWorkflowRunCompositionStore({ nextId: () => {
      ids++;
      ${mode === "admission-crash" ? "if (ids === 5) process.exit(77);" : mode === "settlement-crash" ? "process.exit(78);" : "if (ids === 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);"}
      return (process.env.CREWON_COMPOSITION_PREFIX ?? 'child')+'-'+ids;
    } });
    ${mode === "race" ? "process.stdout.write('ready\\n'); await new Promise(resolve => process.stdin.once('data', resolve));" : ""}
    try { process.stdout.write(JSON.stringify(await composition.${mode === "settlement-crash" ? "settleWorkflowNode" : "admitWorkflowNodes"}(JSON.parse(process.env.CREWON_COMPOSITION_INPUT)))+'\\n'); }
    finally { await store.close(); }
  `;
}
