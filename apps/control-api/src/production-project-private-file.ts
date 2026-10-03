import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const MAX_BYTES = 64 * 1024;

/** A deployment-owned file snapshot; neither links nor a concurrent replacement are accepted. */
export async function readProductionProjectPrivateFile(
  input: unknown,
): Promise<string> {
  const path = privatePath(input);
  if (process.platform === "win32" || typeof process.getuid !== "function")
    invalid();
  const uid = BigInt(process.getuid());
  const original = await lstat(path, { bigint: true });
  if (!isPrivateFile(original, uid) || (await realpath(path)) !== path)
    invalid();
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!isPrivateFile(before, uid) || !sameFile(original, before)) invalid();
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (
      size > MAX_BYTES ||
      BigInt(size) !== before.size ||
      !isPrivateFile(after, uid) ||
      !isPrivateFile(current, uid) ||
      !sameFile(before, after) ||
      !sameFile(before, current) ||
      (await realpath(path)) !== path
    )
      invalid();
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, size),
    );
  } finally {
    await handle.close();
  }
}

function privatePath(input: unknown): string {
  if (
    typeof input !== "string" ||
    !isAbsolute(input) ||
    resolve(input) !== input ||
    input.trim() !== input ||
    Buffer.byteLength(input) > 4096 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input)
  )
    invalid();
  for (const point of input) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) invalid();
  }
  return input;
}

function isPrivateFile(stat: BigIntStats, uid: bigint): boolean {
  return (
    stat.isFile() &&
    stat.uid === uid &&
    stat.nlink === 1n &&
    (stat.mode & 0o077n) === 0n &&
    stat.size > 0n &&
    stat.size <= BigInt(MAX_BYTES)
  );
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.uid === b.uid &&
    a.mode === b.mode &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

function invalid(): never {
  throw new Error("production_project_configuration_invalid");
}
