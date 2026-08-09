/**
 * Tests for the deck pipeline: ZIP reading, the XML parser, and PowerPoint
 * rendering. The fixture .pptx is built here in memory (stored, uncompressed)
 * so the suite needs no binary checked into the repo.
 */

const assert = require('assert');
const Zip = require('../public/zip.js');
const X = require('../public/xml.js');
const Pptx = require('../public/pptx.js');

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

async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

/* ── Building a ZIP (stored entries only) ─────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = -1;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, text] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);            // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, data);

    const dir = Buffer.alloc(46 + nameBuf.length);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    nameBuf.copy(dir, 46);
    central.push(dir);

    offset += local.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/* ── A minimal but realistic presentation ─────────────────────────────────── */

// A 1x1 red PNG, so picture rendering has something real to embed.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function makeDeck() {
  return buildZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    '_rels/.rels': `<Relationships xmlns="${RELS_NS}">`
      + `<Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="ppt/presentation.xml"/>`
      + '</Relationships>',

    'ppt/presentation.xml': '<?xml version="1.0"?>'
      + '<p:presentation xmlns:p="p" xmlns:r="r">'
      + '<p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/>'
      + '<p:sldId id="258" r:id="rId3"/></p:sldIdLst>'
      + '<p:sldSz cx="9144000" cy="5143500"/>'
      + '</p:presentation>',

    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${RELS_NS}">`
      + `<Relationship Id="rId1" Type="${OFFICE_REL}/slide" Target="slides/slide1.xml"/>`
      + `<Relationship Id="rId2" Type="${OFFICE_REL}/slide" Target="slides/slide2.xml"/>`
      + `<Relationship Id="rId3" Type="${OFFICE_REL}/slide" Target="slides/slide3.xml"/>`
      + `<Relationship Id="rId9" Type="${OFFICE_REL}/theme" Target="theme/theme1.xml"/>`
      + '</Relationships>',

    'ppt/theme/theme1.xml': '<a:theme xmlns:a="a"><a:themeElements>'
      + '<a:clrScheme><a:dk1><a:srgbClr val="112233"/></a:dk1>'
      + '<a:accent1><a:srgbClr val="FF8800"/></a:accent1></a:clrScheme>'
      + '<a:fontScheme><a:minorFont><a:latin typeface="Verdana"/></a:minorFont></a:fontScheme>'
      + '</a:themeElements></a:theme>',

    // Slide 1: a titled shape with a solid fill, plus a picture.
    'ppt/slides/slide1.xml': '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r">'
      + '<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FAFAFA"/></a:solidFill></p:bgPr></p:bg>'
      + '<p:spTree>'
      + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>'
      + '<p:spPr><a:xfrm><a:off x="457200" y="274320"/><a:ext cx="8229600" cy="1143000"/></a:xfrm>'
      + '<a:prstGeom prst="roundRect"/><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr>'
      + '<p:txBody><a:bodyPr anchor="ctr"/><a:p><a:pPr algn="ctr"/>'
      + '<a:r><a:rPr sz="3200" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr>'
      + '<a:t>Hello &amp; welcome</a:t></a:r></a:p></p:txBody></p:sp>'
      + '<p:pic><p:blipFill><a:blip r:embed="rId1"/></p:blipFill>'
      + '<p:spPr><a:xfrm><a:off x="914400" y="2286000"/><a:ext cx="1828800" cy="1828800"/></a:xfrm></p:spPr>'
      + '</p:pic>'
      + '</p:spTree></p:cSld></p:sld>',

    'ppt/slides/_rels/slide1.xml.rels': `<Relationships xmlns="${RELS_NS}">`
      + `<Relationship Id="rId1" Type="${OFFICE_REL}/image" Target="../media/pic.png"/>`
      + '</Relationships>',

    // Slide 2: long text that must wrap, an ellipse, and a group transform.
    'ppt/slides/slide2.xml': '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a">'
      + '<p:cSld><p:spTree>'
      + '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/></p:nvSpPr>'
      + '<p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="3657600" cy="2743200"/></a:xfrm>'
      + '<a:prstGeom prst="ellipse"/><a:noFill/>'
      + '<a:ln w="19050"><a:solidFill><a:srgbClr val="003366"/></a:solidFill></a:ln></p:spPr>'
      + '<p:txBody><a:bodyPr/><a:p><a:pPr><a:buChar char="•"/></a:pPr>'
      + '<a:r><a:rPr sz="1400"/><a:t>'
      + 'This sentence is deliberately long so that it has to wrap onto several lines inside a narrow shape'
      + '</a:t></a:r></a:p></p:txBody></p:sp>'
      + '<p:grpSp><p:grpSpPr><a:xfrm><a:off x="4572000" y="457200"/><a:ext cx="1828800" cy="1828800"/>'
      + '<a:chOff x="0" y="0"/><a:chExt cx="914400" cy="914400"/></a:xfrm></p:grpSpPr>'
      + '<p:sp><p:nvSpPr><p:cNvPr id="4" name="InGroup"/></p:nvSpPr>'
      + '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="457200" cy="457200"/></a:xfrm>'
      + '<a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></p:spPr></p:sp>'
      + '</p:grpSp>'
      + '</p:spTree></p:cSld></p:sld>',

    // Slide 3: text that cannot possibly fit, plus markup that must stay inert.
    'ppt/slides/slide3.xml': '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a">'
      + '<p:cSld><p:spTree>'
      + '<p:sp><p:nvSpPr><p:cNvPr id="5" name="Tiny"/></p:nvSpPr>'
      + '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2743200" cy="457200"/></a:xfrm>'
      + '<a:prstGeom prst="rect"/><a:noFill/></p:spPr>'
      + '<p:txBody><a:bodyPr/><a:p>'
      + '<a:r><a:rPr sz="2400"/><a:t>'
      + 'Far too much text at twenty-four point to ever fit inside this deliberately tiny box '
      + '&lt;script&gt;alert(1)&lt;/script&gt;'
      + '</a:t></a:r></a:p></p:txBody></p:sp>'
      + '</p:spTree></p:cSld></p:sld>',

    'ppt/media/pic.png': PNG,
  });
}

