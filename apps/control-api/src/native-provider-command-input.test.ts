import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { readNativeProviderCommand } from "./native-provider-command-input.ts";

for (const ending of ["\n", "\r\n", "\r", ""]) {
  test(`native command accepts fragmented UTF-8 with ${JSON.stringify(ending)} termination`, async () => {
    const value = { phase: "inspect", label: "配置🙂" };
    const data = Buffer.from(JSON.stringify(value) + ending);
    const input = Readable.from([...data].map((byte) => Buffer.from([byte])));
    assert.deepEqual(await readNativeProviderCommand(input), value);
    assert.equal(input.destroyed, true);
  });
}

test("native command accepts exactly 64 KiB and stops after the first record", async () => {
  const value = "x".repeat(64 * 1024 - 2);
  const data = Buffer.from(JSON.stringify(value) + "\nignored second record\n");
  assert.equal(await readNativeProviderCommand(Readable.from([data])), value);
});

test("unterminated overflow rejects and closes the input before reading later chunks", async () => {
  let reads = 0;
  let closed = false;
  async function* input() {
    try {
      while (reads < 100_000) {
        reads++;
        yield Buffer.alloc(1024, 120);
      }
    } finally {
      closed = true;
    }
  }
  await assert.rejects(
    readNativeProviderCommand(input()),
    /provider_native_command_invalid/u,
  );
  assert.equal(reads, 65);
  assert.equal(closed, true);
});

test("an oversized single chunk rejects and closes its native stream", async () => {
  const input = Readable.from([Buffer.alloc(64 * 1024 + 1, 120)]);
  await assert.rejects(
    readNativeProviderCommand(input),
    /provider_native_command_invalid/u,
  );
  assert.equal(input.destroyed, true);
});

test("a complete command resolves without waiting for EOF", async (t) => {
  const input = new PassThrough();
  t.after(() => input.destroy());
  const result = readNativeProviderCommand(input);
  input.write('{"phase":"inspect"}\n');
  assert.deepEqual(await result, { phase: "inspect" });
  assert.equal(input.destroyed, true);
});

test("empty, malformed and failed command streams do not disclose their contents", async () => {
  const secret = "private-provider-credential";
  for (const input of [
    Readable.from([]),
    Readable.from([Buffer.from(`{"secret":"${secret}" nope}\n`)]),
    Readable.from(
      (async function* () {
        throw new Error(secret);
        yield Buffer.alloc(0);
      })(),
    ),
  ]) {
    await assert.rejects(readNativeProviderCommand(input), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "provider_native_command_invalid");
      assert.equal(error.cause, undefined);
      assert.equal(String(error.stack).includes(secret), false);
      return true;
    });
    assert.equal(input.destroyed, true);
  }
});
