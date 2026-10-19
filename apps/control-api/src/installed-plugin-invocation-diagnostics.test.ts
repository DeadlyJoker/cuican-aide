import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createPluginInvocationDiagnostics } from "./installed-plugin-invocation-diagnostics.ts";

const action = "crewon.project-generations.v1.generateConcept";
const readinessAction = "crewon.project-generation-contexts.v1.getReadiness";
const queryAction =
  "crewon.project-generation-queries.v1.queryConceptGeneration";
const prefix = "CREWON_PLUGIN_INVOCATION_DIAGNOSTIC:";
type Record = {
  requestId: string;
  pid: number;
  elapsedMs: number;
  sequence: number;
  phase: string;
  status: "start" | "end" | "error";
};
function fixture() {
  const lines: string[] = [];
  const diagnostics = createPluginInvocationDiagnostics({
    enabled: true,
    sink: (line) => {
      lines.push(line);
    },
  });
  return {
    ...diagnostics,
    lines,
    records: () =>
      lines.map((line) => {
        assert.ok(line.startsWith(prefix));
        return JSON.parse(line.slice(prefix.length)) as Record;
      }),
  };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("production singleton requires exact explicit opt-in and emits only stderr", () => {
  const moduleUrl = new URL(
    "./installed-plugin-invocation-diagnostics.ts",
    import.meta.url,
  ).href;
  const script = `const diagnostics=await import(${JSON.stringify(moduleUrl)});
    const value=await diagnostics.runPluginGenerationDiagnostics('req-singleton',${JSON.stringify(action)},()=>
      diagnostics.observePluginGenerationPhase('generation.current',async()=>17));
    if(value!==17) throw new Error('original_value_changed');`;
  for (const setting of ["0", "true", "1"]) {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      CREWON_PLUGIN_INVOCATION_DIAGNOSTICS: setting,
    };
    delete environment.NODE_OPTIONS;
    const child = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", script],
      {
        env: environment,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 16 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0);
    assert.equal(child.stdout, "");
    if (setting !== "1") assert.equal(child.stderr, "");
    else {
      const records = child.stderr
        .trim()
        .split("\n")
        .map((line) => {
          assert.ok(line.startsWith(prefix));
          return JSON.parse(line.slice(prefix.length)) as Record;
        });
      assert.equal(records.length, 4);
      assert.deepEqual(
        records.map((record) => record.status),
        ["start", "start", "end", "end"],
      );
      assert.ok(
        records.every(
          (record) =>
            record.requestId === "req-singleton" && record.pid === child.pid,
        ),
      );
    }
  }
});

test("concurrent generation phases retain their original request identity and monotonic sequences", async () => {
  const f = fixture();
  const first = gate(),
    second = gate();
  const workA = f.runPluginGenerationDiagnostics("req-a", action, () =>
    f.observePluginGenerationPhase("generation.node-execute", async () => {
      await first.promise;
      return "A";
    }),
  );
  const workB = f.runPluginGenerationDiagnostics("req-b", action, () =>
    f.observePluginGenerationPhase("generation.saved-prompt", async () => {
      await second.promise;
      return "B";
    }),
  );
  assert.deepEqual(
    f
      .records()
      .map(({ requestId, phase, status }) => ({ requestId, phase, status })),
    [
      { requestId: "req-a", phase: "route.invoke", status: "start" },
      { requestId: "req-a", phase: "generation.node-execute", status: "start" },
      { requestId: "req-b", phase: "route.invoke", status: "start" },
      { requestId: "req-b", phase: "generation.saved-prompt", status: "start" },
    ],
  );
  second.release();
  assert.equal(await workB, "B");
  first.release();
  assert.equal(await workA, "A");
  for (const requestId of ["req-a", "req-b"]) {
    const records = f
      .records()
      .filter((record) => record.requestId === requestId);
    assert.deepEqual(
      records.map((record) => record.sequence),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      records.map((record) => record.status),
      ["start", "start", "end", "end"],
    );
    assert.ok(
      records.every(
        (record) =>
          record.pid === process.pid &&
          record.elapsedMs >= 0 &&
          Number.isFinite(record.elapsedMs),
      ),
    );
    assert.ok(
      records.every(
        (record, index) =>
          index === 0 || record.elapsedMs >= records[index - 1]!.elapsedMs,
      ),
    );
  }
});

