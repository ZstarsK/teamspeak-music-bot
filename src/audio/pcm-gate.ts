import { Transform, type TransformCallback } from "node:stream";

export interface PcmGateStats {
  inputBytes: number;
  outputBytes: number;
  discardedBytes: number;
  bufferedBytes: number;
  pendingAlignmentDropBytes: number;
  discarding: boolean;
}

export interface PcmGateEndDiscardOptions {
  resetAlignment?: boolean;
}

const DEFAULT_SAMPLE_BLOCK_BYTES = 4; // s16le stereo: left int16 + right int16

export class PcmGate extends Transform {
  private remainder = Buffer.alloc(0);
  private discarding = false;
  private inputBytes = 0;
  private outputBytes = 0;
  private discardedBytes = 0;
  private pendingAlignmentDropBytes = 0;

  constructor(private readonly sampleBlockBytes = DEFAULT_SAMPLE_BLOCK_BYTES) {
    super();
    if (!Number.isInteger(sampleBlockBytes) || sampleBlockBytes <= 0) {
      throw new Error("sampleBlockBytes must be a positive integer");
    }
  }

  beginDiscard(_reason?: string): void {
    this.discarding = true;
  }

  endDiscard(options: PcmGateEndDiscardOptions = {}): void {
    if (options.resetAlignment) {
      this.resetAlignment();
    }
    this.discarding = false;
  }

  resetAlignment(): void {
    const remainderBytes = this.remainder.length;
    this.discardedBytes += remainderBytes;
    this.remainder = Buffer.alloc(0);
    this.pendingAlignmentDropBytes = remainderBytes === 0
      ? 0
      : this.sampleBlockBytes - remainderBytes;
  }

  getStats(): PcmGateStats {
    return {
      inputBytes: this.inputBytes,
      outputBytes: this.outputBytes,
      discardedBytes: this.discardedBytes,
      bufferedBytes: this.remainder.length,
      pendingAlignmentDropBytes: this.pendingAlignmentDropBytes,
      discarding: this.discarding,
    };
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const rawInput = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.inputBytes += rawInput.length;

    let input = rawInput;
    if (this.pendingAlignmentDropBytes > 0) {
      const dropBytes = Math.min(this.pendingAlignmentDropBytes, input.length);
      this.pendingAlignmentDropBytes -= dropBytes;
      this.discardedBytes += dropBytes;
      input = input.subarray(dropBytes);
      if (input.length === 0) {
        callback();
        return;
      }
    }

    const merged = this.remainder.length > 0
      ? Buffer.concat([this.remainder, input])
      : input;
    const alignedLength = merged.length - (merged.length % this.sampleBlockBytes);
    this.remainder = alignedLength < merged.length
      ? Buffer.from(merged.subarray(alignedLength))
      : Buffer.alloc(0);

    if (alignedLength <= 0) {
      callback();
      return;
    }

    const aligned = merged.subarray(0, alignedLength);
    if (this.discarding) {
      this.discardedBytes += aligned.length;
      callback();
      return;
    }

    this.outputBytes += aligned.length;
    this.push(aligned);
    callback();
  }

  override _flush(callback: TransformCallback): void {
    this.discardedBytes += this.remainder.length + this.pendingAlignmentDropBytes;
    this.remainder = Buffer.alloc(0);
    this.pendingAlignmentDropBytes = 0;
    callback();
  }
}
