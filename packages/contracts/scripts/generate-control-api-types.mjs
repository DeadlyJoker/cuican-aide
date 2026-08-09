import { readFile, writeFile } from "node:fs/promises";

import openapiTS, { astToString } from "openapi-typescript";
import { format } from "prettier";

const schemaUrl = new URL("../openapi/control-api.v1.json", import.meta.url);
const outputUrl = new URL("../src/generated/control-api.ts", import.meta.url);
const generated = await format(
  `// This file is generated from openapi/control-api.v1.json. Do not edit.\n${astToString(await openapiTS(schemaUrl))}`,
  { parser: "typescript", quoteProps: "consistent" },
);

if (process.argv.includes("--check")) {
  const current = await readFile(outputUrl, "utf8");
  if (current !== generated) {
    throw new Error("generated Control API types are stale; run pnpm generate");
  }
} else {
  await writeFile(outputUrl, generated);
}