test("readiness phases keep a separate request scope while generation is pending", async () => {
  const f = fixture();
  const pending = gate();
  const generation = f.runPluginGenerationDiagnostics(
    "req-generate",
    action,
    async () => {
      await pending.promise;
      return "generated";
    },
  );
  assert.equal(
    await f.runPluginGenerationDiagnostics(
      "req-readiness",
      readinessAction,
      () =>
        f.observePluginGenerationPhase("readiness.saved-input", async () => {
          await f.observePluginGenerationPhase(
            "readiness.bytes",
            async () => undefined,
          );
          return "ready";
        }),
    ),
    "ready",
  );
  assert.deepEqual(
    f
      .records()
      .filter((r) => r.requestId === "req-readiness")
      .map(({ phase, status }) => ({ phase, status })),
    [
      { phase: "route.invoke", status: "start" },
      { phase: "readiness.saved-input", status: "start" },
      { phase: "readiness.bytes", status: "start" },
      { phase: "readiness.bytes", status: "end" },
      { phase: "readiness.saved-input", status: "end" },
      { phase: "route.invoke", status: "end" },
    ],
  );
  const before = f.lines.length;
  await f.runPluginGenerationDiagnostics(
    "req-excluded",
    readinessAction + " ",
    () => f.observePluginGenerationPhase("readiness.access", async () => 1),
  );
  assert.equal(f.lines.length, before);
  pending.release();
  assert.equal(await generation, "generated");
  assert.deepEqual(
    f
      .records()
      .filter((r) => r.requestId === "req-generate")
      .map((r) => r.status),
    ["start", "end"],
  );
});

test("original values and thrown identities survive diagnostic phases without inspecting secrets", async () => {
  const f = fixture();
  let inspected = 0;
  const secret = Object.defineProperty({}, "toJSON", {
    get() {
      inspected++;
      throw new Error("private result");
    },
  });
  const thrown = Object.defineProperty({}, "message", {
    get() {
      inspected++;
      throw new Error("private error");
    },
  });
  assert.equal(
    await f.runPluginGenerationDiagnostics("req-value", action, () =>
      f.observePluginGenerationPhase(
        "generation.task-commit",
        async () => secret,
      ),
    ),
    secret,
  );
  await assert.rejects(
    f.runPluginGenerationDiagnostics("req-error", action, () =>
      f.observePluginGenerationPhase("generation.current", async () => {
        throw thrown;
      }),
    ),
    (error) => error === thrown,
  );
  assert.equal(inspected, 0);
  assert.deepEqual(
    f
      .records()
      .filter((record) => record.requestId === "req-value")
      .map((record) => record.status),
    ["start", "start", "end", "end"],
  );
  assert.deepEqual(
    f
      .records()
      .filter((record) => record.requestId === "req-error")
      .map((record) => record.status),
    ["start", "start", "error", "error"],
  );
  for (const record of f.records())
    assert.deepEqual(Object.keys(record).sort(), [
      "elapsedMs",
      "phase",
      "pid",
      "requestId",
      "sequence",
      "status",
    ]);
  assert.ok(
    f.lines.every((line) => !/private|message|token|body|url|pin/u.test(line)),
  );
});

