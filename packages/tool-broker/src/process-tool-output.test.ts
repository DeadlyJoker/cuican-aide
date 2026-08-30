import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { formatProcessToolOutput } from "./process-tool-output.ts";

const reference = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/shell-tool-output.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Readonly<{
  cases: readonly Readonly<{
    exitCode: number;
    wallTimeSeconds: number;
    output: string;
    modelVisibleOutput: string;
  }>[];
}>;

test("matches the shared AR-014/015 process output format", () => {
  assert.deepEqual(
    reference.cases.map((fixture) =>
      formatProcessToolOutput({
        exitCode: fixture.exitCode,
        wallTimeSeconds: fixture.wallTimeSeconds,
        output: fixture.output,
      }),
    ),
    reference.cases.map((fixture) => fixture.modelVisibleOutput),
  );
});
