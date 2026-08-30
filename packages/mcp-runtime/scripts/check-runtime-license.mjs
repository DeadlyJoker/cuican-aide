import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const report = JSON.parse(
  execFileSync(
    "pnpm",
    ["--filter", "@crewon/mcp-runtime", "licenses", "list", "--prod", "--json"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ),
);
const allowedLicenses = new Set(["MIT", "BSD-3-Clause", "BSD-2-Clause", "ISC"]);
const denied = Object.keys(report).filter(
  (license) => !allowedLicenses.has(license),
);
if (denied.length > 0) {
  throw new Error(
    "MCP runtime dependency licenses require review: " + denied.join(", "),
  );
}
const sdk = Object.values(report)
  .flat()
  .find((entry) => entry.name === "@modelcontextprotocol/sdk");
if (sdk?.versions?.length !== 1 || sdk.versions[0] !== "1.26.0") {
  throw new Error("MCP runtime license report omitted pinned SDK 1.26.0");
}