test("disabled, outside scope, excluded actions and unsafe request IDs produce no records", async () => {
  const lines: string[] = [];
  const disabled = createPluginInvocationDiagnostics({
    enabled: false,
    sink: (line) => {
      lines.push(line);
    },
  });
  let calls = 0;
  const work = async () => {
    calls++;
    return 17;
  };
  assert.equal(
    await disabled.runPluginGenerationDiagnostics("req-a", action, work),
    17,
  );
  assert.equal(
    await disabled.observePluginGenerationPhase("generation.current", work),
    17,
  );
  const f = fixture();
  assert.equal(
    await f.observePluginGenerationPhase("generation.current", work),
    17,
  );
  for (const excluded of [
    "report.generate",
    "crewon.project-generation-queries.v2.queryConceptGeneration",
    "",
    action + " ",
  ])
    assert.equal(
      await f.runPluginGenerationDiagnostics("req-a", excluded, () =>
        f.observePluginGenerationPhase("generation.current", work),
      ),
      17,
    );
  for (const unsafe of [
    "secret/token",
    "req-a\nprivate",
    "req-" + "a".repeat(49),
    "req-",
    "https://private",
    "req-a\n",
  ])
    assert.equal(
      await f.runPluginGenerationDiagnostics(unsafe, action, () =>
        f.observePluginGenerationPhase("generation.current", work),
      ),
      17,
    );
  assert.equal(calls, 13);
  assert.deepEqual(lines, []);
  assert.deepEqual(f.lines, []);
});

test("nested excluded actions cannot leak outer scope and malformed phases cannot enter records", async () => {
  const f = fixture();
  await f.runPluginGenerationDiagnostics("req-a", action, async () => {
    await f.runPluginGenerationDiagnostics("req-b", "other", () =>
      f.observePluginGenerationPhase("generation.current", async () => 1),
    );
    await f.observePluginGenerationPhase(
      "private-token" as never,
      async () => 2,
    );
  });
  assert.deepEqual(
    f.records().map(({ phase, status }) => ({ phase, status })),
    [
      { phase: "route.invoke", status: "start" },
      { phase: "route.invoke", status: "end" },
    ],
  );
});

test("finished request scopes reject late asynchronous diagnostic output", async () => {
  const f = fixture();
  const late = gate();
  let pending: Promise<number> | undefined;
  await f.runPluginGenerationDiagnostics("req-a", action, async () => {
    pending = late.promise.then(() =>
      f.observePluginGenerationPhase("generation.node-close", async () => 42),
    );
    return "finished";
  });
  assert.equal(f.lines.length, 2);
  late.release();
  assert.equal(await pending, 42);
  assert.equal(f.lines.length, 2);
});

test("each request reserves terminal diagnostics within 96 records and later requests have their own budget", async () => {
  const f = fixture();
  await f.runPluginGenerationDiagnostics("req-a", action, async () => {
    for (let index = 0; index < 200; index++)
      assert.equal(
        await f.observePluginGenerationPhase(
          "generation.current",
          async () => index,
        ),
        index,
      );
  });
  assert.equal(f.lines.length, 89);
  assert.deepEqual(f.records().at(-1)?.phase, "route.invoke");
  assert.deepEqual(f.records().at(-1)?.status, "end");
  assert.deepEqual(
    f.records().map((record) => record.sequence),
    Array.from({ length: 89 }, (_, index) => index + 1),
  );
  assert.equal(
    await f.runPluginGenerationDiagnostics("req-b", action, async () => 9),
    9,
  );
  assert.equal(f.lines.length, 91);
});

test("repeated checks leave room for the original query commit failure and route outcome", async () => {
  const f = fixture();
  const fault = new Error("original_failure");
  await assert.rejects(
    f.runPluginGenerationDiagnostics("req-terminal", queryAction, async () => {
      for (let index = 0; index < 200; index++)
        await f.observePluginGenerationPhase("query.current", async () => {});
      return f.observePluginGenerationPhase("query.node-execute", () =>
        f.observePluginGenerationPhase("query.task-commit", async () => {
          throw fault;
        }),
      );
    }),
    (error) => error === fault,
  );
  assert.ok(f.lines.length <= 96);
  assert.deepEqual(
    f
      .records()
      .slice(-3)
      .map(({ phase, status }) => ({ phase, status })),
    [
      { phase: "query.task-commit", status: "error" },
      { phase: "query.node-execute", status: "error" },
      { phase: "route.invoke", status: "error" },
    ],
  );
});

