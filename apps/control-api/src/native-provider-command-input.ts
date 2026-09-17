const MAX_COMMAND_BYTES = 64 * 1024;

/** One process command, bounded before its line terminator or EOF arrives. */
export async function readNativeProviderCommand(
  input: AsyncIterable<Uint8Array>,
): Promise<unknown> {
  const buffer = Buffer.alloc(MAX_COMMAND_BYTES);
  let length = 0;
  const parse = () => JSON.parse(buffer.toString("utf8", 0, length)) as unknown;
  try {
    for await (const chunk of input) {
      const delimiter = chunk
        .subarray(0, MAX_COMMAND_BYTES - length + 1)
        .findIndex((byte) => byte === 10 || byte === 13);
      const bytes = delimiter === -1 ? chunk.length : delimiter;
      if (bytes > MAX_COMMAND_BYTES - length) throw new Error();
      buffer.set(chunk.subarray(0, bytes), length);
      length += bytes;
      if (delimiter !== -1) return parse();
    }
    return parse();
  } catch {
    // Parser errors can contain provider credentials from the input line.
    throw new Error("provider_native_command_invalid");
  }
}
