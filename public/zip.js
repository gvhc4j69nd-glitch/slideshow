/**
 * Minimal ZIP reader.
 *
 * A .pptx is a ZIP archive, and browsers can already inflate deflate streams
 * via DecompressionStream, so reading one needs no library — just the central
 * directory walk and a call per entry.
 *
 * Works in both the browser and Node (both provide DecompressionStream).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Zip = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EOCD_SIG = 0x06054b50;
  const EOCD64_LOCATOR_SIG = 0x07064b50;
  const EOCD64_SIG = 0x06064b50;
  const CENTRAL_SIG = 0x02014b50;
  const LOCAL_SIG = 0x04034b50;

  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Locate the end-of-central-directory record by scanning back from the tail. */
  function findEocd(view, length) {
    const maxComment = Math.min(0xffff + 22, length);
    for (let i = 22; i <= maxComment; i += 1) {
      const offset = length - i;
      if (view.getUint32(offset, true) === EOCD_SIG) return offset;
    }
    return -1;
  }

  /**
   * Read an archive into a Map of path -> Uint8Array.
   * Directory entries are skipped.
   */
  async function read(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findEocd(view, bytes.byteLength);
    if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-directory record).');

    let entryCount = view.getUint16(eocd + 10, true);
    let centralOffset = view.getUint32(eocd + 16, true);

    // ZIP64: the 32-bit fields saturate and the real values live in a separate record.
    if (centralOffset === 0xffffffff || entryCount === 0xffff) {
      const locator = eocd - 20;
      if (locator >= 0 && view.getUint32(locator, true) === EOCD64_LOCATOR_SIG) {
        const eocd64 = Number(view.getBigUint64(locator + 8, true));
        if (view.getUint32(eocd64, true) === EOCD64_SIG) {
          entryCount = Number(view.getBigUint64(eocd64 + 32, true));
          centralOffset = Number(view.getBigUint64(eocd64 + 48, true));
        }
      }
    }

    const decoder = new TextDecoder('utf-8');
    const files = new Map();
    let pointer = centralOffset;

    for (let i = 0; i < entryCount; i += 1) {
      if (pointer + 46 > bytes.byteLength) break;
      if (view.getUint32(pointer, true) !== CENTRAL_SIG) break;

      const method = view.getUint16(pointer + 10, true);
      const compressedSize = view.getUint32(pointer + 20, true);
      const nameLength = view.getUint16(pointer + 28, true);
      const extraLength = view.getUint16(pointer + 30, true);
      const commentLength = view.getUint16(pointer + 32, true);
      const localOffset = view.getUint32(pointer + 42, true);
      const name = decoder.decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));

      pointer += 46 + nameLength + extraLength + commentLength;
      if (name.endsWith('/')) continue;

      // The local header repeats the name/extra lengths, which may differ from
      // the central directory's, so the data offset must come from there.
      if (view.getUint32(localOffset, true) !== LOCAL_SIG) continue;
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const raw = bytes.subarray(dataStart, dataStart + compressedSize);

      if (method === 0) files.set(name, raw.slice());
      else if (method === 8) files.set(name, await inflateRaw(raw));
      // Any other compression method (bzip2, lzma…) is not used by Office files.
    }

    return files;
  }

  const textOf = (bytes) => new TextDecoder('utf-8').decode(bytes);

  return { read, textOf };
});
