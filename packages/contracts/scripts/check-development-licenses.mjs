import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const raw = execFileSync(
  "pnpm",
  ["--filter", "@crewon/contracts", "licenses", "list", "--dev", "--json"],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const report = JSON.parse(raw);
const allowedLicenses = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "Python-2.0",
  "(MIT OR CC0-1.0)",
]);
const denied = Object.keys(report).filter(
  (license) => !allowedLicenses.has(license),
);
if (denied.length > 0) {
  throw new Error(
    `Contracts development dependency licenses require review: ${denied.join(", ")}`,
  );
}

const packages = new Set(
  Object.values(report)
    .flat()
    .map((entry) => entry.name),
);
for (const required of ["openapi-typescript", "prettier", "typescript"]) {
  if (!packages.has(required)) {
    throw new Error(`Contracts development license report omitted ${required}`);
  }
}
