/**
 * Tests for the EMF renderer.
 *
 * The fixtures are built here byte by byte rather than checked in, the same way
 * the .pptx fixture is: an EMF is a header plus a list of records, so writing
 * one is no harder than reading it, and a hand-built file makes it obvious what
 * each test is actually asserting.
 */

const assert = require('assert');
const Emf = require('../public/emf.js');

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

/* ── Writing an EMF ───────────────────────────────────────────────────────── */

function record(type, payload = Buffer.alloc(0)) {
  const size = 8 + payload.length;
  const buf = Buffer.alloc(size);
  buf.writeUInt32LE(type, 0);
  buf.writeUInt32LE(size, 4);
  payload.copy(buf, 8);
  return buf;
}

function i32s(...values) {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => buf.writeInt32LE(v, i * 4));
  return buf;
}

/** Handles set the high bit for stock objects, so they will not fit in an int32. */
function u32s(...values) {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => buf.writeUInt32LE(v >>> 0, i * 4));
  return buf;
}

function f32s(...values) {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf;
}

/** COLORREF is 0x00BBGGRR. */
function colorref(r, g, b) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE((b << 16) | (g << 8) | r, 0);
  return buf;
}

function header(bounds = [0, 0, 199, 99]) {
  const buf = Buffer.alloc(88);
  buf.writeUInt32LE(1, 0);
  buf.writeUInt32LE(88, 4);
  bounds.forEach((v, i) => buf.writeInt32LE(v, 8 + i * 4));    // rclBounds
  bounds.forEach((v, i) => buf.writeInt32LE(v, 24 + i * 4));   // rclFrame
  buf.writeUInt32LE(0x464d4520, 40);                           // " EMF"
  buf.writeUInt32LE(0x10000, 44);
  return buf;
}

function emf(records, bounds) {
  const body = Buffer.concat(records);
  const head = header(bounds);
  const eof = record(14, i32s(0, 0, 16));
  const all = Buffer.concat([head, body, eof]);
  all.writeUInt32LE(all.length, 48);
  all.writeUInt32LE(records.length + 2, 52);
  return all;
}

const render = (buf, opts) => Emf.render(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), opts,
);

/* Record builders used by more than one test. */
const createBrush = (h, rgb) => record(39, Buffer.concat([u32s(h), i32s(0), colorref(...rgb), i32s(0)]));
const createPen = (h, rgb, width) => record(38, Buffer.concat([u32s(h), i32s(0), i32s(width, 0), colorref(...rgb)]));
const selectObject = (h) => record(37, u32s(h));
const rectangle = (l, t, r, b) => record(43, i32s(l, t, r, b));

/* ── Recognising the format ───────────────────────────────────────────────── */

console.log('\n— recognising an EMF —');

check('accepts a real header', () => {
  assert.strictEqual(Emf.isEmf(emf([])), true);
});

check('rejects bytes that only start like one', () => {
  const fake = header();
  fake.writeUInt32LE(0, 40);          // no " EMF" signature
  assert.strictEqual(Emf.isEmf(fake), false);
});

check('rejects something far too short', () => {
  assert.strictEqual(Emf.isEmf(Buffer.alloc(8)), false);
});

check('render returns null rather than throwing on rubbish', () => {
  const junk = Buffer.alloc(200, 7);
  assert.strictEqual(render(junk), null);
});

/* ── Geometry ─────────────────────────────────────────────────────────────── */

console.log('\n— drawing —');

check('the bounds become the viewBox, so the picture scales to its frame', () => {
  const svg = render(emf([], [0, 0, 399, 199]), { width: 40, height: 20 });
  assert.ok(svg.includes('viewBox="0 0 400 200"'), svg.slice(0, 200));
  assert.ok(svg.includes('width="40"') && svg.includes('height="20"'), svg.slice(0, 200));
});

