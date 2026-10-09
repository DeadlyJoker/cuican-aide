import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const files = [
  "package.json",
  "tsconfig.json",
  "build.mjs",
  "README.md",
  "src/metadata.ts",
  "src/node.ts",
] as const;

/** Only a newly created directory is populated; existing user directories are never overwritten. */
export async function scaffoldMinimalPlugin(
  directory: string,
): Promise<readonly string[]> {
  const templates = new URL("./templates/minimal/", import.meta.url);
  const contents = await Promise.all(
    files.map((path) => readFile(new URL(path, templates))),
  );
  await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, "src"), { mode: 0o700 });
  for (let index = 0; index < files.length; index++)
    await writeFile(join(directory, files[index]!), contents[index]!, {
      flag: "wx",
      mode: 0o600,
    });
  // On partial failure, leave generated files visible; never recursively remove user additions.
  return files;
}