test("only 32 active scopes are observed without holding the 33rd business request", async () => {
  const f = fixture();
  const blocked = gate();
  const active = Array.from({ length: 32 }, (_, index) =>
    f.runPluginGenerationDiagnostics(`req-a${index}`, action, async () => {
      await blocked.promise;
      return index;
    }),
  );
  assert.equal(f.lines.length, 32);
  assert.equal(
    await f.runPluginGenerationDiagnostics("req-overflow", action, () =>
      f.observePluginGenerationPhase(
        "generation.current",
        async () => "immediate",
      ),
    ),
    "immediate",
  );
  assert.equal(f.lines.length, 32);
  blocked.release();
  assert.deepEqual(
    await Promise.all(active),
    Array.from({ length: 32 }, (_, index) => index),
  );
  assert.equal(f.lines.length, 64);
  await f.runPluginGenerationDiagnostics("req-next", action, async () => 1);
  assert.equal(f.lines.length, 66);
});

for (const behavior of ["throw", "backpressure"] as const)
  test(`sink ${behavior} is latched silent and preserves business values/errors without a queue`, async () => {
    let writes = 0,
      calls = 0;
    const f = createPluginInvocationDiagnostics({
      enabled: true,
      sink() {
        writes++;
        if (behavior === "throw") throw new Error("sink secret");
        return false;
      },
    });
    const original = new Error("business secret");
    assert.equal(
      await f.runPluginGenerationDiagnostics("req-a", action, () =>
        f.observePluginGenerationPhase("generation.current", async () => {
          calls++;
          return original;
        }),
      ),
      original,
    );
    await assert.rejects(
      f.runPluginGenerationDiagnostics("req-b", action, async () => {
        calls++;
        throw original;
      }),
      (error) => error === original,
    );
    assert.equal(writes, 1);
    assert.equal(calls, 2);
  });

test("unreadable enabled configuration and sink accessors stay disabled without executing getters", async () => {
  let gets = 0,
    calls = 0;
  const cases = [
    Object.defineProperty({}, "enabled", {
      get() {
        gets++;
        throw new Error("secret");
      },
    }),
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("secret");
        },
      },
    ),
    Object.defineProperty({ enabled: true }, "sink", {
      get() {
        gets++;
        throw new Error("secret");
      },
    }),
  ];
  for (const input of cases) {
    const f = createPluginInvocationDiagnostics(input as { enabled: boolean });
    assert.equal(
      await f.runPluginGenerationDiagnostics("req-a", action, async () => {
        calls++;
        return 1;
      }),
      1,
    );
  }
  assert.equal(gets, 0);
  assert.equal(calls, 3);
});

test("original-operation queries retain their own bounded diagnostic scope and original error", async () => {
  const f = fixture();
  const queryAction =
    "crewon.project-generation-queries.v1.queryConceptGeneration";
  const failure = new Error("private supplier details must remain private");
  await assert.rejects(
    f.runPluginGenerationDiagnostics("req-query", queryAction, () =>
      f.observePluginGenerationPhase("query.node-execute", async () => {
        throw failure;
      }),
    ),
    (error) => error === failure,
  );
  assert.deepEqual(
    f.records().map(({ phase, status }) => ({ phase, status })),
    [
      { phase: "route.invoke", status: "start" },
      { phase: "query.node-execute", status: "start" },
      { phase: "query.node-execute", status: "error" },
      { phase: "route.invoke", status: "error" },
    ],
  );
  assert.ok(f.records().every((record) => record.requestId === "req-query"));
  assert.ok(f.lines.every((line) => !line.includes("supplier")));
  const before = f.lines.length;
  await f.runPluginGenerationDiagnostics("req-other", queryAction + " ", () =>
    f.observePluginGenerationPhase("query.current", async () => 3),
  );
  assert.equal(f.lines.length, before);
});
