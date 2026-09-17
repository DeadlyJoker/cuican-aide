export const MAX_RUNTIME_LOG_WRITE_BYTES = 16 * 1024;
export type RuntimeLogChannel = "stdout" | "stderr";
export type RuntimeLogWrite = Readonly<{
  kind: "write";
  id: number;
  channel: RuntimeLogChannel;
  bytes: Uint8Array;
}>;
export type RuntimeLogWritten = Readonly<{
  kind: "written";
  id: number;
  channel: RuntimeLogChannel;
  failed: boolean;
  rssBytes: number;
}>;
