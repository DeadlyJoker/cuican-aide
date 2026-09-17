import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  linkSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  artifactWriterScript,
  recoveryFixture,
  recoveryInput,
  writerEnvironment,
} from "./artifact-write-recovery.test-support.ts";

for (const mode of ["staged", "ready"] as const) {
  test(
    `maintenance authenticates a blob after real process death at ${mode} and completes the original artifact without a tool retry`,
    { timeout: 15_000 },
    async (t) => {
      const f = recoveryFixture(t),
        input = recoveryInput();
      f.crash(input, mode);
      assert.equal(await f.store.get(input.record), null);
      const before = f.database
        .prepare("SELECT record_json,iv_base64,fingerprint FROM artifacts")
        .get();
      let guardCalls = 0;
      const recovered = await f.maintain(f.store, {
        canRetireArtifact: async () => {
          guardCalls++;
          return false;
        },
      });
      assert.equal(recovered.recovered, 1);
      assert.equal(recovered.recoveredBytes, input.content.byteLength);
      assert.equal(recovered.deleted, 0);
      assert.equal(guardCalls, 0);
      assert.equal(existsSync(f.stage(input)), false);
      assert.deepEqual(
        f.database
          .prepare("SELECT record_json,iv_base64,fingerprint FROM artifacts")
          .get(),
        before,
      );
      assert.deepEqual(
        (await f.store.read(input.record))!.content,
        new Uint8Array(input.content),
      );
      await f.store.close();
      const reopened = f.open();
      assert.equal((await reopened.put(input)).disposition, "replayed");
      f.due();
      assert.equal((await f.maintain(reopened)).recovered, 0);
    },
  );
}

test(
  "six partial-write crashes reuse one staging file; unknown ciphertext is kept until an exact payload retry",
  { timeout: 20_000 },
  async (t) => {
    const f = recoveryFixture(t),
      input = recoveryInput();
    for (let n = 0; n < 6; n++) f.crash(input, "partial");
    assert.deepEqual(readdirSync(path.dirname(f.stage(input))), [
      path.basename(f.stage(input)),
    ]);
    assert.equal(statSync(f.stage(input)).size, 17);
    const report = await f.maintain();
    assert.equal(report.recovered, 0);
    assert.equal(report.recoveryDeferred, 1);
    assert.equal(statSync(f.stage(input)).size, 17);
    assert.equal(await f.store.get(input.record), null);
    await assert.rejects(
      f.store.put({
        ...input,
        content: Buffer.alloc(input.content.length, 66),
      }),
      { code: "artifact_content_digest_mismatch" },
    );
    assert.equal(statSync(f.stage(input)).size, 17);
    assert.equal((await f.store.put(input)).disposition, "replayed");
    assert.equal(existsSync(f.stage(input)), false);
    assert.deepEqual(
      (await f.store.read(input.record))!.content,
      new Uint8Array(input.content),
    );
  },
);

test("failed metadata commit after promotion retains a recoverable final blob and releases maintenance ownership", async (t) => {
  const f = recoveryFixture(t),
    input = recoveryInput();
  f.crash(input, "staged");
  f.database.exec(
    "CREATE TRIGGER recovery_fault BEFORE UPDATE OF state ON artifacts WHEN NEW.state='ready' BEGIN SELECT RAISE(ABORT,'recovery-fault'); END",
  );
  assert.equal((await f.maintain()).recoveryDeferred, 1);
  assert.equal(existsSync(f.blob(input)), true);
  assert.equal(existsSync(f.stage(input)), false);
  assert.equal(
    f.database.prepare("SELECT owner FROM artifact_maintenance").get()!.owner,
    null,
  );
  assert.equal(await f.store.get(input.record), null);
  f.database.exec("DROP TRIGGER recovery_fault");
  f.due();
  assert.equal((await f.maintain()).recovered, 1);
  assert.deepEqual(
    (await f.store.read(input.record))!.content,
    new Uint8Array(input.content),
  );
});

test("a wrong encryption key or corrupted staging body cannot be promoted or deleted", async (t) => {
  const f = recoveryFixture(t),
    input = recoveryInput();
  f.crash(input, "staged");
  const bytes = readFileSync(f.stage(input));
  const wrongKey = f.open(43);
  assert.equal((await f.maintain(wrongKey)).recoveryDeferred, 1);
  assert.deepEqual(readFileSync(f.stage(input)), bytes);
  const damaged = Buffer.from(bytes);
  damaged[damaged.length - 1]! ^= 1;
  writeFileSync(f.stage(input), damaged);
  f.due();
  assert.equal((await f.maintain()).recoveryDeferred, 1);
  assert.deepEqual(readFileSync(f.stage(input)), damaged);
  writeFileSync(f.stage(input), bytes);
  f.due();
  assert.equal((await f.maintain()).recovered, 1);
});

