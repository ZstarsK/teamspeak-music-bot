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
const OGG_BOS_FLAG = 0x02;
const SYNC_BUFFER_KEEP_BYTES = 64;

function findOggBosPage(buffer: Buffer): number {
  for (let i = 0; i <= buffer.length - OGG_HEADER_MIN_BYTES; i++) {
    if (
      buffer[i] === OGG_CAPTURE[0] &&
      buffer[i + 1] === OGG_CAPTURE[1] &&
      buffer[i + 2] === OGG_CAPTURE[2] &&
      buffer[i + 3] === OGG_CAPTURE[3] &&
      buffer[i + 4] === 0 &&
      (buffer[i + 5] & OGG_BOS_FLAG) === OGG_BOS_FLAG
    ) {
      return i;
    }
  }
  return -1;
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
    const pageStart = findOggBosPage(merged);
    if (pageStart >= 0) {
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

    const keepBytes = Math.min(merged.length, SYNC_BUFFER_KEEP_BYTES);
    this.discardedBytes += merged.length - keepBytes;
    this.syncBuffer = Buffer.from(merged.subarray(merged.length - keepBytes));
  }

  private dropSyncBuffer(): void {
    if (this.syncBuffer.length > 0) {
      this.discardedBytes += this.syncBuffer.length;
      this.syncBuffer = Buffer.alloc(0);
    }
  }
}
