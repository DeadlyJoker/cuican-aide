#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const storeSource = join(root, "packages", "store", "src");
const expectedSkip =
  "Postgres Provider authority requires CREWON_TEST_POSTGRES_URL";
const maximumOutputBytes = 16 * 1024 * 1024;

export function validatePostgresStoreContractTap(output) {
  const summary = Object.fromEntries(
    ["tests", "pass", "fail", "cancelled", "skipped"].map((name) => [
      name,
      summaryValue(output, name),
    ]),
  );
  const skipped = [
    ...output.matchAll(/^\s*ok \d+ - (.*?) # SKIP(?:\s|$)/gmu),
  ].map((match) => match[1]);
  if (
    summary.tests < 608 ||
    summary.pass !== summary.tests - 1 ||
    summary.fail !== 0 ||
    summary.cancelled !== 0 ||
    summary.skipped !== 1 ||
    skipped.length !== 1 ||
    skipped[0] !== expectedSkip
  ) {
    throw new Error("postgres_store_contract_summary_invalid");
  }
  return summary;
}

function summaryValue(output, name) {
  const matches = [...output.matchAll(new RegExp(`^# ${name} (\\d+)$`, "gmu"))];
  const value = Number(matches.at(-1)?.[1]);
  if (!Number.isSafeInteger(value))
    throw new Error(`postgres_store_contract_${name}_missing`);
  return value;
}

async function run() {
  const postgresUrl = process.env.CREWON_TEST_POSTGRES_URL?.trim();
  if (!/^postgres(?:ql)?:\/\//u.test(postgresUrl ?? ""))
    throw new Error("postgres_store_contract_url_required");
  const files = readdirSync(storeSource)
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => join(storeSource, name));
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--test",
      "--test-concurrency=1",
      "--test-reporter=tap",
      ...files,
    ],
    { cwd: root, env: process.env, stdio: ["ignore", "pipe", "inherit"] },
  );
  let output = "";
  child.stdout?.on("data", (chunk) => {
    process.stdout.write(chunk);
    output += String(chunk);
    if (Buffer.byteLength(output) > maximumOutputBytes) child.kill("SIGKILL");
  });
  const [code, signal] = await once(child, "exit");
  if (code !== 0 || signal !== null)
    throw new Error("postgres_store_contract_tests_failed");
  validatePostgresStoreContractTap(output);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "postgres_store_contract_gate_failed"}\n`,
    );
    process.exitCode = 1;
  }
}
