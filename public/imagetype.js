/**
 * What kind of image some bytes actually are.
 *
 * A File's `type` is filled in by the operating system's picker and is often
 * wrong or simply empty — HEIC from a phone is the usual culprit, and a file
 * dragged from some apps arrives with no type at all. The name is no better: a
 * ".jpg" is frequently a PNG.
 *
 * That matters more than it sounds. Desktop and mobile Chrome sniff the bytes
 * and render a mislabelled image anyway, so a wrong type is invisible right up
 * until someone opens the slideshow on a television, whose browser refuses.
 * Reading the first few bytes is the only answer that is true everywhere.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ImageType = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Formats that every browser decodes, televisions included. Anything outside
  // this set has to be converted before it is sent to an unknown screen.
  const UNIVERSAL = ['image/jpeg', 'image/png', 'image/gif'];

  function sniff(buffer) {
    const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (b.length < 4) return '';

    const ascii = (start, length) => {
      let out = '';
      for (let i = start; i < start + length && i < b.length; i += 1) {
        out += String.fromCharCode(b[i]);
      }
      return out;
    };

    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
    if (b[0] === 0x89 && ascii(1, 3) === 'PNG') return 'image/png';
    if (ascii(0, 3) === 'GIF') return 'image/gif';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
    if (b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';

    // ISO base media: HEIC and AVIF both declare themselves by brand, four
    // bytes in. A phone's camera roll is full of these.
    if (ascii(4, 4) === 'ftyp') {
      const brand = ascii(8, 4);
      if (brand === 'avif' || brand === 'avis') return 'image/avif';
      if (brand === 'heic' || brand === 'heix' || brand === 'hevc'
        || brand === 'mif1' || brand === 'msf1' || brand === 'heim') return 'image/heic';
      return 'image/heic';
    }

    if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A && b[3] === 0x00)
      || (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0x00 && b[3] === 0x2A)) return 'image/tiff';

    // SVG is text, and may open with a byte order mark, an XML declaration, a
    // doctype or a comment before the <svg> itself.
    let text = ascii(0, 512);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    if (text.charCodeAt(0) === 0xEF && text.charCodeAt(1) === 0xBB) text = text.slice(3);
    const trimmed = text.replace(/^\s+/, '');
    if (trimmed.startsWith('<')) {
      const looksLikeSvg = /<svg[\s>]/i.test(text)
        || trimmed.startsWith('<?xml')
        || trimmed.startsWith('<!--')
        || trimmed.startsWith('<!DOCTYPE');
      if (looksLikeSvg) return 'image/svg+xml';
    }

    return '';
  }

  /** Can this be put on the wire untouched, or does it need converting? */
  const isUniversal = (type) => UNIVERSAL.indexOf(type) !== -1;

  return { sniff, isUniversal, UNIVERSAL };
});
