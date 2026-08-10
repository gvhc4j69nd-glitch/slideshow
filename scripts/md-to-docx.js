#!/usr/bin/env node
'use strict';

/**
 * Turn one of the markdown documents in docs/ into a Word file.
 *
 *   node scripts/md-to-docx.js docs/business-plan.md docs/business-plan.docx
 *
 * macOS ships textutil, which converts HTML to .docx — but it silently drops
 * tables, and these documents are mostly tables. Rather than add a dependency
 * to a project that has exactly one, this writes WordprocessingML directly. A
 * .docx is a zip of XML, and the deck reader in this repo already proved the
 * shape of that; this is the same idea pointing the other way.
 *
 * It handles the markdown these documents actually use: headings, paragraphs,
 * tables, bullet and numbered lists, block quotes, rules, and inline bold,
 * italic, code and links. It is not a general markdown implementation and does
 * not try to be.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ── Zip ──────────────────────────────────────────────────────────────────── */

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** Deflated zip. Word reads stored entries too, but these compress ~5x. */
function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const data = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);                 // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, data);

    const dir = Buffer.alloc(46 + nameBuf.length);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(raw.length, 24);
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

/* ── Inline markdown ──────────────────────────────────────────────────────── */

const esc = (text) => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * Split a line into styled runs.
 *
 * Links keep their text and drop the target — a printed business plan cannot be
 * clicked, and a bare URL in the middle of a sentence reads worse than the words
 * it was hiding behind. The sources list at the end carries the URLs in full.
 */
function runs(text) {
  const out = [];
  const pattern = /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]*\))/g;
  let last = 0;
  let match = pattern.exec(text);

  const plain = (chunk) => { if (chunk) out.push({ text: chunk }); };

  // Styled spans are recursed into, so a link inside an italic sentence still
  // loses its brackets instead of being printed raw.
  const nested = (inner, style) => out.push(...runs(inner).map((run) => ({ ...run, ...style })));

  while (match) {
    plain(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('***')) nested(token.slice(3, -3), { bold: true, italic: true });
    else if (token.startsWith('**')) nested(token.slice(2, -2), { bold: true });
    else if (token.startsWith('`')) out.push({ text: token.slice(1, -1), code: true });
    else if (token.startsWith('[')) nested(token.slice(1, token.indexOf(']')), {});
    else nested(token.slice(1, -1), { italic: true });
    last = match.index + token.length;
    match = pattern.exec(text);
  }
  plain(text.slice(last));
  return out.length ? out : [{ text: '' }];
}

function runXml(run) {
  const props = [];
  if (run.bold) props.push('<w:b/>');
  if (run.italic) props.push('<w:i/>');
  if (run.code) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/>');
  if (run.size) props.push(`<w:sz w:val="${run.size}"/><w:szCs w:val="${run.size}"/>`);
  if (run.color) props.push(`<w:color w:val="${run.color}"/>`);
  const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
  return `<w:r>${rPr}<w:t xml:space="preserve">${esc(run.text)}</w:t></w:r>`;
}

const para = (style, inline, extra = '') => {
  const pPr = `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr>`;
  return `<w:p>${pPr}${inline.map(runXml).join('')}</w:p>`;
};

/* ── Block markdown ───────────────────────────────────────────────────────── */

const HEADING_LOOK = {
  1: { bold: true, size: 44, color: '2A2440' },
  2: { bold: true, size: 32, color: '2A2440' },
  3: { bold: true, size: 26, color: '3B3357' },
  4: { bold: true, italic: true, size: 23 },
};

const splitRow = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

function tableXml(rows) {
  const widths = rows[0].length;
  const grid = Array.from({ length: widths }, () => '<w:gridCol w:w="' + Math.floor(9360 / widths) + '"/>').join('');

  const body = rows.map((cells, r) => {
    const header = r === 0;
    const tr = cells.map((cell) => {
      const shade = header ? '<w:shd w:val="clear" w:fill="F2F2F2"/>' : '';
      const content = runs(cell).map((run) => (header ? { ...run, bold: true } : run));
      return '<w:tc>'
        + `<w:tcPr><w:tcW w:w="${Math.floor(9360 / widths)}" w:type="dxa"/>${shade}</w:tcPr>`
        + para('TableText', content)
        + '</w:tc>';
    }).join('');
    const rPr = header ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
    return `<w:tr>${rPr}${tr}</w:tr>`;
  }).join('');

  return '<w:tbl><w:tblPr>'
    + '<w:tblStyle w:val="TableGridLight"/>'
    + '<w:tblW w:w="9360" w:type="dxa"/>'
    + '<w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`).join('')
    + '</w:tblBorders>'
    + '<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="90" w:type="dxa"/>'
    + '<w:bottom w:w="60" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar>'
    + `</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`;
}