check('a rectangle is drawn with the selected brush and pen', () => {
  const svg = render(emf([
    createBrush(1, [0x33, 0x66, 0xcc]),
    selectObject(1),
    createPen(2, [0xff, 0x00, 0x00], 3),
    selectObject(2),
    rectangle(10, 20, 110, 70),
  ]));
  assert.ok(/<rect[^>]*fill="#3366cc"/.test(svg), svg);
  assert.ok(/stroke="#ff0000"/.test(svg), svg);
  assert.ok(/x="10"[^>]*y="20"[^>]*width="100"[^>]*height="50"/.test(svg), svg);
});

check('a null brush leaves the shape unfilled', () => {
  // Stock objects are selected by handle with the high bit set; 5 is NULL_BRUSH.
  const svg = render(emf([selectObject(0x80000005), rectangle(0, 0, 50, 50)]));
  assert.ok(/<rect[^>]*fill="none"/.test(svg), svg);
});

check('an ellipse is drawn as one, not as its bounding box', () => {
  const svg = render(emf([record(42, i32s(0, 0, 100, 50))]));
  assert.ok(/<ellipse[^>]*cx="50"[^>]*cy="25"[^>]*rx="50"[^>]*ry="25"/.test(svg), svg);
});

check('a 16-bit polygon is closed and filled', () => {
  const pts = Buffer.alloc(3 * 4);
  [[0, 0], [60, 0], [30, 40]].forEach(([x, y], i) => {
    pts.writeInt16LE(x, i * 4);
    pts.writeInt16LE(y, i * 4 + 2);
  });
  const svg = render(emf([
    createBrush(1, [0x00, 0x80, 0x00]), selectObject(1),
    record(86, Buffer.concat([i32s(0, 0, 60, 40), i32s(3), pts])),
  ]));
  assert.ok(/<path d="M0 0 L60 0 L30 40 Z"/.test(svg), svg);
  assert.ok(svg.includes('fill="#008000"'), svg);
});

check('MOVETOEX then LINETO draws between the two', () => {
  const svg = render(emf([record(27, i32s(5, 6)), record(54, i32s(80, 90))]));
  assert.ok(/M5 6 L80 90/.test(svg), svg);
});

/* ── Transforms ───────────────────────────────────────────────────────────── */

console.log('\n— transforms —');

check('SETWORLDTRANSFORM moves what follows', () => {
  // Translate by (100, 50); a rect at the origin should land there.
  const svg = render(emf([
    record(35, f32s(1, 0, 0, 1, 100, 50)),
    rectangle(0, 0, 10, 10),
  ]));
  assert.ok(/x="100"[^>]*y="50"/.test(svg), svg);
});

check('MWT_SET replaces the transform, MWT_IDENTITY clears it', () => {
  // The four modes are IDENTITY 1, LEFTMULTIPLY 2, RIGHTMULTIPLY 3, SET 4.
  // Getting these numbers wrong silently puts every shape in the wrong place.
  const set = render(emf([
    record(36, Buffer.concat([f32s(1, 0, 0, 1, 30, 40), i32s(4)])),
    rectangle(0, 0, 10, 10),
  ]));
  assert.ok(/x="30"[^>]*y="40"/.test(set), `MWT_SET: ${set}`);

  const cleared = render(emf([
    record(35, f32s(1, 0, 0, 1, 30, 40)),
    record(36, Buffer.concat([f32s(1, 0, 0, 1, 99, 99), i32s(1)])),
    rectangle(0, 0, 10, 10),
  ]));
  assert.ok(/x="0"[^>]*y="0"/.test(cleared), `MWT_IDENTITY: ${cleared}`);
});

check('scaling the world scales the stroke with it', () => {
  const svg = render(emf([
    createPen(1, [0, 0, 0], 2), selectObject(1),
    record(35, f32s(4, 0, 0, 4, 0, 0)),
    rectangle(0, 0, 10, 10),
  ]));
  const w = Number((svg.match(/stroke-width="([\d.]+)"/) || [])[1]);
  assert.ok(w >= 7 && w <= 9, `expected about 8, got ${w}`);
});

