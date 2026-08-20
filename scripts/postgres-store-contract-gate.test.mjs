import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validatePostgresStoreContractTap } from "./postgres-store-contract-gate.mjs";

const postgresImage =
  "postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685";

test("accepts only a full PostgreSQL Store run with the reverse sentinel skipped", () => {
  const output = tap({
    tests: 608,
    pass: 607,
    skipped: ["Postgres Provider authority requires CREWON_TEST_POSTGRES_URL"],
  });
  assert.deepEqual(validatePostgresStoreContractTap(output), {
    tests: 608,
    pass: 607,
    fail: 0,
    cancelled: 0,
    skipped: 1,
  });
  for (const invalid of [
    tap({
      tests: 607,
      pass: 606,
      skipped: [
        "Postgres Provider authority requires CREWON_TEST_POSTGRES_URL",
      ],
    }),
    tap({ tests: 608, pass: 607, skipped: ["conditional production test"] }),
    tap({
      tests: 609,
      pass: 607,
      fail: 1,
      skipped: [
        "Postgres Provider authority requires CREWON_TEST_POSTGRES_URL",
      ],
    }),
  ]) {
    assert.throws(
      () => validatePostgresStoreContractTap(invalid),
      /summary_invalid/u,
    );
  }
});

test("required and server release workflows run the pinned PostgreSQL 16 gate", () => {
  const gate = readFileSync(
    new URL("./postgres-store-contract-gate.mjs", import.meta.url),
    "utf8",
  );
  assert.match(gate, /"--test-concurrency=1"/u);
  for (const path of [
    ".github/workflows/ci.yml",
    ".github/workflows/server-release.yml",
  ]) {
    const workflow = readFileSync(
      new URL(`../${path}`, import.meta.url),
      "utf8",
    );
    assert.ok(workflow.includes(`image: ${postgresImage}`));
    assert.match(workflow, /node scripts\/postgres-store-contract-gate\.mjs/u);
    assert.match(workflow, /pnpm production:postgres-smoke/u);
  }
});

function tap({ tests, pass, fail = 0, cancelled = 0, skipped }) {
  return `${skipped.map((name, index) => `ok ${index + 1} - ${name} # SKIP`).join("\n")}
1..${tests}
# tests ${tests}
# pass ${pass}
# fail ${fail}
# cancelled ${cancelled}
# skipped ${skipped.length}
`;
}