/** Does this line begin a new block, rather than continue the one before it? */
const isBlockStart = (line) => /^(#{1,6}\s|[-*]\s|\d+\.\s|>|\||```|---+$)/.test(line.trim());

function convert(markdown) {
  const lines = markdown.split('\n');
  const out = [];
  let i = 0;
  let inFence = false;
  let fenced = [];

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      if (inFence) {
        for (const text of fenced) out.push(para('Code', [{ text, code: true }]));
        fenced = [];
        inFence = false;
      } else inFence = true;
      i += 1;
      continue;
    }
    if (inFence) { fenced.push(line); i += 1; continue; }

    if (!line.trim()) { i += 1; continue; }

    // Horizontal rule — a page break reads better than a line in Word.
    if (/^---+$/.test(line.trim())) {
      out.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      // The style carries the outline level, so navigation and the table of
      // contents work; the direct formatting guarantees it *looks* like a
      // heading even in a reader that ignores styles.xml.
      const look = HEADING_LOOK[Math.min(level, 4)];
      out.push(para(`Heading${level}`, runs(heading[2]).map((run) => ({ ...run, ...look }))));
      i += 1;
      continue;
    }

    // Table: a header row, a separator of dashes, then the body.
    if (line.trim().startsWith('|') && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const rows = [splitRow(line)];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      out.push(tableXml(rows));
      out.push(para('Spacer', [{ text: '' }]));
      continue;
    }

    if (/^>\s?/.test(line)) {
      out.push(para('Quote', runs(line.replace(/^>\s?/, ''))));
      i += 1;
      continue;
    }

    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    const numbered = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (bullet || numbered) {
      const item = bullet || numbered;
      const depth = bullet ? Math.min(2, Math.floor(item[1].length / 2)) : 0;
      // Markdown wraps a long item across several lines; Word wants one
      // paragraph, or the tail of every bullet becomes an orphan.
      const text = [item[2]];
      i += 1;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
        text.push(lines[i].trim());
        i += 1;
      }
      out.push(para(bullet ? 'ListBullet' : 'ListNumber', runs(text.join(' ')),
        `<w:numPr><w:ilvl w:val="${depth}"/><w:numId w:val="${bullet ? 1 : 2}"/></w:numPr>`));
      continue;
    }

    // A plain paragraph, joined across soft-wrapped lines.
    const buf = [line.trim()];
    i += 1;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      buf.push(lines[i].trim());
      i += 1;
    }
    out.push(para(null, runs(buf.join(' '))));
  }

  return out.join('');
}

/* ── The document parts ───────────────────────────────────────────────────── */

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr>
    <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>
    <w:sz w:val="22"/><w:szCs w:val="22"/>
  </w:rPr></w:rPrDefault>
  <w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>

  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/></w:style>

  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/>
    <w:spacing w:before="240" w:after="120"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="44"/><w:color w:val="2A2440"/></w:rPr></w:style>

  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/>
    <w:spacing w:before="280" w:after="120"/>
    <w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="FF8382"/></w:pBdr></w:pPr>
    <w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="2A2440"/></w:rPr></w:style>

  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/>
    <w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="2"/>
    <w:spacing w:before="220" w:after="80"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="3B3357"/></w:rPr></w:style>

  <w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/>
    <w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="3"/></w:pPr>
    <w:rPr><w:b/><w:i/><w:sz w:val="23"/></w:rPr></w:style>

  <w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:ind w:left="480"/>
    <w:pBdr><w:left w:val="single" w:sz="18" w:space="12" w:color="51D1E3"/></w:pBdr></w:pPr>
    <w:rPr><w:i/><w:color w:val="454050"/></w:rPr></w:style>

  <w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:after="0"/><w:shd w:val="clear" w:fill="F5F5F7"/><w:ind w:left="240"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/></w:rPr></w:style>

  <w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="20" w:after="20" w:line="240" w:lineRule="auto"/></w:pPr>
    <w:rPr><w:sz w:val="19"/></w:rPr></w:style>

  <w:style w:type="paragraph" w:styleId="Spacer"><w:name w:val="Spacer"/>
    <w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr>
    <w:rPr><w:sz w:val="12"/></w:rPr></w:style>

  <w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/>
    <w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="ListNumber"><w:name w:val="List Number"/>
    <w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    ${[0, 1, 2].map((lvl) => `<w:lvl w:ilvl="${lvl}"><w:start w:val="1"/><w:numFmt w:val="bullet"/>
      <w:lvlText w:val="${['•', '◦', '▪'][lvl]}"/><w:lvlJc w:val="left"/>
      <w:pPr><w:ind w:left="${360 + lvl * 360}" w:hanging="360"/></w:pPr>
      <w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl>`).join('')}
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/>
      <w:lvlText w:val="%1."/><w:lvlJc w:val="left"/>
      <w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`;

function build(markdown, title) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${convert(markdown)}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"
               w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  return buildZip({
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': ROOT_RELS,
    'word/document.xml': document,
    'word/_rels/document.xml.rels': DOC_RELS,
    'word/styles.xml': STYLES,
    'word/numbering.xml': NUMBERING,
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${esc(title)}</dc:title>
  <dc:creator>Vinboo</dc:creator>
  <cp:lastModifiedBy>Vinboo</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`,
    'docProps/app.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>Vinboo</Application>
</Properties>`,
  });
}

/* ── Entry point ──────────────────────────────────────────────────────────── */

if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input) {
    console.error('usage: node scripts/md-to-docx.js <input.md> [output.docx]');
    process.exit(1);
  }
  const target = output || input.replace(/\.md$/, '.docx');
  const markdown = fs.readFileSync(input, 'utf8');
  const title = (markdown.match(/^#\s+(.*)$/m) || [, path.basename(input)])[1];
  fs.writeFileSync(target, build(markdown, title));
  const kb = (fs.statSync(target).size / 1024).toFixed(0);
  console.log(`${target}  ${kb} KB`);
}

module.exports = { build, convert };
