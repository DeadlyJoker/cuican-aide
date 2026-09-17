import { dirname, resolve, basename } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { archiveRendererHeaps } from "./soak/archive-renderer-heap.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const argument = process.argv[2];
if (process.argv.length !== 3 || !argument)
  throw new Error("soak_heap_archive_argument_invalid");
const root = await realpath(resolve(argument)),
  parent = await realpath(resolve(repository, ".crewon/soak-runs"));
if (dirname(root) !== parent || !/^run-[A-Za-z0-9_-]+$/.test(basename(root)))
  throw new Error("soak_heap_archive_root_invalid");
process.stdout.write(
  JSON.stringify(await archiveRendererHeaps(root), null, 2) + "\n",
);
