import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const setupScript = path.join(currentDirectory, "pim-setup-crewon-agent.ts");

function runSetup(environment) {
  const env = { ...process.env, ...environment };
  delete env.PIM_BASE_URL;
  delete env.PIM_ADMIN_USERNAME;
  delete env.PIM_ADMIN_PASSWORD;
  Object.assign(env, environment);

  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", setupScript],
    { encoding: "utf8", env },
  );
}

test("PIM setup fails closed when explicit connection settings are absent", () => {
  const result = runSetup({});

  assert.equal(result.status, 1);
  assert.match(result.stderr, /PIM_BASE_URL is required/);
  assert.doesNotMatch(result.stderr, /fetch failed/i);
});

test("PIM setup rejects plaintext non-loopback endpoints before authentication", () => {
  const result = runSetup({
    PIM_BASE_URL: "http://example.com",
    PIM_ADMIN_USERNAME: "test-user",
    PIM_ADMIN_PASSWORD: "test-only",
  });

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /PIM_BASE_URL must use HTTPS unless it targets loopback/,
  );
  assert.doesNotMatch(result.stderr, /fetch failed/i);
});

test("PIM setup rejects credentials embedded in its base URL", () => {
  const result = runSetup({
    PIM_BASE_URL: "https://user:password@example.com",
    PIM_ADMIN_USERNAME: "test-user",
    PIM_ADMIN_PASSWORD: "test-only",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /PIM_BASE_URL must not contain credentials/);
  assert.doesNotMatch(result.stderr, /fetch failed/i);
});
