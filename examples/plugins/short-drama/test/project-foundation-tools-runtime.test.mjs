import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PROJECT_FOUNDATION_TOOL_OPERATIONS,
  PROJECT_FOUNDATION_TOOL_RESPONSE_LIMITS,
} from "@crewon/plugin-sdk/project-foundation-tools";
import {
  fixture,
  payload,
  projectId,
  query,
  proposal,
  proposalDigest,
  saveRequest,
  version,
  scope,
  foundation,
  canonical,
  sha,
} from "./project-foundation-tools-runtime.test-support.mjs";
const signal = () => new AbortController().signal;

test("Short40 actual installed factory publishes the original24 and eight independent Foundation planning tools", async () => {
  const f = fixture(),
    defs = f.runtime.definitions();
  assert.deepEqual(
    defs.filter((d) => d.name.includes("__foundation_")).map((d) => d.name),
    Object.values(PROJECT_FOUNDATION_TOOL_OPERATIONS).map(
      (op) => "crewon_short_drama__" + op,
    ),
  );
  assert.equal(
    f.runtime.executionPolicy("function", "crewon_short_drama__outline_save")
      .capability,
    "project.write",
  );
  assert.equal(
    defs.some((d) => d.name.includes("confirm")),
    false,
  );
  assert.equal(defs.length, 32);
  const chapters = defs.find((d) => d.name.endsWith("foundation_chapters"));
  assert.equal(
    chapters.inputSchema.required.includes("afterStartOffset"),
    false,
  );
  assert.deepEqual(chapters.inputSchema.properties.afterStartOffset, {
    type: "integer",
    minimum: 0,
    maximum: 20000000,
  });
  const descriptor = JSON.parse(
    await readFile(
      new URL(`../dist/${version}/crewon.plugin.json`, import.meta.url),
    ),
  );
  assert.deepEqual(
    descriptor.requires.find(
      (d) => d.service === "crewon.project-foundation-tools",
    ),
    {
      service: "crewon.project-foundation-tools",
      apiVersion: "1",
      optional: true,
    },
  );
  for (const [method, op] of Object.entries(
    PROJECT_FOUNDATION_TOOL_OPERATIONS,
  )) {
    const p = f.runtime.executionPolicy(
        "function",
        "crewon_short_drama__" + op,
      ),
      write = method === "saveProposal";
    assert.equal(p.effect, write ? "mutation" : "readOnly");
    assert.equal(p.capability, write ? "project.write" : "project.read");
    assert.equal(p.recovery, write ? "reconcilable" : "replaySafe");
    assert.ok(
      p.limits.maxOutputBytes >=
        2 * PROJECT_FOUNDATION_TOOL_RESPONSE_LIMITS[op] + 512,
    );
  }
  await f.runtime.close();
});

test("Short40 actual SDK calls preserve original command and provide real parameters, scalar source/proposal pages, metadata and save ACK", async () => {
  const f = fixture();
  const cases = [
    ["readScope", {}],
    ["getFoundation", { projectId }],
    ["getSource", query],
    ["readSourcePage", { ...query, startOffset: 1, limit: 1 }],
    ["listSourceChapters", { ...query, limit: 16 }],
    [
      "getProposal",
      {
        projectId,
        proposalRevision: 1,
        proposalDigest,
        startOffset: 0,
        limit: 1024,
      },
    ],
    ["listProposals", { projectId, afterProposalRevision: 0, limit: 4 }],
    ["saveProposal", saveRequest],
  ];
  for (const [method, request] of cases) {
    const cmd = f.command(method, request),
      result = await f.runtime.execute(cmd, signal()),
      data = payload(result),
      call = f.calls.at(-1);
    assert.equal(result.status, "completed");
    assert.equal(call.command, cmd);
    assert.deepEqual(call.request, request);
    assert.equal(call.method, method);
    if (method === "readScope") {
      assert.ok(Buffer.byteLength(JSON.stringify(data.guidance)) < 3072);
      assert.match(data.guidance.instructions.join(""), /方案与结构化大纲/);
      assert.match(data.guidance.instructions.join(""), /project_context_read/);
      assert.match(
        data.guidance.instructions.join(""),
        /artifact.latestContentRevision/,
      );
      assert.match(data.guidance.instructions.join(""), /content_read/);
    }
    if (method === "getFoundation") {
      assert.equal(data.foundation.origin, "novel");
      assert.equal("guidance" in data, false);
    }
    if (method === "readSourcePage") assert.equal(data.page.content, "😀");
    if (method === "saveProposal") {
      assert.equal(data.kind, "save-proposal");
      assert.equal("text" in data.proposal, false);
      assert.equal(data.proposal.revision, 1);
    }
    assert.ok(Buffer.byteLength(result.result.output) <= 9999);
  }
  assert.equal(
    f.calls.some((c) => c.method.includes("confirm")),
    false,
  );
  assert.equal(f.oldCalls(), 0);
  await f.runtime.close();
});

