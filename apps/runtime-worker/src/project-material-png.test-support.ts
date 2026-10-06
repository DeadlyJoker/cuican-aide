import { crc32, deflateSync } from "node:zlib";
export const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export function pngChunk(name: string, data: Buffer) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(name, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])));
  return Buffer.concat([header, data, crc]);
}
export function pngHeader(width = 2, height = 1, colorType = 2) {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(width, 0);
  b.writeUInt32BE(height, 4);
  b[8] = 8;
  b[9] = colorType;
  return b;
}
export function materialPng(width = 2, height = 1, colorType = 2) {
  return Buffer.concat([
    pngSignature,
    pngChunk("IHDR", pngHeader(width, height, colorType)),
    pngChunk(
      "IDAT",
      deflateSync(
        Buffer.alloc((width * (colorType === 2 ? 3 : 4) + 1) * height),
      ),
    ),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