test("recovery respects byte and row budgets, rotates partial candidates and does not scan unknown legacy files", async (t) => {
  const f = recoveryFixture(t),
    values = ["a", "b", "c"].map((id) => recoveryInput(id));
  for (const input of values) {
    await f.store.put(input);
    renameSync(f.blob(input), f.stage(input));
    f.database
      .prepare("UPDATE artifacts SET state='writing' WHERE artifact_id=?")
      .run(input.record.artifactId);
  }
  const legacy = `${f.blob(values[0]!)}.tmp-999-legacy`;
  copyFileSync(f.stage(values[0]!), legacy);
  truncateSync(f.stage(values[0]!), 17);
  const first = await f.store.retention.maintainArtifacts({
    policy: { ...f.policy, maxRecords: 1, maxBytes: 8191 },
    guard: { canRetireArtifact: async () => false },
    signal: new AbortController().signal,
  });
  assert.equal(first.checked, 1);
  assert.equal(first.recovered, 0);
  f.database.exec("UPDATE artifact_maintenance SET next_due_ms=0");
  const next = await f.store.retention.maintainArtifacts({
    policy: { ...f.policy, maxRecords: 2, maxBytes: 8192 },
    guard: { canRetireArtifact: async () => false },
    signal: new AbortController().signal,
  });
  assert.equal(next.checked, 2);
  assert.equal(next.recovered, 1);
  assert.equal(next.recoveredBytes, 8192);
  assert.equal(existsSync(legacy), true);
  assert.equal(existsSync(f.stage(values[0]!)), true);
});

test("valid final ciphertext allows removing only its redundant deterministic staging file", async (t) => {
  const f = recoveryFixture(t),
    input = recoveryInput();
  await f.store.put(input);
  writeFileSync(f.stage(input), "partial duplicate");
  const legacy = `${f.blob(input)}.tmp-123-legacy`;
  writeFileSync(legacy, "unowned");
  f.database.exec("UPDATE artifacts SET state='writing'");
  assert.equal((await f.maintain()).recovered, 1);
  assert.equal(existsSync(f.stage(input)), false);
  assert.equal(readFileSync(legacy, "utf8"), "unowned");
  assert.deepEqual(
    (await f.store.read(input.record))!.content,
    new Uint8Array(input.content),
  );
});

test("a sealed retirement cannot be reversed by a stale writing row and valid staged ciphertext", async (t) => {
  const f = recoveryFixture(t),
    base = recoveryInput();
  const input = {
    ...base,
    record: {
      ...base.record,
      createdAt: "2020-01-01T00:00:00Z",
      retention: { kind: "run" as const, expiresAt: "2020-01-02T00:00:00Z" },
    },
  };
  await f.store.put(input);
  const ciphertext = readFileSync(f.blob(input));
  assert.equal(
    (await f.maintain(f.store, { canRetireArtifact: async () => true }))
      .deleted,
    1,
  );
  writeFileSync(f.stage(input), ciphertext);
  f.database.exec(
    "UPDATE artifacts SET state='writing'; UPDATE artifact_retention_queue SET deleted_at_ms=NULL",
  );
  f.due();
  assert.equal((await f.maintain()).recovered, 0);
  assert.equal(await f.store.read(input.record), null);
  assert.equal(existsSync(f.blob(input)), false);
  assert.equal((await f.store.put(input)).disposition, "replayed");
  assert.equal(existsSync(f.blob(input)), false);
});

test("oversize sparse ciphertext and oversize metadata are rejected before unbounded reads", async (t) => {
  const f = recoveryFixture(t),
    input = recoveryInput();
  await f.store.put(input);
  truncateSync(f.blob(input), 4 * 1024 * 1024 * 1024);
  await assert.rejects(f.store.read(input.record), {
    code: "artifact_ciphertext_invalid",
  });
  f.database
    .prepare("UPDATE artifacts SET record_json=?")
    .run(" ".repeat(1024 * 1024) + JSON.stringify(input.record));
  await assert.rejects(f.store.get(input.record), {
    code: "artifact_metadata_invalid",
  });
});

test("staging symlinks and hard links are refused without overwriting the linked file", async (t) => {
  const f = recoveryFixture(t),
    input = recoveryInput();
  f.crash(input, "partial");
  unlinkSync(f.stage(input));
  const external = path.join(f.root, "external");
  writeFileSync(external, "preserve");
  symlinkSync(external, f.stage(input));
  await assert.rejects(f.store.put(input));
  assert.equal(readFileSync(external, "utf8"), "preserve");
  unlinkSync(f.stage(input));
  linkSync(external, f.stage(input));
  await assert.rejects(f.store.put(input), {
    code: "artifact_ciphertext_invalid",
  });
  assert.equal(readFileSync(external, "utf8"), "preserve");
});

test(
  "two real writers serialize the fixed staging file and publish one immutable artifact",
  { timeout: 15_000 },
  async (t) => {
    const f = recoveryFixture(t),
      input = recoveryInput();
    const children = [0, 1].map(() =>
      spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          artifactWriterScript("race"),
        ],
        {
          env: writerEnvironment(f.root, f.databasePath, input),
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
              : reject(Error(String(chunk))),
          );
          child.once("error", reject);
          child.once("exit", () => reject(Error("writer exited before ready")));
        }),
    );
    const done = Promise.all(
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
            child.once("error", reject);
            child.once("exit", (code) =>
              code === 0 ? resolve(output) : reject(Error(error)),
            );
          }),
      ),
    );
    void done.catch(() => {});
    await Promise.all(ready);
    for (const child of children) child.stdin.end("go");
    const results = (await done).map((output) =>
      JSON.parse(output.trim().split("\n").at(-1)!),
    );
    assert.deepEqual(results.map((result) => result.disposition).sort(), [
      "created",
      "replayed",
    ]);
    assert.equal(
      f.database.prepare("SELECT count(*) AS n FROM artifacts").get()!.n,
      1,
    );
    assert.deepEqual(readdirSync(path.dirname(f.blob(input))), [
      path.basename(f.blob(input)),
    ]);
    assert.deepEqual(
      (await f.store.read(input.record))!.content,
      new Uint8Array(input.content),
    );
  },
);
