/**
 * Tests for the deck pipeline: ZIP reading, the XML parser, and PowerPoint
 * rendering. The fixture .pptx is built here in memory (stored, uncompressed)
 * so the suite needs no binary checked into the repo.
 */

const assert = require('assert');
const Zip = require('../public/zip.js');
const X = require('../public/xml.js');
const Pptx = require('../public/pptx.js');
const ImageType = require('../public/imagetype.js');

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
      + '<p:sldId id="258" r:id="rId3"/><p:sldId id="259" r:id="rId4"/>'
      + '<p:sldId id="260" r:id="rId5"/><p:sldId id="261" r:id="rId6"/>'
      + '<p:sldId id="262" r:id="rId7"/><p:sldId id="263" r:id="rId8"/>'
      + '<p:sldId id="264" r:id="rId10"/><p:sldId id="265" r:id="rId11"/></p:sldIdLst>'
      + '<p:sldSz cx="9144000" cy="5143500"/>'
      + '</p:presentation>',

    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${RELS_NS}">`
      + `<Relationship Id="rId1" Type="${OFFICE_REL}/slide" Target="slides/slide1.xml"/>`
      + `<Relationship Id="rId2" Type="${OFFICE_REL}/slide" Target="slides/slide2.xml"/>`
      + `<Relationship Id="rId3" Type="${OFFICE_REL}/slide" Target="slides/slide3.xml"/>`
      + `<Relationship Id="rId4" Type="${OFFICE_REL}/slide" Target="slides/slide4.xml"/>`
      + `<Relationship Id="rId5" Type="${OFFICE_REL}/slide" Target="slides/slide5.xml"/>`
      + `<Relationship Id="rId6" Type="${OFFICE_REL}/slide" Target="slides/slide6.xml"/>`
      + `<Relationship Id="rId7" Type="${OFFICE_REL}/slide" Target="slides/slide7.xml"/>`
      + `<Relationship Id="rId8" Type="${OFFICE_REL}/slide" Target="slides/slide8.xml"/>`
      + `<Relationship Id="rId10" Type="${OFFICE_REL}/slide" Target="slides/slide9.xml"/>`
      + `<Relationship Id="rId11" Type="${OFFICE_REL}/slide" Target="slides/slide10.xml"/>`
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

    // Slide 4: the shapes a process diagram is made of — an arrow, a chevron,
    // an elbow connector, and an arrow flipped to point the other way.
    'ppt/slides/slide4.xml': '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a">'
      + '<p:cSld><p:spTree>'
      + '<p:sp><p:nvSpPr><p:cNvPr id="10" name="Arrow"/></p:nvSpPr>'
      + '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>'
      + '<a:prstGeom prst="rightArrow"/><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr>'
      + '</p:sp>'
      + '<p:sp><p:nvSpPr><p:cNvPr id="11" name="Back"/></p:nvSpPr>'
      + '<p:spPr><a:xfrm flipH="1"><a:off x="914400" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>'
      + '<a:prstGeom prst="rightArrow"/><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></p:spPr>'
      + '<p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1200"/><a:t>Back</a:t></a:r></a:p></p:txBody>'
      + '</p:sp>'
      + '<p:sp><p:nvSpPr><p:cNvPr id="12" name="Step"/></p:nvSpPr>'
      + '<p:spPr><a:xfrm><a:off x="0" y="914400"/><a:ext cx="914400" cy="457200"/></a:xfrm>'
      + '<a:prstGeom prst="chevron"/><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></p:spPr>'
      + '</p:sp>'
      + '<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="13" name="Elbow"/></p:nvCxnSpPr>'
      + '<p:spPr><a:xfrm><a:off x="1828800" y="914400"/><a:ext cx="914400" cy="457200"/></a:xfrm>'
      + '<a:prstGeom prst="bentConnector3"/>'
      + '<a:ln w="12700"><a:solidFill><a:srgbClr val="333333"/></a:solidFill></a:ln></p:spPr>'
      + '</p:cxnSp>'
      + '</p:spTree></p:cSld></p:sld>',

    // Slide 5: a chart, the way PowerPoint actually stores one — the numbers
    // cached in the chart part, and categories nested in a multi-level cache.
    'ppt/slides/slide5.xml': '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r">'
      + '<p:cSld><p:spTree>'
      + '<p:graphicFrame><p:xfrm><a:off x="457200" y="457200"/><a:ext cx="5486400" cy="3200400"/></p:xfrm>'
      + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
      + '<c:chart xmlns:c="c" xmlns:r="r" r:id="rIdC"/>'
      + '</a:graphicData></a:graphic></p:graphicFrame>'
      + '</p:spTree></p:cSld></p:sld>',

    'ppt/slides/_rels/slide5.xml.rels': `<Relationships xmlns="${RELS_NS}">`
      + `<Relationship Id="rIdC" Type="${OFFICE_REL}/chart" Target="../charts/chart1.xml"/>`
      + '</Relationships>',

    'ppt/charts/chart1.xml': '<?xml version="1.0"?><c:chartSpace xmlns:c="c" xmlns:a="a">'
      + '<c:chart>'
      + '<c:title><c:tx><c:rich><a:p><a:r><a:t>Quarterly revenue</a:t></a:r></a:p></c:rich></c:tx></c:title>'
      + '<c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>'
      + '<c:ser><c:idx val="0"/>'
      + '<c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>North</c:v></c:pt></c:strCache></c:strRef></c:tx>'
      + '<c:spPr><a:solidFill><a:srgbClr val="336699"/></a:solidFill></c:spPr>'
      + '<c:cat><c:multiLvlStrRef><c:multiLvlStrCache><c:ptCount val="3"/><c:lvl>'
      + '<c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt>'
      + '<c:pt idx="2"><c:v>Q3</c:v></c:pt>'
      + '</c:lvl></c:multiLvlStrCache></c:multiLvlStrRef></c:cat>'
      + '<c:val><c:numRef><c:numCache><c:ptCount val="3"/>'
      + '<c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt>'
      + '<c:pt idx="2"><c:v>40</c:v></c:pt>'
      + '</c:numCache></c:numRef></c:val></c:ser>'
      + '<c:ser><c:idx val="1"/>'
      + '<c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>South</c:v></c:pt></c:strCache></c:strRef></c:tx>'
      + '<c:spPr><a:solidFill><a:srgbClr val="CC3300"/></a:solidFill></c:spPr>'
      + '<c:val><c:numRef><c:numCache><c:ptCount val="3"/>'
      + '<c:pt idx="0"><c:v>5</c:v></c:pt><c:pt idx="1"><c:v>15</c:v></c:pt>'
      + '<c:pt idx="2"><c:v>25</c:v></c:pt>'
      + '</c:numCache></c:numRef></c:val></c:ser>'
      + '</c:barChart></c:plotArea>'
      + '<c:legend><c:legendPos val="b"/></c:legend>'
      + '</c:chart>'
      + '<c:txPr><a:p><a:pPr><a:defRPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>'
      + '</a:defRPr></a:pPr></a:p></c:txPr>'
      + '</c:chartSpace>',

    // Slide 6: an embedded object and a Windows metafile — the two things a
    // corporate deck carries that this renderer cannot draw. Both should be
    // counted once, as one slide the presenter has to do something about.
    'ppt/slides/slide6.xml': '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r">'
      + '<p:cSld><p:spTree>'
      + '<p:graphicFrame><p:xfrm><a:off x="457200" y="457200"/><a:ext cx="4000000" cy="2000000"/></p:xfrm>'
      + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole">'
      + '<p:oleObj name="Visio"/></a:graphicData></a:graphic></p:graphicFrame>'
      + '<p:pic><p:blipFill><a:blip r:embed="rIdM"/></p:blipFill>'
      + '<p:spPr><a:xfrm><a:off x="4800000" y="457200"/><a:ext cx="2000000" cy="2000000"/></a:xfrm></p:spPr>'
      + '</p:pic>'
      + '</p:spTree></p:cSld></p:sld>',

    'ppt/slides/_rels/slide6.xml.rels': `<Relationships xmlns="${RELS_NS}">`
      + `<Relationship Id="rIdM" Type="${OFFICE_REL}/image" Target="../media/diagram.wmf"/>`
      + '</Relationships>',

    // Slide 7: SmartArt, written the way PowerPoint writes it — the frame
    // points at a data part, and the drawing hangs off that part's own rels.
    'ppt/slides/slide7.xml': '<?xml version="1.0"?>'
      + '<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r" xmlns:dgm="dgm">'
      + '<p:cSld><p:spTree>'
      + '<p:graphicFrame><p:xfrm><a:off x="914400" y="457200"/><a:ext cx="4000000" cy="2000000"/></p:xfrm>'
      + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">'
      + '<dgm:relIds r:dm="rIdD" r:lo="rIdL" r:qs="rIdQ" r:cs="rIdC"/>'
      + '</a:graphicData></a:graphic></p:graphicFrame>'
      + '</p:spTree></p:cSld></p:sld>',

    'ppt/slides/_rels/slide7.xml.rels': `<Relationships xmlns="${RELS_NS}">`
      + `<Relationship Id="rIdD" Type="${OFFICE_REL}/diagramData" Target="../diagrams/data1.xml"/>`
      + '</Relationships>',

    'ppt/diagrams/data1.xml': '<?xml version="1.0"?><dgm:dataModel xmlns:dgm="dgm"/>',

    // The drawing is reached from the data part, not the slide.
    'ppt/diagrams/_rels/data1.xml.rels': `<Relationships xmlns="${RELS_NS}">`
      + '<Relationship Id="rIdDr"'
      + ' Type="http://schemas.microsoft.com/office/2007/relationships/diagramDrawing"'
      + ' Target="drawing1.xml"/>'
      + '</Relationships>',

    // Two boxes in the diagram's own coordinate space, which is the frame's.
    'ppt/diagrams/drawing1.xml': '<?xml version="1.0"?>'
      + '<dsp:drawing xmlns:dsp="dsp" xmlns:a="a">'
      + '<dsp:spTree>'
      + '<dsp:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4000000" cy="2000000"/>'
      + '<a:chOff x="0" y="0"/><a:chExt cx="4000000" cy="2000000"/></a:xfrm></dsp:grpSpPr>'
      + '<dsp:sp><dsp:nvSpPr><dsp:cNvPr id="1" name="Node A"/></dsp:nvSpPr>'
      + '<dsp:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="1000000"/></a:xfrm>'
      + '<a:prstGeom prst="roundRect"/><a:solidFill><a:srgbClr val="3366CC"/></a:solidFill></dsp:spPr>'
      + '<dsp:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1400"/><a:t>Plan</a:t></a:r></a:p></dsp:txBody>'
      + '</dsp:sp>'
      + '<dsp:sp><dsp:nvSpPr><dsp:cNvPr id="2" name="Node B"/></dsp:nvSpPr>'
      + '<dsp:spPr><a:xfrm><a:off x="2000000" y="1000000"/><a:ext cx="2000000" cy="1000000"/></a:xfrm>'
      + '<a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="CC3366"/></a:solidFill></dsp:spPr>'
      + '<dsp:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1400"/><a:t>Build</a:t></a:r></a:p></dsp:txBody>'
      + '</dsp:sp>'
      + '</dsp:spTree></dsp:drawing>',

    // Slide 8: SmartArt with no drawing part, which is what a file written by
    // something other than PowerPoint can look like. Still a placeholder.
    'ppt/slides/slide8.xml': '<?xml version="1.0"?>'
      + '<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r" xmlns:dgm="dgm">'
      + '<p:cSld><p:spTree>'
      + '<p:graphicFrame><p:xfrm><a:off x="914400" y="457200"/><a:ext cx="3000000" cy="1500000"/></p:xfrm>'
      + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">'
      + '<dgm:relIds r:dm="rIdD"/>'
      + '</a:graphicData></a:graphic></p:graphicFrame>'
      + '</p:spTree></p:cSld></p:sld>',

    'ppt/slides/_rels/slide8.xml.rels': `<Relationships xmlns="${RELS_NS}">`
      + `<Relationship Id="rIdD" Type="${OFFICE_REL}/diagramData" Target="../diagrams/bare.xml"/>`
      + '</Relationships>',

    'ppt/diagrams/bare.xml': '<?xml version="1.0"?><dgm:dataModel xmlns:dgm="dgm"/>',

    // Slide 10: a word far too long for its box, and a centred line with a
    // trailing space — the two ways print used to hang off the edge of a shape.
    'ppt/slides/slide10.xml': '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a">'
      + '<p:cSld><p:spTree>'
      + '<p:sp><p:nvSpPr><p:cNvPr id="40" name="Narrow"/></p:nvSpPr>'
      + '<p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="914400" cy="1828800"/></a:xfrm>'
      + '<a:prstGeom prst="rect"/><a:noFill/></p:spPr>'
      + '<p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1800"/>'
      + '<a:t>Unconscionable_supercalifragilistic_identifier_0123456789</a:t>'
      + '</a:r></a:p></p:txBody></p:sp>'
      + '<p:sp><p:nvSpPr><p:cNvPr id="41" name="Centred"/></p:nvSpPr>'
      + '<p:spPr><a:xfrm><a:off x="2286000" y="457200"/><a:ext cx="3657600" cy="914400"/></a:xfrm>'
      + '<a:prstGeom prst="rect"/><a:noFill/></p:spPr>'
      + '<p:txBody><a:bodyPr/><a:p><a:pPr algn="ctr"/>'
      + '<a:r><a:rPr sz="1400"/><a:t>Centred </a:t></a:r></a:p></p:txBody></p:sp>'
      + '</p:spTree></p:cSld></p:sld>',

    // Slide 9: the arrangement PowerPoint actually writes — the drawing is a
    // relationship of the *slide*, not of the data part it belongs to.
    'ppt/slides/slide9.xml': '<?xml version="1.0"?>'
      + '<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r" xmlns:dgm="dgm">'
      + '<p:cSld><p:spTree>'
      + '<p:graphicFrame><p:xfrm><a:off x="914400" y="457200"/><a:ext cx="4000000" cy="2000000"/></p:xfrm>'
      + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">'
      + '<dgm:relIds r:dm="rIdD" r:lo="rIdL" r:qs="rIdQ" r:cs="rIdC"/>'
      + '</a:graphicData></a:graphic></p:graphicFrame>'
      + '</p:spTree></p:cSld></p:sld>',

    'ppt/slides/_rels/slide9.xml.rels': `<Relationships xmlns="${RELS_NS}">`
      + `<Relationship Id="rIdD" Type="${OFFICE_REL}/diagramData" Target="../diagrams/data1.xml"/>`
      + '<Relationship Id="rIdDr2"'
      + ' Type="http://schemas.microsoft.com/office/2007/relationships/diagramDrawing"'
      + ' Target="../diagrams/drawing1.xml"/>'
      + '</Relationships>',

    'ppt/media/diagram.wmf': 'not something a browser can draw',

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
  const [slide1, slide2, slide3, slide4, slide5, slide6, slide7, slide8, slide9, slide10] = rendered.slides;

  check('reads the slide size', () => {
    assert.strictEqual(Math.round(rendered.width), 960);
    assert.strictEqual(Math.round(rendered.height), 540);
  });

  check('renders every slide in presentation order', () => {
    assert.strictEqual(rendered.slides.length, 10);
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

  check('a chart is drawn, not left as a grey placeholder', () => {
    assert.ok(!/>Chart</.test(slide5.svg), 'the placeholder should be gone');
    assert.match(slide5.svg, /Quarterly revenue/, 'the chart title should render');
  });

  // Legend swatches are rounded; the bars are not, which is how they are told
  // apart here.
  const barsOf = (svg, hex) => [...svg.matchAll(/<rect ([^>]*)\/>/g)]
    .map((m) => m[1])
    .filter((attrs) => attrs.includes(`fill="${hex}"`) && !attrs.includes('rx='))
    .map((attrs) => Number(attrs.match(/height="([\d.]+)"/)[1]));

  check('bars are drawn in their series colours', () => {
    assert.strictEqual(barsOf(slide5.svg, '#336699').length, 3, 'three bars for the first series');
    assert.strictEqual(barsOf(slide5.svg, '#CC3300').length, 3, 'three bars for the second');
  });

  check('bar heights are proportional to the values', () => {
    // North is 10, 20, 40, so the last bar is four times the first.
    const heights = barsOf(slide5.svg, '#336699');
    assert.ok(Math.abs(heights[2] / heights[0] - 4) < 0.02, JSON.stringify(heights));
    assert.ok(Math.abs(heights[1] / heights[0] - 2) < 0.02, JSON.stringify(heights));
  });

  check('categories nested in a multi-level cache still label the axis', () => {
    // The real decks store categories this way whenever the axis has grouping;
    // reading only c:strCache silently loses every label.
    for (const label of ['Q1', 'Q2', 'Q3']) {
      assert.ok(slide5.svg.includes(`>${label}<`), `missing category ${label}`);
    }
  });

  check('the legend names both series', () => {
    assert.ok(slide5.svg.includes('>North<'), 'North missing from the legend');
    assert.ok(slide5.svg.includes('>South<'), 'South missing from the legend');
  });

  check("chart text uses the chart's own colour, not a hard-coded grey", () => {
    // This chart declares white text, as a chart on a dark slide does.
    assert.match(slide5.svg, /<text[^>]*fill="#FFFFFF"[^>]*>Quarterly revenue</);
  });

  check('an axis is drawn with gridlines and value ticks', () => {
    assert.ok(/stroke-opacity="0.22"/.test(slide5.svg), 'gridlines missing');
    // The largest value is 40, and the axis rounds out to a round number.
    assert.ok(slide5.svg.includes('>50<'), 'the axis should round up past the largest value');
    assert.ok(slide5.svg.includes('>0<'), 'the axis should start at zero');
  });

  check('an arrow is drawn as an arrow, not a rectangle', () => {
    // Seven points, and a tip on the right edge at half height.
    assert.match(slide4.svg, /<path d="M[^"]*Z" fill="#FF0000"/,
      'the right arrow should be a path');
    const arrow = slide4.svg.match(/<path d="(M[^"]*Z)" fill="#FF0000"/)[1];
    assert.strictEqual((arrow.match(/[ML]/g) || []).length, 7, arrow);
    assert.ok(arrow.includes('96.00,48.00'), `tip should sit mid-right: ${arrow}`);
    assert.ok(!/<rect[^>]*fill="#FF0000"/.test(slide4.svg), 'it must not also be a rect');
  });

  check('a flipped arrow points the other way', () => {
    const flipped = slide4.svg.match(/<g transform="translate\(([\d.]+),0\) scale\(-1,1\)">/);
    assert.ok(flipped, 'the flipped arrow needs a mirror transform');
    // 2x + w, with x = 96 and w = 96.
    assert.strictEqual(Number(flipped[1]), 288);
  });

  check('but its text still reads the right way round', () => {
    // The mirror must close before the text begins, or "Back" comes out backwards.
    const mirrorEnd = slide4.svg.indexOf('</g>', slide4.svg.indexOf('scale(-1,1)'));
    const textAt = slide4.svg.indexOf('Back');
    assert.ok(mirrorEnd !== -1 && textAt > mirrorEnd,
      'the label sits inside the mirror transform');
  });

  check('a chevron keeps its notch', () => {
    const chevron = slide4.svg.match(/<path d="(M[^"]*Z)" fill="#0000FF"/);
    assert.ok(chevron, 'the chevron should be a path');
    assert.strictEqual((chevron[1].match(/[ML]/g) || []).length, 6, chevron[1]);
  });

  check('an elbow connector turns instead of cutting the corner', () => {
    const elbow = slide4.svg.match(/<path d="(M[^"]*)" fill="none"[^>]*stroke="#333333"/);
    assert.ok(elbow, `expected an elbow path: ${slide4.svg.slice(0, 400)}`);
    assert.strictEqual((elbow[1].match(/[ML]/g) || []).length, 4, elbow[1]);
    assert.ok(!elbow[1].includes('Z'), 'a connector is a line, not a closed shape');
  });

  check('an unknown geometry still falls back to a rectangle', () => {
    // Slide 2's plain rect inside the group.
    assert.match(slide2.svg, /<rect[^>]*fill="#00FF00"/);
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

  console.log('\n— saying what did not come through —');

check('a deck that renders whole says nothing', () => {
  // Slides 1 to 4 of the fixture are shapes, text, a picture and a chart, all
  // of which this renderer draws. Crying wolf would be worse than silence.
  const whole = [slide1, slide2, slide3, slide4, slide5];
  for (const slide of whole) assert.deepStrictEqual(slide.missing, [], slide.title || '');
});

check('an embedded object and a metafile are both counted', () => {
  assert.strictEqual(slide6.missing.length, 2, JSON.stringify(slide6.missing));
  assert.ok(slide6.missing.some((k) => /embedded object/.test(k)), JSON.stringify(slide6.missing));
  assert.ok(slide6.missing.some((k) => /metafile/.test(k)), JSON.stringify(slide6.missing));
});

check('the summary counts slides, not objects', () => {
  // Two objects on one slide is still one slide the presenter has to fix.
  assert.strictEqual(rendered.incomplete, rendered.slides.filter((s) => s.missing.length).length);
  assert.ok(rendered.incomplete >= 1);
  assert.ok(Array.isArray(rendered.kinds) && rendered.kinds.length >= 1, JSON.stringify(rendered.kinds));
  assert.strictEqual(new Set(rendered.kinds).size, rendered.kinds.length, 'kinds are not repeated');
});

check('the breakdown says how much each kind costs', () => {
  // Which kinds are missing does not say whether the hole is one expensive
  // feature or several cheap ones; deciding what to build next needs the count.
  const counts = rendered.counts;
  assert.ok(counts && typeof counts === 'object', JSON.stringify(counts));
  assert.deepStrictEqual(Object.keys(counts).sort(), [...rendered.kinds].sort());

  const total = Object.values(counts).reduce((n, c) => n + c.occurrences, 0);
  const everyMissing = rendered.slides.reduce((n, s) => n + s.missing.length, 0);
  assert.strictEqual(total, everyMissing, 'occurrences must tally with what was recorded');

  for (const [kind, entry] of Object.entries(counts)) {
    assert.ok(entry.slides <= entry.occurrences, kind);
    assert.ok(entry.slides >= 1, kind);
  }
});

console.log('\n— keeping print inside its box —');

check('a word too long for the shape is broken, not hung off the edge', () => {
  // Wrapping between words cannot help a single word wider than its box.
  // Placing it anyway is what pushed print out over whatever sat beside it.
  const lines = slide10.svg.match(/<text[^>]*>/g) || [];
  assert.ok(lines.length >= 3, `expected the long word to break, got ${lines.length} line(s)`);

  const xs = [...slide10.svg.matchAll(/<text x="([\d.]+)"/g)].map((m) => Number(m[1]));
  const boxLeft = 457200 / 9525;
  const boxRight = boxLeft + 914400 / 9525;
  const inBox = xs.filter((x) => x >= boxLeft - 1 && x <= boxRight + 1);
  assert.ok(inBox.length >= 3, `lines started outside the shape: ${JSON.stringify(xs)}`);
});

check('every piece of the broken word actually fits', () => {
  // Reconstructing the word from the pieces proves nothing was dropped.
  const text = (slide10.svg.match(/<tspan[^>]*>([^<]*)<\/tspan>/g) || [])
    .map((t) => t.replace(/<[^>]*>/g, '')).join('');
  assert.ok(text.includes('Unconscionable'), text);
  assert.ok(text.includes('0123456789'), `the tail of the word was lost: ${text}`);
});

check('a trailing space does not shift centred text', () => {
  // The space draws nothing, so counting its width nudged the line off centre.
  const xs = [...slide10.svg.matchAll(/<text x="([\d.]+)"/g)].map((m) => Number(m[1]));
  const centreBox = 2286000 / 9525;
  const centreW = 3657600 / 9525;
  const centred = xs.find((x) => x > centreBox && x < centreBox + centreW);
  assert.ok(centred !== undefined, JSON.stringify(xs));
  // "Centred" is about 50px at 14pt; its left edge should sit near the middle.
  const middle = centreBox + centreW / 2;
  assert.ok(Math.abs(centred - (middle - 25)) < 22,
    `centred line starts at ${centred}, expected near ${middle - 25}`);
});

console.log('\n— SmartArt —');

check('SmartArt is drawn from the picture PowerPoint already made', () => {
  // The diagram's own parts are data and layout rules, but PowerPoint also
  // writes the finished shapes. Finding those is the whole trick.
  assert.deepStrictEqual(slide7.missing, [], JSON.stringify(slide7.missing));
  assert.ok(!/Diagram<\/text>/.test(slide7.svg), 'a placeholder was drawn instead');
  assert.ok(slide7.svg.includes('>Plan<'), 'first node text missing');
  assert.ok(slide7.svg.includes('>Build<'), 'second node text missing');
  assert.ok(slide7.svg.includes('#3366CC') && slide7.svg.includes('#CC3366'),
    'node fills missing');
});

check('its shapes land inside the frame, not at the slide origin', () => {
  // The drawing has coordinates of its own; they have to be mapped onto the
  // frame the way a group transform maps its children.
  const frameX = 914400 / 9525;      // EMU per px, as the renderer uses
  const frameY = 457200 / 9525;
  const frameW = 4000000 / 9525;

  const xs = [...slide7.svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)"/g)]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]) }))
    .filter((p) => p.x !== 0 || p.y !== 0);   // drop the slide background rect

  assert.ok(xs.length >= 1, 'no positioned shapes were drawn');
  for (const p of xs) {
    assert.ok(p.x >= frameX - 1 && p.x <= frameX + frameW + 1,
      `shape at x=${p.x} is outside the frame starting at ${frameX}`);
    assert.ok(p.y >= frameY - 1, `shape at y=${p.y} is above the frame at ${frameY}`);
  }

  // The second node sits half the frame across and half of it down.
  const second = xs.find((p) => p.x > frameX + frameW / 4);
  assert.ok(second, `no shape offset into the frame: ${JSON.stringify(xs)}`);
});

check('the drawing is found when the slide owns the relationship', () => {
  // This is how PowerPoint writes it, and looking only at the data part's own
  // relationships — which is where the standard implies it lives — missed
  // every SmartArt diagram in a corpus of real decks.
  assert.deepStrictEqual(slide9.missing, [], JSON.stringify(slide9.missing));
  assert.ok(slide9.svg.includes('>Plan<') && slide9.svg.includes('>Build<'), 'nodes not drawn');
  assert.ok(!/Diagram<\/text>/.test(slide9.svg), 'a placeholder was drawn instead');
});

check('a diagram with no drawing part still says so', () => {
  // Only PowerPoint is obliged to write that part. Anything else gets the
  // labelled space, and the presenter gets told.
  assert.deepStrictEqual(slide8.missing, ['SmartArt'], JSON.stringify(slide8.missing));
  assert.ok(slide8.svg.includes('>Diagram<'), 'the placeholder label is missing');
});

console.log('\n— identifying an image from its bytes —');

// The wrong type here is invisible on a phone or a laptop, which sniff and
// render anyway, and fatal on a television, which does not.
const bytesOf = (...parts) => {
  const out = [];
  for (const part of parts) {
    if (typeof part === 'string') for (const ch of part) out.push(ch.charCodeAt(0));
    else out.push(...part);
  }
  return Uint8Array.from(out);
};
const pad = (n) => new Array(n).fill(0);

check('reads a JPEG', () => {
  assert.strictEqual(ImageType.sniff(bytesOf([0xFF, 0xD8, 0xFF, 0xE0], pad(20))), 'image/jpeg');
});

check('reads a PNG', () => {
  assert.strictEqual(ImageType.sniff(bytesOf([0x89], 'PNG', [0x0D, 0x0A], pad(20))), 'image/png');
});

check('reads a GIF', () => {
  assert.strictEqual(ImageType.sniff(bytesOf('GIF89a', pad(20))), 'image/gif');
});

check('reads a WebP, and is not fooled by the RIFF header alone', () => {
  assert.strictEqual(ImageType.sniff(bytesOf('RIFF', [1, 2, 3, 4], 'WEBP', pad(20))), 'image/webp');
  assert.notStrictEqual(ImageType.sniff(bytesOf('RIFF', [1, 2, 3, 4], 'WAVE', pad(20))), 'image/webp');
});

check('reads HEIC, which is what a phone actually hands over', () => {
  assert.strictEqual(ImageType.sniff(bytesOf(pad(4), 'ftypheic', pad(20))), 'image/heic');
  assert.strictEqual(ImageType.sniff(bytesOf(pad(4), 'ftypmif1', pad(20))), 'image/heic');
});

check('reads AVIF', () => {
  assert.strictEqual(ImageType.sniff(bytesOf(pad(4), 'ftypavif', pad(20))), 'image/avif');
});

check('reads TIFF in either byte order', () => {
  assert.strictEqual(ImageType.sniff(bytesOf([0x49, 0x49, 0x2A, 0x00], pad(20))), 'image/tiff');
  assert.strictEqual(ImageType.sniff(bytesOf([0x4D, 0x4D, 0x00, 0x2A], pad(20))), 'image/tiff');
});

check('reads a BMP', () => {
  assert.strictEqual(ImageType.sniff(bytesOf('BM', pad(20))), 'image/bmp');
});

check('reads SVG however it opens', () => {
  assert.strictEqual(ImageType.sniff(bytesOf('<svg xmlns="x"><rect/></svg>')), 'image/svg+xml');
  assert.strictEqual(ImageType.sniff(bytesOf('<?xml version="1.0"?><svg xmlns="x"/>')), 'image/svg+xml');
  assert.strictEqual(ImageType.sniff(bytesOf('\n  <!-- a note --><svg xmlns="x"/>')), 'image/svg+xml');
});

check('says nothing rather than guessing at bytes it does not know', () => {
  assert.strictEqual(ImageType.sniff(bytesOf('not an image at all really')), '');
  assert.strictEqual(ImageType.sniff(bytesOf([1, 2])), '');
});

check('only jpeg, png and gif are safe to send untouched', () => {
  for (const safe of ['image/jpeg', 'image/png', 'image/gif']) {
    assert.ok(ImageType.isUniversal(safe), safe);
  }
  // These are the ones a television cannot decode, so they must be converted.
  for (const risky of ['image/heic', 'image/avif', 'image/tiff', 'image/webp',
    'image/svg+xml', 'image/bmp', 'application/octet-stream', '']) {
    assert.ok(!ImageType.isUniversal(risky), risky);
  }
});

console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('test crashed:', err);
  process.exit(1);
});