test("Short40 missing independent service rejects all eight retained/fabricated new executions without borrowing old project grant", async () => {
  const f = fixture({ missing: true });
  for (const method of Object.keys(PROJECT_FOUNDATION_TOOL_OPERATIONS)) {
    const cmd = f.command(method, {});
    assert.equal(
      f.runtime.definitions().some((d) => d.name === cmd.name),
      true,
    );
    assert.ok(f.runtime.executionPolicy("function", cmd.name));
    await assert.rejects(
      f.runtime.execute(cmd, signal()),
      /foundation_tools_unavailable/,
    );
  }
  assert.equal(f.oldCalls(), 0);
  assert.equal(f.calls.length, 0);
  await f.runtime.close();
});

test("Short40 proposal COMMIT ACK survives late cancellation, retains until acknowledgement and cold reconcile uses original command", async () => {
  const abort = new AbortController();
  const f = fixture({
    overrides: {
      async saveProposal() {
        abort.abort();
        return {
          kind: "save-proposal",
          disposition: "committed",
          foundationRevision: 1,
          proposal,
        };
      },
    },
  });
  const cmd = f.command("saveProposal", saveRequest),
    result = await f.runtime.execute(cmd, abort.signal);
  assert.equal(result.status, "completed");
  assert.equal(f.runtime.canRetire(), false);
  assert.deepEqual(await f.runtime.reconcile(cmd, signal()), result);
  assert.equal(f.calls.length, 1);
  const lookup = {
    executionId: cmd.executionId,
    idempotencyKey: cmd.idempotencyKey,
    actionDigest: cmd.actionDigest,
    actionIntent: cmd.actionIntent,
  };
  assert.deepEqual(f.runtime.readRetainedExecutionResult(lookup), result);
  assert.equal(
    f.runtime.acknowledgeExecutionResult({
      ...lookup,
      status: result.status,
      providerReceiptId: result.providerReceiptId,
    }),
    true,
  );
  assert.equal(f.runtime.canRetire(), true);
  const cold = f.create();
  f.host.saveProposal = async () => ({
    kind: "save-proposal",
    disposition: "replayed",
    foundationRevision: 1,
    proposal,
  });
  assert.equal(
    payload(await cold.reconcile(cmd, signal())).disposition,
    "replayed",
  );
  assert.equal(f.calls.at(-1).command, cmd);
  await cold.close();
  await f.runtime.close();
});

