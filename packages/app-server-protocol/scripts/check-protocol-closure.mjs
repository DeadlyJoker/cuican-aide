#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(packageRoot, "src");

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && extname(entry.name) === ".ts" ? [path] : [];
  });
}

const failures = [];
const files = sourceFiles(sourceRoot);
for (const file of files) {
  const content = readFileSync(file, "utf8");
  if (/codex-rs|\btauri\b|cargo\s+/iu.test(content)) {
    failures.push(
      `${relative(packageRoot, file)} contains a retired runtime reference`,
    );
  }
  for (const match of content.matchAll(
    /\bfrom\s+["'](\.{1,2}\/[^"']+)["']/gu,
  )) {
    const target = resolve(dirname(file), `${match[1]}.ts`);
    const outsideSource =
      target !== sourceRoot && !target.startsWith(`${sourceRoot}${sep}`);
    if (outsideSource || !existsSync(target)) {
      failures.push(
        `${relative(packageRoot, file)} has unresolved import ${match[1]}`,
      );
    }
  }
}

if (failures.length > 0) {
  throw new Error(failures.join("\n"));
}

console.log(
  `Verified ${files.length} self-contained TypeScript protocol files.`,
);
