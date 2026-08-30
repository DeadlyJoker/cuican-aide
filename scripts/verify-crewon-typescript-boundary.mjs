#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootPackage = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8"),
);

const failures = [];
for (const name of ["control:web", "ui:dev", "crewon:dev"]) {
  if (
    rootPackage.scripts?.[name] !== "node scripts/crewon-control-web-dev.mjs"
  ) {
    failures.push(`${name} must use the TypeScript Control runtime`);
  }
}
if ("crewon:app-server" in (rootPackage.scripts ?? {})) {
  failures.push("crewon:app-server is a retired Rust development entry");
}

for (const relativePath of [
  "apps/crewon-ui/package.json",
  "apps/crewon-ui/src/lib/demo/demoContent.ts",
  "apps/crewon-ui/tsconfig.json",
  "scripts/stage-desktop-runtime.ts",
]) {
  const content = readFileSync(join(repositoryRoot, relativePath), "utf8");
  if (
    /codex-rs|crewon-app-server|rust-backend|@crewon-protocol|@crewon-platform-protocol|\btauri\b|cargo\s+/iu.test(
      content,
    )
  ) {
    failures.push(`${relativePath} crosses the CrewON TypeScript boundary`);
  }
}

if (failures.length > 0) {
  throw new Error(failures.join("\n"));
}

console.log(
  "Verified CrewON build and development entry points are TypeScript-only.",
);