test("Short40 cold mutation cancel never dispatches to discover outcome; invalid DTO and command fail before retention", async () => {
  const f = fixture(),
    cmd = f.command("saveProposal", saveRequest);
  assert.equal(
    (await f.runtime.cancel(cmd, signal())).status,
    "unknownOutcome",
  );
  assert.equal(f.calls.length, 0);
  const read = f.command("getFoundation", { projectId });
  assert.equal((await f.runtime.cancel(read, signal())).status, "canceled");
  assert.equal(f.calls.length, 0);
  const bad = structuredClone(cmd);
  bad.input = JSON.stringify({ ...saveRequest, idempotencyKey: "not-allowed" });
  await assert.rejects(f.runtime.execute(bad, signal()), /command_mismatch/);
  assert.equal(f.calls.length, 0);
  f.host.saveProposal = async () => ({
    kind: "save-proposal",
    disposition: "committed",
    foundationRevision: 1,
    proposal: { ...proposal, revision: 7 },
  });
  await assert.rejects(
    f.runtime.execute(cmd, signal()),
    /project_foundation_tools_contract_invalid/,
  );
  assert.equal(f.runtime.canRetire(), true);
  await f.runtime.close();
});

test("Short40 long escaped Unicode chapter pages preserve every title and offset through bounded continuation", async () => {
  const title = ("😀" + String.fromCharCode(92) + '"' + "章").repeat(64),
    chapters = Array.from({ length: 16 }, (_, i) => ({
      projectId,
      sourceRevision: 1,
      chapterId: "chapter-" + i,
      title,
      startOffset: i * 100,
      endOffset: (i + 1) * 100,
    }));
  assert.equal(title.length, 320);
  const f = fixture({
    overrides: {
      async listSourceChapters({ request }) {
        const remaining = chapters.filter(
            (c) =>
              request.afterStartOffset === undefined ||
              c.startOffset > request.afterStartOffset,
          ),
          page = remaining.slice(0, request.limit);
        return {
          chapters: page,
          nextStartOffset:
            remaining.length > page.length ? page.at(-1).startOffset : null,
        };
      },
    },
  });
  const loaded = [];
  let afterStartOffset;
  for (let iteration = 0; iteration < 16; iteration++) {
    const request = {
        ...query,
        limit: 16,
        ...(afterStartOffset === undefined ? {} : { afterStartOffset }),
      },
      cmd = f.command("listSourceChapters", request),
      result = await f.runtime.execute(cmd, signal()),
      data = payload(result);
    assert.ok(Buffer.byteLength(result.result.output) <= 9999);
    assert.ok(data.chapters.length > 0);
    assert.equal(data.projection.kind, "bounded-chapter-page");
    loaded.push(...data.chapters);
    if (data.nextStartOffset === null) break;
    assert.equal(data.nextStartOffset, data.chapters.at(-1).startOffset);
    if (afterStartOffset !== undefined)
      assert.ok(data.nextStartOffset > afterStartOffset);
    afterStartOffset = data.nextStartOffset;
  }
  assert.deepEqual(loaded, chapters);
  assert.ok(f.calls.length > 1);
  await f.runtime.close();
});

test("Short40 maximum escaped parameters use deterministic scalar pages, digest and complete metadata without injecting the full DTO", async () => {
  const large = structuredClone(foundation);
  large.parameters.adaptation.retainedCharacters = Array.from(
    { length: 44 },
    (_, i) => "角色" + i + (String.fromCharCode(92) + '"雨😀').repeat(14),
  );
  assert.ok(Buffer.byteLength(canonical(large.parameters)) <= 8192);
  assert.ok(
    Buffer.byteLength(
      JSON.stringify({
        resultJsonParts: [JSON.stringify({ foundation: large })],
      }),
    ) > 9999,
  );
  const f = fixture({
      overrides: { getFoundation: async () => ({ foundation: large }) },
    }),
    parts = [];
  let startOffset = 0;
  for (let iteration = 0; iteration < 64; iteration++) {
    const cmd = f.command("getFoundation", {
        projectId,
        parametersStartOffset: startOffset,
        parametersLimit: 256,
      }),
      result = await f.runtime.execute(cmd, signal()),
      data = payload(result),
      page = data.parametersPage;
    assert.ok(Buffer.byteLength(result.result.output) <= 9999);
    assert.equal(data.foundation.origin, "novel");
    assert.equal("parameters" in data.foundation, false);
    assert.equal(page.startOffset, startOffset);
    assert.equal(page.content.isWellFormed(), true);
    assert.equal(
      Array.from(page.content).length,
      page.endOffset - page.startOffset,
    );
    assert.equal(page.digest, sha(canonical(large.parameters)));
    assert.ok(Array.from(page.content).length <= 256);
    parts.push(page.content);
    if (page.nextOffset === null) break;
    assert.ok(page.nextOffset > startOffset);
    startOffset = page.nextOffset;
  }
  assert.deepEqual(JSON.parse(parts.join("")), large.parameters);
  assert.ok(f.calls.length > 1);
  assert.equal(
    f.calls.every((c) => c.method === "getFoundation"),
    true,
  );
  await f.runtime.close();
});

