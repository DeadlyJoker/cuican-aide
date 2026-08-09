import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const output = execFileSync(
  "pnpm",
  [
    "--filter",
    "@crewon/device-gateway",
    "licenses",
    "list",
    "--prod",
    "--json",
  ],
  {
    encoding: "utf8",
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const licenses = JSON.parse(output);
const allowed = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause"]);
for (const [license, dependencies] of Object.entries(licenses)) {
  assert.ok(
    allowed.has(license),
    `device_gateway_license_disallowed:${license}`,
  );
  assert.ok(Array.isArray(dependencies));
}
assert.equal(
  licenses.MIT?.some(
    (dependency) =>
      dependency.name === "ws" &&
      dependency.versions.length === 1 &&
      dependency.versions[0] === "8.21.1",
  ),
  true,
  "device_gateway_ws_pin_missing",
);
assert.equal(
  licenses.MIT?.some(
    (dependency) =>
      dependency.name === "pg" &&
      dependency.versions.length === 1 &&
      dependency.versions[0] === "8.22.0",
  ),
  true,
  "device_gateway_pg_pin_missing",
);
