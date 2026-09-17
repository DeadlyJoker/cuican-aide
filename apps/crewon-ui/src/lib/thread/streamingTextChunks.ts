const CHUNK_UNITS = 4096;
type Chunk = { data: Uint16Array; start: number; end: number };

/** Owned UTF-16 pages: consuming a prefix cannot retain a huge sliced string. */
export class StreamingTextChunks {
  readonly #chunks: Chunk[] = [];
  #length = 0;
  get length() {
    return this.#length;
  }
  get allocatedBytes() {
    return this.#chunks.length * CHUNK_UNITS * 2;
  }

  capacityAfterAppend(units: number): number {
    const tail = this.#chunks.at(-1);
    const free = tail ? CHUNK_UNITS - tail.end : 0;
    return (
      this.allocatedBytes +
      Math.ceil(Math.max(0, units - free) / CHUNK_UNITS) * CHUNK_UNITS * 2
    );
  }

  append(value: string): void {
    let offset = 0;
    while (offset < value.length) {
      let chunk = this.#chunks.at(-1);
      if (!chunk || chunk.end === CHUNK_UNITS) {
        chunk = { data: new Uint16Array(CHUNK_UNITS), start: 0, end: 0 };
        this.#chunks.push(chunk);
      }
      const count = Math.min(value.length - offset, CHUNK_UNITS - chunk.end);
      for (let index = 0; index < count; index++)
        chunk.data[chunk.end + index] = value.charCodeAt(offset + index);
      chunk.end += count;
      offset += count;
      this.#length += count;
    }
  }

  take(codePoints: number): string {
    const units: number[] = [];
    for (let index = 0; index < codePoints && this.#length > 0; index++) {
      const first = this.#takeUnit();
      units.push(first);
      if (isHigh(first) && this.#length > 0 && isLow(this.#peekUnit()))
        units.push(this.#takeUnit());
    }
    return fromUnits(units);
  }

  tail(maxUnits: number): string {
    const skip = Math.max(0, this.#length - maxUnits);
    const units: number[] = [];
    let offset = 0,
      previous = -1;
    for (const chunk of this.#chunks)
      for (let index = chunk.start; index < chunk.end; index++) {
        const unit = chunk.data[index]!;
        if (
          offset >= skip &&
          !(offset === skip && skip > 0 && isLow(unit) && isHigh(previous))
        )
          units.push(unit);
        previous = unit;
        offset++;
      }
    return fromUnits(units);
  }

  clear(): void {
    this.#chunks.length = 0;
    this.#length = 0;
  }
  #peekUnit(): number {
    const chunk = this.#chunks[0]!;
    return chunk.data[chunk.start]!;
  }
  #takeUnit(): number {
    const chunk = this.#chunks[0]!,
      unit = chunk.data[chunk.start++]!;
    this.#length--;
    if (chunk.start === chunk.end) this.#chunks.shift();
    return unit;
  }
}

export function boundedStreamingTail(
  value: string,
  maxUnits: number,
): { text: string; truncated: boolean } {
  if (value.length <= maxUnits) return { text: value, truncated: false };
  let start = value.length - maxUnits;
  if (isLow(value.charCodeAt(start)) && isHigh(value.charCodeAt(start - 1)))
    start++;
  const units: number[] = [];
  for (let index = start; index < value.length; index++)
    units.push(value.charCodeAt(index));
  return { text: fromUnits(units), truncated: true };
}

export function appendStreamingTail(
  prefix: string,
  delta: string,
  maxUnits: number,
): { text: string; truncated: boolean } {
  if (delta.length > maxUnits) return boundedStreamingTail(delta, maxUnits);
  return boundedStreamingTail(prefix + delta, maxUnits);
}
function isHigh(unit: number) {
  return unit >= 0xd800 && unit <= 0xdbff;
}
function isLow(unit: number) {
  return unit >= 0xdc00 && unit <= 0xdfff;
}
function fromUnits(units: readonly number[]): string {
  const parts: string[] = [];
  for (let offset = 0; offset < units.length; offset += 1024)
    parts.push(String.fromCharCode(...units.slice(offset, offset + 1024)));
  return parts.join("");
}