test("Short40 close joins a physically pending save, and does not turn its correlated ACK into failure", async () => {
  let release, started;
  const ready = new Promise((resolve) => {
      started = resolve;
    }),
    gate = new Promise((resolve) => {
      release = resolve;
    });
  const f = fixture({
      overrides: {
        async saveProposal() {
          started();
          await gate;
          return {
            kind: "save-proposal",
            disposition: "committed",
            foundationRevision: 1,
            proposal,
          };
        },
      },
    }),
    cmd = f.command("saveProposal", saveRequest),
    pending = f.runtime.execute(cmd, signal());
  await ready;
  let closed = false;
  const closing = f.runtime.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  assert.equal((await pending).status, "completed");
  await closing;
  assert.equal(f.runtime.canRetire(), true);
});

test("Short40 combined close withdraws pending Foundation reads immediately and still joins their physical completion", async () => {
  let release, started;
  const ready = new Promise((resolve) => {
      started = resolve;
    }),
    gate = new Promise((resolve) => {
      release = resolve;
    }),
    f = fixture({
      overrides: {
        async readScope() {
          started();
          await gate;
          return { scope };
        },
      },
    }),
    reading = f.runtime.execute(f.command("readScope", {}), signal());
  const rejected = assert.rejects(reading, /runtime_closed/);
  await ready;
  let closed = false;
  const closing = f.runtime.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  await rejected;
  await closing;
  assert.equal(f.runtime.canRetire(), true);
});

test("Short40 maximum source/proposal scalar windows and four-record history stay whole-bounded without shortened content", async () => {
  const content = "😀".repeat(1024),
    page = {
      startOffset: 0,
      endOffset: 1024,
      content,
      nextOffset: 1024,
      characterLength: 8192,
    },
    records = Array.from({ length: 4 }, (_, i) => ({
      ...proposal,
      revision: i + 1,
      characterLength: 8192,
    })),
    f = fixture({
      overrides: {
        readSourcePage: async () => ({
          sourceRevision: query.sourceRevision,
          sourceDigest: query.sourceDigest,
          page,
        }),
        getProposal: async () => ({
          proposal: { ...proposal, characterLength: 8192 },
          page,
        }),
        listProposals: async () => ({ proposals: records, nextRevision: null }),
      },
    });
  const cases = [
    ["readSourcePage", { ...query, startOffset: 0, limit: 1024 }],
    [
      "getProposal",
      {
        projectId,
        proposalRevision: 1,
        proposalDigest,
        startOffset: 0,
        limit: 1024,
      },
    ],
    ["listProposals", { projectId, afterProposalRevision: 0, limit: 4 }],
  ];
  for (const [method, request] of cases) {
    const result = await f.runtime.execute(
        f.command(method, request),
        signal(),
      ),
      value = payload(result);
    assert.ok(Buffer.byteLength(result.result.output) <= 9999);
    if (method === "listProposals") assert.deepEqual(value.proposals, records);
    else assert.equal(value.page.content, content);
  }
  await f.runtime.close();
});
