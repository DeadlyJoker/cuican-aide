import { describe, expect, it } from "vitest";
import {
  CONTEXT_COMPACTION_PROMPT,
  CONTEXT_COMPACTION_SUMMARY_PREFIX,
} from "../../../../packages/context/src/index.ts";
import { createSoakWorkloadModel } from "./workload-model.ts";
import { SOAK_FILE_CONTENT, SOAK_READ_TOOL } from "./tool-fixture.ts";

const user = {
  role: "user",
  content:
    "SOAK-tool-1 Read fixture.txt four times, then return the fixture acknowledgement.",
};
const tools = [{ type: "function", name: SOAK_READ_TOOL }];
const output = (call: { call_id: string }) => ({
  type: "function_call_output",
  call_id: call.call_id,
  output:
    "read\n[structured]\n" +
    JSON.stringify({
      path: "fixture.txt",
      content: SOAK_FILE_CONTENT,
      byteLength: Buffer.byteLength(SOAK_FILE_CONTENT),
      truncated: false,
    }),
});

describe("fixture checkpoint semantics", () => {
  it("resumes after a mid-task compaction without repeating a completed read", () => {
    const model = createSoakWorkloadModel();
    const first = model.evaluate({ input: [user], tools }).call!;
    const compacted = model.evaluate({
      input: [
        user,
        first,
        output(first),
        { role: "user", content: CONTEXT_COMPACTION_PROMPT },
      ],
      tools: [],
    });
    expect(compacted.call).toBeNull();
    expect(compacted.summary).toBeTruthy();
    const input: Record<string, unknown>[] = [
      user,
      {
        role: "user",
        content: `${CONTEXT_COMPACTION_SUMMARY_PREFIX}\n${compacted.summary}`,
      },
    ];
    for (let step = 2; step <= 4; step++) {
      const decision = model.evaluate({ input, tools });
      expect(decision.resumedToolProgress).toBe(true);
      expect(decision.call?.call_id).toBe(`fixture_SOAK-tool-1_${step}`);
      input.push(decision.call!, output(decision.call!));
    }
    const final = model.evaluate({ input, tools });
    expect(final).toMatchObject({
      marker: "SOAK-tool-1",
      call: null,
      summary: null,
      tool: true,
    });
  });
  it("rejects changed or unrecognized persisted summaries", () => {
    const model = createSoakWorkloadModel();
    const summary = model.evaluate({
      input: [user, { role: "user", content: CONTEXT_COMPACTION_PROMPT }],
      tools: [],
    }).summary!;
    for (const body of [
      summary.replace('"completedReads":0', '"completedReads":4'),
      "some other summary",
    ]) {
      expect(() =>
        model.evaluate({
          input: [
            user,
            {
              role: "user",
              content: `${CONTEXT_COMPACTION_SUMMARY_PREFIX}\n${body}`,
            },
          ],
          tools,
        }),
      ).toThrow(/soak_summary_/);
    }
  });
  it("does not allow compaction to hide an incomplete tool call or premature final", () => {
    const model = createSoakWorkloadModel(),
      call = model.evaluate({ input: [user], tools }).call!;
    for (const tail of [
      [call],
      [{ role: "assistant", content: "ACK SOAK-tool-1\n" }],
    ]) {
      expect(() =>
        model.evaluate({
          input: [
            user,
            ...tail,
            { role: "user", content: CONTEXT_COMPACTION_PROMPT },
          ],
          tools: [],
        }),
      ).toThrow();
    }
  });
  it("rejects a valid checkpoint attached to another current task", () => {
    const model = createSoakWorkloadModel();
    const summary = model.evaluate({
      input: [user, { role: "user", content: CONTEXT_COMPACTION_PROMPT }],
      tools: [],
    }).summary!;
    expect(() =>
      model.evaluate({
        input: [
          {
            ...user,
            content: user.content.replace("SOAK-tool-1", "SOAK-tool-2"),
          },
          {
            role: "user",
            content: `${CONTEXT_COMPACTION_SUMMARY_PREFIX}\n${summary}`,
          },
        ],
        tools,
      }),
    ).toThrow("soak_summary_task_identity_invalid");
  });
  it("new user input resets completed task progress while retaining the validated checkpoint", () => {
    const model = createSoakWorkloadModel();
    const summary = model.evaluate({
      input: [
        { role: "user", content: "SOAK-1 Return the fixture acknowledgement." },
        { role: "assistant", content: "ACK SOAK-1\n" },
        { role: "user", content: CONTEXT_COMPACTION_PROMPT },
      ],
      tools: [],
    }).summary!;
    const checkpoint = {
      role: "user",
      content: `${CONTEXT_COMPACTION_SUMMARY_PREFIX}\n${summary}`,
    };
    expect(() => model.evaluate({ input: [checkpoint], tools: [] })).toThrow(
      "soak_sampling_after_completed_task",
    );
    expect(
      model.evaluate({ input: [checkpoint, user], tools }).call?.call_id,
    ).toBe("fixture_SOAK-tool-1_1");
  });
});
