import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
if (!process.version.startsWith("v24.") || process.argv.length !== 2)
  throw new Error("short_drama_sdk_node_24_no_arguments_required");
if (
  !execFileSync("pnpm", ["--version"], { encoding: "utf8" })
    .trim()
    .startsWith("10.")
)
  throw new Error("short_drama_sdk_pnpm_10_required");
const destination = join(root, "examples/plugins/short-drama/.sdk");
const archive = join(destination, "crewon-plugin-sdk.tgz");
const record = join(destination, "manifest.json");
await mkdir(destination, { recursive: true, mode: 0o700 });
if (!(await lstat(destination)).isDirectory())
  throw new Error("short_drama_sdk_directory_invalid");
try {
  const previous = JSON.parse(await readFile(record, "utf8"));
  const bytes = await readFile(archive);
  if (
    previous.owner !== "crewon.short-drama.sdk-preparation.v1" ||
    previous.sha256 !== createHash("sha256").update(bytes).digest("hex")
  )
    throw new Error("short_drama_sdk_existing_artifact_unowned");
} catch (cause) {
  const exists = await lstat(archive).catch(() => null);
  if (exists !== null) throw cause;
}
const staging = await mkdtemp(join(tmpdir(), "crewon-short-drama-sdk-"));
try {
  // prepack builds the existing SDK; no registry publication or separate runtime is involved.
  execFileSync("pnpm", ["pack", "--pack-destination", staging], {
    cwd: join(root, "packages/plugin-sdk"),
    stdio: "inherit",
    timeout: 60000,
  });
  const candidates = (await readdir(staging)).filter((name) =>
    /^crewon-plugin-sdk-\d+\.\d+\.\d+\.tgz$/u.test(name),
  );
  if (candidates.length !== 1)
    throw new Error("short_drama_sdk_archive_invalid");
  const bytes = await readFile(join(staging, candidates[0]!));
  const manifest = JSON.parse(
    await readFile(join(root, "packages/plugin-sdk/package.json"), "utf8"),
  );
  const ownership = {
    owner: "crewon.short-drama.sdk-preparation.v1",
    version: manifest.version,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const newArchive = join(destination, "crewon-plugin-sdk.next.tgz");
  const newRecord = join(destination, "manifest.next.json");
  await writeFile(newArchive, bytes, { flag: "wx", mode: 0o600 });
  await writeFile(newRecord, `${JSON.stringify(ownership, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(newArchive, archive);
  await rename(newRecord, record);
  console.log(
    `Prepared SDK ${manifest.version} at examples/plugins/short-drama/.sdk/crewon-plugin-sdk.tgz`,
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
