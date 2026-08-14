import assert from "node:assert/strict";
import test from "node:test";

import { CompatibleAutomationScheduleCalculator } from "./automation-schedule-calculator.ts";

const calculator = new CompatibleAutomationScheduleCalculator();

test("calculates bounded once and interval occurrences", () => {
  assert.equal(
    calculator.nextOccurrence({
      schedule: { kind: "once", at: "2026-08-10T10:00:00Z" },
      after: "2026-08-10T10:00:00Z",
      inclusive: true,
    }),
    "2026-08-10T10:00:00.000Z",
  );
  assert.equal(
    calculator.nextOccurrence({
      schedule: {
        kind: "interval",
        anchorAt: "2026-08-10T10:00:00Z",
        everySeconds: 300,
      },
      after: "2026-08-10T10:05:00Z",
      inclusive: false,
    }),
    "2026-08-10T10:10:00.000Z",
  );
});

test("uses compatible choices for DST gaps and folds", () => {
  assert.equal(
    calculator.nextOccurrence({
      schedule: {
        kind: "daily",
        localTime: "02:30",
        timezone: "America/New_York",
      },
      after: "2026-03-08T00:00:00Z",
      inclusive: true,
    }),
    "2026-03-08T07:30:00.000Z",
  );
  assert.equal(
    calculator.nextOccurrence({
      schedule: {
        kind: "daily",
        localTime: "01:30",
        timezone: "America/New_York",
      },
      after: "2026-11-01T00:00:00Z",
      inclusive: true,
    }),
    "2026-11-01T05:30:00.000Z",
  );
});