/** Visible text of an SVG, with tags stripped and entities decoded. */
function svgText(svg) {
  return svg
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/* ── Tests ────────────────────────────────────────────────────────────────── */

(async () => {
  console.log('\n— xml parser —');

  check('parses elements, attributes and text', () => {
    const root = X.parse('<a:root x="1"><a:kid>hi</a:kid></a:root>');
    assert.strictEqual(root.name, 'a:root');
    assert.strictEqual(X.attr(root, 'x'), '1');
    assert.strictEqual(X.allText(X.child(root, 'a:kid')), 'hi');
  });

  check('decodes entities in text and attributes', () => {
    const root = X.parse('<r t="a&amp;b"><c>&lt;x&gt; &#65; &#x42;</c></r>');
    assert.strictEqual(X.attr(root, 't'), 'a&b');
    assert.strictEqual(X.allText(X.child(root, 'c')), '<x> A B');
  });

  check('handles self-closing tags, comments and declarations', () => {
    const root = X.parse('<?xml version="1.0"?><!-- note --><r><a/><b>1</b></r>');
    assert.strictEqual(root.children.length, 2);
    assert.strictEqual(root.children[0].name, 'a');
  });

  check('handles CDATA', () => {
    const root = X.parse('<r><![CDATA[<not> markup]]></r>');
    assert.strictEqual(X.allText(root), '<not> markup');
  });

  check('findAll returns descendants in document order', () => {
    const root = X.parse('<r><a><t>1</t></a><t>2</t></r>');
    assert.deepStrictEqual(X.findAll(root, 't').map((n) => X.allText(n)), ['1', '2']);
  });

  console.log('\n— zip reader —');

  await checkAsync('reads stored entries back byte-for-byte', async () => {
    const zip = buildZip({ 'a.txt': 'hello', 'dir/b.bin': PNG });
    const files = await Zip.read(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength));
    assert.strictEqual(Zip.textOf(files.get('a.txt')), 'hello');
    assert.ok(Buffer.from(files.get('dir/b.bin')).equals(PNG));
  });

  await checkAsync('reads deflated entries (a real .pptx is compressed)', async () => {
    // Round-trip through the platform deflate so the inflate path is covered.
    const raw = Buffer.from('x'.repeat(500) + 'unique-tail');
    const deflated = Buffer.from(await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw')),
    ).arrayBuffer());

    const nameBuf = Buffer.from('c.txt');
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);

    const dir = Buffer.alloc(46 + nameBuf.length);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc32(raw), 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(0, 42);
    nameBuf.copy(dir, 46);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(dir.length, 12);
    eocd.writeUInt32LE(local.length + deflated.length, 16);

    const zip = Buffer.concat([local, deflated, dir, eocd]);
    const files = await Zip.read(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength));
    assert.strictEqual(Zip.textOf(files.get('c.txt')), raw.toString());
  });

  await checkAsync('rejects something that is not a ZIP', async () => {
    const junk = Uint8Array.from('definitely not a zip', (c) => c.charCodeAt(0));
    await assert.rejects(() => Zip.read(junk.buffer), /Not a ZIP/);
  });

  console.log('\n— powerpoint rendering —');

  const deck = makeDeck();
  const rendered = await Pptx.render(deck.buffer.slice(deck.byteOffset, deck.byteOffset + deck.byteLength));
  const [slide1, slide2, slide3] = rendered.slides;

  check('reads the slide size', () => {
    assert.strictEqual(Math.round(rendered.width), 960);
    assert.strictEqual(Math.round(rendered.height), 540);
  });

  check('renders every slide in presentation order', () => {
    assert.strictEqual(rendered.slides.length, 3);
    assert.ok(svgText(slide1.svg).includes('Hello & welcome'));
    assert.ok(svgText(slide2.svg).includes('narrow shape'));
  });

  check('pulls the title from the title placeholder', () => {
    assert.strictEqual(slide1.title, 'Hello & welcome');
  });

  check('emits a self-contained SVG at slide dimensions', () => {
    assert.ok(slide1.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
    assert.ok(slide1.svg.includes('viewBox="0 0 960.00 540.00"'));
    assert.ok(slide1.svg.trimEnd().endsWith('</svg>'));
  });

  check('applies the slide background', () => {
    assert.ok(slide1.svg.includes('fill="#FAFAFA"'));
  });

  check('resolves theme colours through schemeClr', () => {
    assert.ok(slide1.svg.includes('#FF8800'), 'accent1 should come from the theme');
  });

  check('places shapes using EMU geometry', () => {
    // 457200 EMU = 48px, 8229600 EMU = 864px at 96dpi.
    assert.ok(slide1.svg.includes('x="48.00"'), 'x offset');
    assert.ok(slide1.svg.includes('width="864.00"'), 'width');
    assert.ok(slide1.svg.includes('rx='), 'roundRect should be rounded');
  });

  check('embeds pictures as data URIs, not external links', () => {
    assert.ok(slide1.svg.includes('<image '));
    assert.ok(slide1.svg.includes('href="data:image/png;base64,'));
    assert.ok(!slide1.svg.includes('../media/'));
  });

  check('escapes text so markup in a deck cannot break the SVG', () => {
    assert.ok(!slide1.svg.includes('Hello & welcome'), 'raw ampersand must not reach the SVG');
    assert.ok(slide1.svg.includes('&amp;'));
    assert.ok(svgText(slide3.svg).includes('<script>alert(1)</script>'),
      'markup in a deck should survive as literal text');
    assert.ok(!slide3.svg.includes('<script>'), 'and must never become a real tag');
  });

  check('carries run styling onto the text', () => {
    assert.ok(slide1.svg.includes('font-weight="bold"'));
    assert.ok(slide1.svg.includes('fill="#FFFFFF"'));
  });

  check('wraps long text onto multiple lines', () => {
    const lines = (slide2.svg.match(/<text /g) || []).length;
    assert.ok(lines > 2, `expected several lines, got ${lines}`);
  });

  check('draws an explicit bullet', () => {
    assert.ok(slide2.svg.includes('•'));
  });

  check('renders geometry and outlines', () => {
    assert.ok(slide2.svg.includes('<ellipse'));
    assert.ok(slide2.svg.includes('stroke="#003366"'));
    assert.ok(slide2.svg.includes('stroke-width="2.00"'));
  });

  check('maps group child coordinates through the group transform', () => {
    // The group doubles its children (1828800 ext over 914400 chExt), so a
    // 457200 EMU (48px) square becomes 96px, offset to the group's origin.
    assert.ok(slide2.svg.includes('fill="#00FF00"'));
    assert.ok(slide2.svg.includes('width="96.00"'), 'child should be scaled x2');
    assert.ok(slide2.svg.includes('x="480.00"'), 'child should sit at the group origin');
  });

  check('shrinks text that would overflow its box', () => {
    // Slide 3 puts a long 24pt paragraph in a box far too small for it, so
    // autofit must bring the rendered size below the nominal 32px.
    const sizes = [...slide3.svg.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
    assert.ok(sizes.length > 0);
    assert.ok(Math.max(...sizes) < 32, `expected shrink, sizes were ${sizes.join(',')}`);
    assert.ok(Math.max(...sizes) > 32 * 0.5, 'but it should not shrink away to nothing');
  });

  await checkAsync('rejects a file that is not a presentation', async () => {
    const notDeck = buildZip({ 'hello.txt': 'not a deck' });
    await assert.rejects(
      () => Pptx.render(notDeck.buffer.slice(notDeck.byteOffset, notDeck.byteOffset + notDeck.byteLength)),
      /not a PowerPoint presentation/,
    );
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('test crashed:', err);
  process.exit(1);
});
