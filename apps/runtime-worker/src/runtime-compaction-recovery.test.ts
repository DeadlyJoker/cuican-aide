import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { GovernedContextBundle } from "@crewon/context";
import { reportModelUsageObservations } from "@crewon/domain";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";

const OVERFLOW = "responses_provider_context_length_exceeded";

function responseEvents(number: number, failed: boolean) {
  const id = `response-${number}`;
  return [
    { type: "response.created", sequence_number: 0, response: { id } },
    ...(failed
      ? []
      : [
          {
            type: "response.output_text.delta",
            sequence_number: 1,
            delta: "summary",
          },
        ]),
    {
      type: failed ? "response.failed" : "response.completed",
      sequence_number: failed ? 1 : 2,
      response: {
        id,
        status: failed ? "failed" : "completed",
        ...(failed
          ? { error: { code: "context_length_exceeded" } }
          : {
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "summary" }],
                },
              ],
            }),
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: failed ? 0 : 80 },
          output_tokens: failed ? 0 : 10,
          total_tokens: failed ? 100 : 110,
        },
      },
    },
  ];
}

function governance() {
  const audience = {
    bindingId: "binding-1",
    scopeKind: "single" as const,
    scopeId: "agent-1",
  };
  return GovernedContextBundle.build({
    audience,
    digester: {
      sha256: (value) =>
        `sha256:${createHash("sha256").update(value).digest("hex")}`,
    },
    fragments: (["trustedApplication", "untrustedData"] as const).map(
      (trust, index) => ({
        fragmentId: `fragment-${index}`,
        audience,
        trust,
        provenance: {
          sourceKind: "application" as const,
          sourceId: "source",
          actorId: "actor",
        },
        sensitivity: "public" as const,
        purpose: "reference" as const,
        budget: { tokenCap: 1000 },
        freshness: { observedAt: "2026-08-08T00:00:00Z", expiresAt: null },
        content:
          index === 0 ? "Preserve task constraints" : "Reference material",
      }),
    ),
  });
}

for (const backend of ["sqlite", "postgres"] as const) {
  const testOptions = {
    skip:
      backend === "postgres" &&
      process.env.CREWON_TEST_POSTGRES_URL === undefined,
  };

  test(
    `${backend}: overflow recovery preserves governance, accounts known attempts and survives restart`,
    testOptions,
    async (context) => {
      const governedContext = governance();
      const fixture = await createFixture(context, {
        backend,
        storeResponses: false,
        crashAfterCommit: false,
        manualCompaction: true,
        governedContext,
        initialMessages: [
          { role: "user", content: "older context" },
          { role: "assistant", content: "earlier progress" },
          { role: "user", content: "latest constraint" },
        ],
        modelResponseEvents: (number) => responseEvents(number, number === 1),
      });
      const before = await fixture.history();
      const result = await fixture.worker().wake();
      assert.equal(result.kind, "completed", JSON.stringify(result));
      assert.equal(fixture.requests.length, 2);
      const first = fixture.requests[0]!.input as unknown[];
      const second = fixture.requests[1]!.input as unknown[];
      assert.deepEqual(second.slice(0, 2), first.slice(0, 2));
      assert.deepEqual(second.slice(2), first.slice(3));
      assert.deepEqual(
        first.slice(0, 2),
        governedContext.modelItems().map((item) => {
          assert.equal(item.type, "message");
          if (item.type !== "message")
            throw new Error("fixture_governance_invalid");
          return { role: item.role, content: item.content };
        }),
      );
      assert.equal(
        fixture.requests[0]!.instructions,
        fixture.requests[1]!.instructions,
      );
      const history = await fixture.history();
      assert.deepEqual(history.slice(0, before.length), before);
      assert.equal(history.length, before.length + 1);
      assert.equal(history.at(-1)?.type, "compaction");
      const entries = await fixture.usageRecords();
      const report = reportModelUsageObservations(entries[0]!.record, entries);
      assert.equal(report.compaction.usageReports, 2);
      assert.equal(report.compaction.cacheReadHitRate, 0.4);
      assert.equal(report.failedResponses.usageReports, 1);
      await fixture.reopen();
      assert.deepEqual(await fixture.history(), history);
      assert.deepEqual(await fixture.usageRecords(), entries);
      await fixture.worker().wake();
      assert.equal(fixture.requests.length, 2);
    },
  );

  for (const messageCount of [1, 20]) {
    test(
      `${backend}: ${messageCount} source messages stop overflow without committing an empty or partial summary`,
      testOptions,
      async (context) => {
        const fixture = await createFixture(context, {
          backend,
          storeResponses: false,
          crashAfterCommit: false,
          manualCompaction: true,
          initialMessages: Array.from({ length: messageCount }, (_, index) => ({
            role: "user",
            content: `constraint-${index}`,
          })),
          modelResponseEvents: (number) => responseEvents(number, true),
        });
        const before = await fixture.history();
        const result = await fixture.worker().wake();
        assert.equal(result.kind, "failed", JSON.stringify(result));
        if (result.kind === "failed") assert.equal(result.code, OVERFLOW);
        const expectedRequests = Math.min(messageCount, 4);
        assert.equal(fixture.requests.length, expectedRequests);
        assert.deepEqual(await fixture.history(), before);
        assert.equal(
          (await fixture.events()).filter(
            (event) => event.type === "context.compacted",
          ).length,
          0,
        );
        const records = await fixture.usageRecords();
        const report = reportModelUsageObservations(
          records[0]!.record,
          records,
        );
        assert.equal(report.compaction.usageReports, expectedRequests);
        assert.equal(report.failedResponses.usageReports, expectedRequests);
        assert.equal(report.total.inputTokens, expectedRequests * 100);
        await fixture.reopen();
        await fixture.worker().wake();
        assert.equal(fixture.requests.length, expectedRequests);
        assert.deepEqual(await fixture.history(), before);
        assert.deepEqual(await fixture.usageRecords(), records);
      },
    );
  }
}
