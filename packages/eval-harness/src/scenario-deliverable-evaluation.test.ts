import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  checkResourceSchedule,
  checkSeptemberMeetingNotice,
  type ResourceSchedule,
  type ResourceScheduleSpec,
} from "./scenario-deliverable-evaluation.ts";

// Captured by GUI submissions; read-only Control records retain the real artifacts.
const evidence = JSON.parse(
  readFileSync(
    new URL("../evidence/2026-09-07/team-scenarios-runs.json", import.meta.url),
    "utf8",
  ),
) as {
  web: Array<{ runId: string; output: string }>;
};
function artifact(runId: string) {
  const output = evidence.web.find((run) => run.runId === runId)?.output;
  assert.ok(output, `missing captured artifact ${runId}`);
  return output;
}
const correctedNotice = artifact("01a07b4b-d29c-73b6-8433-097b50a58652");
test("W1 real pre-approval draft fails the added approval deadline even if the verifier said PASS", () => {
  const result = checkSeptemberMeetingNotice(
    artifact("01a07b42-af83-713b-ba50-05f272813142"),
  );
  assert.equal(result.necessaryChecksPassed, false);
  assert.ok(result.findings.some(({ code }) => code === "approval_deadline"));
  assert.equal(
    checkSeptemberMeetingNotice("VERDICT: PASS").necessaryChecksPassed,
    false,
  );
});
test("W1-R2 real final notice retains required facts without treating lexical checks as semantic certification", () => {
  assert.deepEqual(checkSeptemberMeetingNotice(correctedNotice), {
    necessaryChecksPassed: true,
    humanSemanticReviewRequired: true,
    findings: [],
  });
});
for (const [name, source, replacement, code] of [
  ["wrong approval day", "9月9日18:00", "9月10日18:00", "approval_deadline"],
  ["wrong owner", "林娜", "周航", "approval_deadline"],
  ["negated deadline", "请于9月9日", "不用在9月9日", "approval_deadline"],
  ["wrong meeting time", "14:00—14:30", "14:00—15:00", "meeting_time"],
  [
    "invented link",
    "待主持人补充",
    "https://example.invalid/meeting",
    "unprovided_link",
  ],
  [
    "claimed approval",
    "讨论确认是否具备9月11日上线条件",
    "确定于9月11日上线",
    "unapproved_action_claim",
  ],
] as const) {
  test(`notice mutation: ${name}`, () => {
    assert.ok(correctedNotice.includes(source));
    const result = checkSeptemberMeetingNotice(
      correctedNotice.replace(source, replacement),
    );
    assert.equal(result.necessaryChecksPassed, false);
    assert.ok(result.findings.some((finding) => finding.code === code));
  });
}
test("format variants remain acceptable; sending claims and oversized inputs require review", () => {
  assert.equal(
    checkSeptemberMeetingNotice(
      correctedNotice
        .replace("9月9日", "9/9")
        .replaceAll("—", "至")
        .replaceAll("：", " | "),
    ).necessaryChecksPassed,
    true,
  );
  assert.equal(
    checkSeptemberMeetingNotice(`${correctedNotice}\n已发送给参会人。`)
      .necessaryChecksPassed,
    false,
  );
  assert.equal(
    checkSeptemberMeetingNotice("字".repeat(40_001)).necessaryChecksPassed,
    false,
  );
});

