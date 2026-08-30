import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const raw = execFileSync(
  "pnpm",
  [
    "--filter",
    "@crewon/runtime-worker",
    "licenses",
    "list",
    "--prod",
    "--json",
  ],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const report = JSON.parse(raw);
const allowedLicenses = new Set(["MIT", "BSD-3-Clause", "ISC"]);
const denied = Object.keys(report).filter(
  (license) => !allowedLicenses.has(license),
);
if (denied.length > 0) {
  throw new Error(
    `Runtime Worker production dependency licenses require review: ${denied.join(", ")}`,
  );
}

const packages = new Set(
  Object.values(report)
    .flat()
    .map((entry) => entry.name),
);
if (!packages.has("uuid")) {
  throw new Error("Runtime Worker production license report omitted uuid");
}
