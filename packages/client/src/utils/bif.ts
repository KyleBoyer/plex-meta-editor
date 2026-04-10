/**
 * Parser for Plex BIF (Base Index Frames) files.
 *
 * BIF layout (little-endian):
 *   Bytes 0-7:   Magic (0x89 0x42 0x49 0x46 0x0D 0x0A 0x1A 0x0A)
 *   Bytes 8-11:  Version
 *   Bytes 12-15: Number of images
 *   Bytes 16-19: Framewise separation (seconds, 0 = use per-frame timestamps)
 *   Bytes 20-63: Reserved
 *   Bytes 64+:   Index table — each entry is 8 bytes (4B timestamp in seconds, 4B file offset)
 *                Last entry is a sentinel (timestamp 0xFFFFFFFF, offset = end of data)
 *   After index: Concatenated JPEG frames
 *
 * Plex typically sets the interval field to 0 and stores explicit per-frame
 * timestamps (in seconds) in the index table, usually every 2 seconds.
 */

const BIF_MAGIC = new Uint8Array([0x89, 0x42, 0x49, 0x46, 0x0D, 0x0A, 0x1A, 0x0A]);
const HEADER_SIZE = 64;
const INDEX_ENTRY_SIZE = 8;

export class BifParser {
  private readonly view: DataView;
  private readonly buffer: ArrayBuffer;
  readonly frameCount: number;
  /** Interval in seconds from the header (0 means per-frame timestamps). */
  readonly intervalSeconds: number;

  constructor(buffer: ArrayBuffer) {
    if (buffer.byteLength < HEADER_SIZE) {
      throw new Error('BIF file too small');
    }

    this.buffer = buffer;
    this.view = new DataView(buffer);

    if (!BifParser.isValid(buffer)) {
      throw new Error('Invalid BIF magic header');
    }

    this.frameCount = this.view.getUint32(12, true);
    this.intervalSeconds = this.view.getUint32(16, true);

    if (this.frameCount === 0) {
      throw new Error('BIF file has no frames');
    }

    const minSize = HEADER_SIZE + (this.frameCount + 1) * INDEX_ENTRY_SIZE;
    if (buffer.byteLength < minSize) {
      throw new Error('BIF file truncated: index table incomplete');
    }
  }

  static isValid(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength < BIF_MAGIC.length) return false;
    const header = new Uint8Array(buffer, 0, BIF_MAGIC.length);
    return header.every((byte, i) => byte === BIF_MAGIC[i]);
  }

  /** Get the JPEG frame closest to the given timestamp (in milliseconds). */
  getFrameAtTime(timestampMs: number): Blob | null {
    const index = this.getFrameIndexAtTime(timestampMs);
    if (index < 0) return null;
    return this.getFrameAtIndex(index);
  }

  /** Get the frame index closest to the given timestamp (in milliseconds). */
  getFrameIndexAtTime(timestampMs: number): number {
    if (this.frameCount === 0) return -1;

    const targetSeconds = Math.max(0, timestampMs / 1000);

    // If the header provides a fixed interval, use simple division
    if (this.intervalSeconds > 0) {
      return Math.max(0, Math.min(
        this.frameCount - 1,
        Math.floor(targetSeconds / this.intervalSeconds),
      ));
    }

    // Otherwise binary search the per-frame timestamp table
    let lo = 0;
    let hi = this.frameCount - 1;

    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      const midTs = this.view.getUint32(HEADER_SIZE + mid * INDEX_ENTRY_SIZE, true);
      if (midTs <= targetSeconds) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    return lo;
  }

  private getFrameAtIndex(index: number): Blob | null {
    if (index < 0 || index >= this.frameCount) return null;

    const entryOffset = HEADER_SIZE + index * INDEX_ENTRY_SIZE;
    const nextEntryOffset = entryOffset + INDEX_ENTRY_SIZE;

    const frameOffset = this.view.getUint32(entryOffset + 4, true);
    const nextFrameOffset = this.view.getUint32(nextEntryOffset + 4, true);

    if (frameOffset >= this.buffer.byteLength || nextFrameOffset > this.buffer.byteLength || nextFrameOffset <= frameOffset) {
      return null;
    }

    return new Blob(
      [this.buffer.slice(frameOffset, nextFrameOffset)],
      { type: 'image/jpeg' },
    );
  }
}