const spec: ResourceScheduleSpec = {
  deadlineDay: 5,
  dailyCapacity: { development: 1, testing: 1 },
  tasks: [
    { id: "A", development: 3, testing: 2, mandatory: true },
    { id: "B", development: 2, testing: 1, mandatory: false },
  ],
};
const slots = (
  taskId: string,
  stage: "development" | "testing",
  days: number[],
) => days.map((day) => ({ taskId, stage, day, effort: 1 }));
// Manual normalization of O2's A-first table; no model-facing answer format imposed.
const aFirst: ResourceSchedule = {
  release: ["A"],
  slots: [
    ...slots("A", "development", [1, 2, 3]),
    ...slots("A", "testing", [4, 5]),
    ...slots("B", "development", [4, 5]),
    ...slots("B", "testing", [6]),
  ],
};
const full = { ...aFirst, release: ["A", "B"] };
test("O2: A-only meets day 5; A+B requires day 6 under the A-first table", () => {
  assert.equal(checkResourceSchedule(spec, aFirst).necessaryChecksPassed, true);
  assert.deepEqual(
    checkResourceSchedule(spec, full).findings.map(({ code }) => code),
    ["deadline"],
  );
  assert.equal(
    checkResourceSchedule({ ...spec, deadlineDay: 6 }, full)
      .necessaryChecksPassed,
    true,
  );
});
test("O2: B-first is valid at day 7, not day 6", () => {
  const bFirst = {
    release: ["A", "B"],
    slots: [
      ...slots("B", "development", [1, 2]),
      ...slots("B", "testing", [3]),
      ...slots("A", "development", [3, 4, 5]),
      ...slots("A", "testing", [6, 7]),
    ],
  };
  assert.equal(
    checkResourceSchedule({ ...spec, deadlineDay: 6 }, bFirst)
      .necessaryChecksPassed,
    false,
  );
  assert.equal(
    checkResourceSchedule({ ...spec, deadlineDay: 7 }, bFirst)
      .necessaryChecksPassed,
    true,
  );
});
test("O2 counterexample: an extra tester cannot remove the next-day dependency", () => {
  const moreTesters = {
    ...spec,
    dailyCapacity: { development: 1, testing: 2 },
  };
  const wrong = {
    ...full,
    slots: full.slots.map((slot) =>
      slot.taskId === "B" && slot.stage === "testing"
        ? { ...slot, day: 5 }
        : slot,
    ),
  };
  assert.deepEqual(
    checkResourceSchedule(moreTesters, wrong).findings.map(({ code }) => code),
    ["test_dependency"],
  );
  assert.equal(
    checkResourceSchedule(moreTesters, full).necessaryChecksPassed,
    false,
  );
});

test("GUI candidate: an explicitly added developer permits the proposed day-5 schedule", () => {
  const candidate = {
    release: ["A", "B"],
    slots: [
      ...slots("A", "development", [1, 2, 3]),
      ...slots("B", "development", [1, 2]),
      ...slots("B", "testing", [3]),
      ...slots("A", "testing", [4, 5]),
    ],
  };
  // The same plan is not feasible under the original single-developer spec.
  assert.equal(
    checkResourceSchedule(spec, candidate).necessaryChecksPassed,
    false,
  );
  assert.equal(
    checkResourceSchedule(
      { ...spec, dailyCapacity: { development: 2, testing: 1 } },
      candidate,
    ).necessaryChecksPassed,
    true,
  );
});
test("O2 counterexample: reducing QA effort alone still cannot test B on its development completion day", () => {
  const lessTesting = {
    ...spec,
    tasks: spec.tasks.map((task) => ({ ...task, testing: 0.5 })),
  };
  const wrong = {
    ...full,
    slots: [
      ...full.slots.filter((slot) => slot.stage === "development"),
      { taskId: "A", stage: "testing" as const, day: 4, effort: 0.5 },
      { taskId: "B", stage: "testing" as const, day: 5, effort: 0.5 },
    ],
  };
  assert.deepEqual(
    checkResourceSchedule(lessTesting, wrong).findings.map(({ code }) => code),
    ["test_dependency"],
  );
});
test("rejects overbooking, skipped tests and dropping mandatory scope", () => {
  const overbooked = {
    ...aFirst,
    slots: aFirst.slots.map((slot) =>
      slot.taskId === "B" && slot.stage === "development" && slot.day === 4
        ? { ...slot, day: 3 }
        : slot,
    ),
  };
  assert.ok(
    checkResourceSchedule(spec, overbooked).findings.some(
      ({ code }) => code === "daily_capacity",
    ),
  );
  assert.ok(
    checkResourceSchedule(spec, {
      ...full,
      slots: full.slots.filter(
        (slot) => slot.taskId !== "B" || slot.stage !== "testing",
      ),
    }).findings.some(({ code }) => code === "task_effort"),
  );
  assert.ok(
    checkResourceSchedule(spec, { ...aFirst, release: [] }).findings.some(
      ({ code }) => code === "mandatory_scope",
    ),
  );
});
test("fails closed on malformed or empty schedules and never certifies prose", () => {
  for (const candidate of [
    { release: ["A"], slots: [] },
    { release: ["unknown"], slots: [] },
    {
      ...aFirst,
      slots: [{ taskId: "A", stage: "testing" as const, day: NaN, effort: 1 }],
    },
    { ...aFirst, release: ["A", "A"] },
  ])
    assert.equal(
      checkResourceSchedule(spec, candidate).necessaryChecksPassed,
      false,
    );
  assert.equal(
    checkResourceSchedule({ ...spec, tasks: [] }, aFirst).necessaryChecksPassed,
    false,
  );
  assert.equal(
    checkResourceSchedule(spec, aFirst).humanSemanticReviewRequired,
    true,
  );
});