check('SAVEDC and RESTOREDC put the transform back', () => {
  const svg = render(emf([
    record(33),                                   // SAVEDC
    record(35, f32s(1, 0, 0, 1, 200, 200)),
    record(34, i32s(-1)),                         // RESTOREDC
    rectangle(0, 0, 10, 10),
  ]));
  assert.ok(/x="0"[^>]*y="0"/.test(svg), svg);
});

/* ── Text ─────────────────────────────────────────────────────────────────── */

console.log('\n— text —');

function extTextOutW(x, y, text) {
  const chars = Buffer.from(text, 'utf16le');
  // rclBounds(16) iGraphicsMode(4) exScale(4) eyScale(4) = 28, then EMRTEXT(...)
  const fixed = Buffer.concat([
    i32s(0, 0, 0, 0), i32s(1), f32s(1, 1),
    i32s(x, y), i32s(text.length), i32s(0), i32s(0),
    i32s(0, 0, 0, 0), i32s(0),
  ]);
  const strOff = 8 + fixed.length;                // from the start of the record
  fixed.writeUInt32LE(strOff, 28 + 12);           // offString
  return record(84, Buffer.concat([fixed, chars]));
}

check('text is drawn where the record puts it', () => {
  const svg = render(emf([extTextOutW(40, 60, 'Hello')]));
  assert.ok(/<text[^>]*x="40"[^>]*y="60"[^>]*>Hello<\/text>/.test(svg), svg);
});

check('text takes the colour set before it', () => {
  const svg = render(emf([record(24, colorref(0xcc, 0x00, 0x33)), extTextOutW(0, 0, 'Red')]));
  assert.ok(/<text[^>]*fill="#cc0033"/.test(svg), svg);
});

check('a font is applied by name, weight and slant', () => {
  const lf = Buffer.alloc(92);
  lf.writeInt32LE(-24, 0);                        // lfHeight
  lf.writeInt32LE(700, 16);                       // lfWeight, bold
  lf.writeUInt8(1, 20);                           // lfItalic
  Buffer.from('Georgia', 'utf16le').copy(lf, 28); // lfFaceName
  const svg = render(emf([
    record(82, Buffer.concat([u32s(1), lf])),
    selectObject(1),
    extTextOutW(0, 0, 'Styled'),
  ]));
  assert.ok(/font-family="Georgia"/.test(svg), svg);
  assert.ok(/font-weight="bold"/.test(svg), svg);
  assert.ok(/font-style="italic"/.test(svg), svg);
  assert.ok(/font-size="24"/.test(svg), svg);
});

check('empty text draws nothing at all', () => {
  const svg = render(emf([extTextOutW(0, 0, '   ')]));
  assert.ok(!svg.includes('<text'), svg);
});

/* ── Robustness ───────────────────────────────────────────────────────────── */

console.log('\n— surviving real files —');

check('an unknown record costs a detail, not the render', () => {
  const svg = render(emf([
    record(9999, Buffer.alloc(40, 1)),            // no such record type
    rectangle(0, 0, 10, 10),
  ]));
  assert.ok(svg.includes('<rect'), 'drawing after an unknown record was lost');
});

check('a record claiming to be longer than the file stops the walk', () => {
  const buf = emf([rectangle(0, 0, 10, 10)]);
  // Corrupt the rectangle's size field to point past the end.
  buf.writeUInt32LE(0xffff, 88 + 4);
  const svg = render(buf);
  assert.ok(typeof svg === 'string', 'should still return an SVG');
});

check('a truncated file does not throw', () => {
  const buf = emf([rectangle(0, 0, 10, 10)]).subarray(0, 96);
  assert.doesNotThrow(() => render(buf));
});

check('a record with an impossible point count is skipped', () => {
  const svg = render(emf([
    record(86, Buffer.concat([i32s(0, 0, 10, 10), i32s(999999)])),
    rectangle(0, 0, 10, 10),
  ]));
  assert.ok(svg.includes('<rect'), svg);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
