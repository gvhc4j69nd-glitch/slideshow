/**
 * Tests for the QR encoder.
 *
 * A QR code fails at the moment it is needed most — someone holding a phone up
 * in front of a room — and it fails silently, so these check the structure a
 * scanner actually looks for rather than trusting the output by eye. The
 * decisive test is not here: the browser's own BarcodeDetector decodes these
 * codes back to their input, which is how the encoder was verified.
 */

const assert = require('assert');
const Qr = require('../public/qr.js');

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const JOIN_LINK = 'https://vinboo.com/watch?ticket=snEF29Bf6AYe-DHNawUZicN4';

// The three corner squares, which is the first thing any scanner hunts for.
const FINDER = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
const corner = (q, x0, y0) => FINDER.map((row, dy) => row.split('')
  .map((unused, dx) => q.cells[y0 + dy][x0 + dx]).join(''));

console.log('\n— the shape a scanner looks for —');

check('all three finder patterns are exactly right', () => {
  const q = Qr.encode(JOIN_LINK);
  assert.deepStrictEqual(corner(q, 0, 0), FINDER, 'top left');
  assert.deepStrictEqual(corner(q, q.size - 7, 0), FINDER, 'top right');
  assert.deepStrictEqual(corner(q, 0, q.size - 7), FINDER, 'bottom left');
});

check('the timing patterns alternate', () => {
  const q = Qr.encode(JOIN_LINK);
  for (let i = 8; i < q.size - 8; i += 1) {
    assert.strictEqual(q.cells[6][i], i % 2 === 0 ? 1 : 0, `row at ${i}`);
    assert.strictEqual(q.cells[i][6], i % 2 === 0 ? 1 : 0, `column at ${i}`);
  }
});

check('the module that is always dark, is', () => {
  const q = Qr.encode(JOIN_LINK);
  assert.strictEqual(q.cells[q.size - 8][8], 1);
});

check('the quiet zone is in the SVG', () => {
  // Without it, a code pressed to the edge of its container often will not read.
  const svg = Qr.svg('x');
  const box = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
  const q = Qr.encode('x');
  assert.strictEqual(Number(box[1]), q.size + 8, 'four modules each side');
  assert.strictEqual(Number(box[1]), Number(box[2]), 'square');
});

console.log('\n— sizing —');

check('it grows only as far as it must', () => {
  assert.strictEqual(Qr.encode('a').version, 1);
  assert.strictEqual(Qr.encode('a'.repeat(14)).version, 1);
  assert.strictEqual(Qr.encode('a'.repeat(15)).version, 2);
  assert.strictEqual(Qr.encode(JOIN_LINK).version, 4);
  assert.strictEqual(Qr.encode('a'.repeat(106)).version, 6);
});

check('the matrix size follows the version', () => {
  for (const [text, size] of [['a', 21], ['a'.repeat(15), 25], ['a'.repeat(106), 41]]) {
    assert.strictEqual(Qr.encode(text).size, size, text.length + ' bytes');
  }
});

check('too much data is refused, not silently mangled', () => {
  assert.throws(() => Qr.encode('a'.repeat(107)), /106/);
  assert.strictEqual(Qr.MAX_BYTES, 106);
});

check('a join link fits with room to spare', () => {
  // Long enough for a self-hosted domain, not just vinboo.com.
  const long = `https://slideshow-production-1c4f.up.railway.app/watch?ticket=${'z'.repeat(24)}`;
  assert.ok(long.length < Qr.MAX_BYTES, `${long.length} bytes`);
  assert.ok(Qr.encode(long).version <= 6);
});

console.log('\n— masking —');

check('a mask is chosen, and the same input gives the same code', () => {
  const a = Qr.encode(JOIN_LINK);
  const b = Qr.encode(JOIN_LINK);
  assert.ok(a.mask >= 0 && a.mask <= 7, `mask ${a.mask}`);
  assert.strictEqual(a.mask, b.mask);
  assert.deepStrictEqual(
    a.cells.map((r) => Array.from(r)),
    b.cells.map((r) => Array.from(r)),
  );
});

check('light and dark end up roughly balanced', () => {
  // This is what the mask is chosen for; a lopsided code is a hard read.
  const q = Qr.encode(JOIN_LINK);
  let dark = 0;
  for (let y = 0; y < q.size; y += 1) for (let x = 0; x < q.size; x += 1) dark += q.cells[y][x];
  const percent = (dark / (q.size * q.size)) * 100;
  assert.ok(percent > 35 && percent < 65, `${percent.toFixed(1)}% dark`);
});

check('different text gives a different code', () => {
  const a = Qr.encode('https://vinboo.com/watch?ticket=aaaaaaaaaaaaaaaaaaaaaaaa');
  const b = Qr.encode('https://vinboo.com/watch?ticket=bbbbbbbbbbbbbbbbbbbbbbbb');
  assert.notDeepStrictEqual(
    a.cells.map((r) => Array.from(r)),
    b.cells.map((r) => Array.from(r)),
  );
});

console.log('\n— text —');

check('non-ASCII survives, since a title could be anything', () => {
  const q = Qr.encode('café — 日本');
  assert.ok(q.size >= 21);
});

check('the SVG is self-contained and drawable', () => {
  const svg = Qr.svg(JOIN_LINK);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<path d="M/);
  assert.ok(!svg.includes('<script'), 'no script in a rendered code');
  assert.match(svg, /shape-rendering="crispEdges"/, 'no anti-aliased module edges');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
