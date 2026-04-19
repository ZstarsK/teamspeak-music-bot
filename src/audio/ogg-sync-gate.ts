import { Transform, type TransformCallback } from "node:stream";

export interface OggSyncGateStats {
  inputBytes: number;
  outputBytes: number;
  discardedBytes: number;
  bufferedBytes: number;
  mode: "passthrough" | "discard" | "sync";
  syncReason: string | null;
  syncHits: number;
}

export interface OggSyncGateEndDiscardOptions {
  syncToOggPage?: boolean;
}

const OGG_CAPTURE = Buffer.from("OggS");
const OGG_HEADER_MIN_BYTES = 6;
const OGG_PAGE_HEADER_BYTES = 27;
const OGG_BOS_FLAG = 0x02;
const SYNC_BUFFER_KEEP_BYTES = 64;

const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i++) {
    let value = i << 24;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 0x80000000) !== 0
        ? ((value << 1) ^ 0x04c11db7)
        : value << 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

interface OggBosSearchResult {
  index: number;
  keepFrom: number | null;
}

function calculateOggCrc(page: Buffer): number {
  let crc = 0;
  for (let i = 0; i < page.length; i++) {
    const byte = i >= 22 && i < 26 ? 0 : page[i];
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) & 0xff) ^ byte]) >>> 0;
  }
  return crc >>> 0;
}

function hasValidOggCrc(page: Buffer): boolean {
  return page.length >= OGG_PAGE_HEADER_BYTES && page.readUInt32LE(22) === calculateOggCrc(page);
}

function findOggBosPage(buffer: Buffer): OggBosSearchResult {
  let searchFrom = 0;
  while (searchFrom <= buffer.length - OGG_CAPTURE.length) {
    const index = buffer.indexOf(OGG_CAPTURE, searchFrom);
    if (index < 0) break;

    const remaining = buffer.length - index;
    if (remaining < OGG_HEADER_MIN_BYTES) {
      return { index: -1, keepFrom: index };
    }
    if (buffer[index + 4] !== 0 || (buffer[index + 5] & OGG_BOS_FLAG) !== OGG_BOS_FLAG) {
      searchFrom = index + 1;
      continue;
    }
    if (remaining < OGG_PAGE_HEADER_BYTES) {
      return { index: -1, keepFrom: index };
    }

    const segmentCount = buffer[index + 26];
    const segmentTableEnd = index + OGG_PAGE_HEADER_BYTES + segmentCount;
    if (buffer.length < segmentTableEnd) {
      return { index: -1, keepFrom: index };
    }

    let payloadBytes = 0;
    for (let i = index + OGG_PAGE_HEADER_BYTES; i < segmentTableEnd; i++) {
      payloadBytes += buffer[i];
    }
    const pageEnd = segmentTableEnd + payloadBytes;
    if (buffer.length < pageEnd) {
      return { index: -1, keepFrom: index };
    }

    if (hasValidOggCrc(buffer.subarray(index, pageEnd))) {
      return { index, keepFrom: null };
    }
    searchFrom = index + 1;
  }

  return { index: -1, keepFrom: null };
}

export class OggSyncGate extends Transform {
  private mode: OggSyncGateStats["mode"] = "passthrough";
  private syncReason: string | null = null;
  private syncBuffer = Buffer.alloc(0);
  private inputBytes = 0;
  private outputBytes = 0;
  private discardedBytes = 0;
  private syncHits = 0;

  beginDiscard(reason?: string): void {
    this.mode = "discard";
    this.syncReason = reason ?? null;
    this.dropSyncBuffer();
  }

  endDiscard(options: OggSyncGateEndDiscardOptions = {}): void {
    if (options.syncToOggPage) {
      this.syncToNextLogicalStream(this.syncReason ?? "release");
      return;
    }
    this.mode = "passthrough";
    this.syncReason = null;
    this.dropSyncBuffer();
  }

  syncToNextLogicalStream(reason?: string): void {
    this.mode = "sync";
    this.syncReason = reason ?? null;
    this.dropSyncBuffer();
  }

  getStats(): OggSyncGateStats {
    return {
      inputBytes: this.inputBytes,
      outputBytes: this.outputBytes,
      discardedBytes: this.discardedBytes,
      bufferedBytes: this.syncBuffer.length,
      mode: this.mode,
      syncReason: this.syncReason,
      syncHits: this.syncHits,
    };
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.inputBytes += input.length;

    if (this.mode === "discard") {
      this.discardedBytes += input.length;
      callback();
      return;
    }

    if (this.mode === "sync") {
      this.handleSyncInput(input);
      callback();
      return;
    }

    this.outputBytes += input.length;
    this.push(input);
    callback();
  }

  override _flush(callback: TransformCallback): void {
    this.dropSyncBuffer();
    callback();
  }

  private handleSyncInput(input: Buffer): void {
    const merged = this.syncBuffer.length > 0
      ? Buffer.concat([this.syncBuffer, input])
      : input;
    const search = findOggBosPage(merged);
    if (search.index >= 0) {
      const pageStart = search.index;
      this.discardedBytes += pageStart;
      const output = merged.subarray(pageStart);
      this.outputBytes += output.length;
      this.syncBuffer = Buffer.alloc(0);
      this.mode = "passthrough";
      this.syncReason = null;
      this.syncHits++;
      this.push(output);
      return;
    }

    const keepFrom = search.keepFrom ?? Math.max(0, merged.length - SYNC_BUFFER_KEEP_BYTES);
    this.discardedBytes += keepFrom;
    this.syncBuffer = Buffer.from(merged.subarray(keepFrom));
  }

  private dropSyncBuffer(): void {
    if (this.syncBuffer.length > 0) {
      this.discardedBytes += this.syncBuffer.length;
      this.syncBuffer = Buffer.alloc(0);
    }
  }
}
