/**
 * Render a .pptx into one SVG per slide.
 *
 * A PowerPoint file is a ZIP of XML parts, so the whole conversion happens in
 * the browser with no server round trip and no library. Each slide becomes a
 * self-contained SVG with images inlined as data URIs, which means a deck
 * behaves exactly like a folder of pictures everywhere else in the app — the
 * player shows it, and the live relay streams it, without either knowing that
 * PowerPoint was involved.
 *
 * Supported: slide order and size, backgrounds, text (font, size, weight,
 * italic, underline, colour, alignment, wrapping, vertical anchoring, bullets,
 * indent), pictures, autoshapes with fills and outlines, connectors, groups
 * with nested transforms, and tables.
 *
 * Not supported: animations and transitions, charts and SmartArt (drawn as a
 * labelled placeholder), 3-D effects, gradients (approximated by their first
 * stop), and WordArt.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./zip.js'), require('./xml.js'));
  } else {
    root.Pptx = factory(root.Zip, root.Xml);
  }
})(typeof self !== 'undefined' ? self : this, function (Zip, X) {
  'use strict';

  const EMU_PER_PX = 9525;              // 914400 EMU per inch at 96 dpi
  const emu = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n / EMU_PER_PX : fallback;
  };
  const pt = (hundredths, fallback) => {
    const n = Number(hundredths);
    return Number.isFinite(n) ? (n / 100) * (96 / 72) : fallback;
  };

  const DEFAULT_INSETS = { l: 91440, t: 45720, r: 91440, b: 45720 };

  const esc = (text) => String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

  /**
   * A deck names one typeface; the machine showing it may not have it. Falling
   * back through close metric equivalents keeps a missing Calibri from turning
   * the whole slide serif.
   */
  function fontStack(name) {
    const clean = String(name || '').replace(/["']/g, '').trim();
    const generic = /(times|georgia|garamond|book|serif|roman|minion)/i.test(clean)
      ? 'Georgia, "Times New Roman", serif'
      : /(courier|consol|mono)/i.test(clean)
        ? '"SF Mono", Consolas, monospace'
        : '"Helvetica Neue", Helvetica, Arial, sans-serif';
    return clean ? `'${clean}', ${generic}` : generic;
  }

  const IMAGE_MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', webp: 'image/webp',
    svg: 'image/svg+xml', emf: 'image/emf', wmf: 'image/wmf',
  };

  function toBase64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let binary = '';
    const CHUNK = 0x8000;   // avoid blowing the argument limit on big images
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  /* ── Package plumbing ───────────────────────────────────────────────────── */

  /** Resolve "../media/x.png" against the part that referenced it. */
  function resolvePath(fromPart, target) {
    if (target.startsWith('/')) return target.slice(1);
    const base = fromPart.split('/').slice(0, -1);
    for (const segment of target.split('/')) {
      if (segment === '.' || segment === '') continue;
      if (segment === '..') base.pop();
      else base.push(segment);
    }
    return base.join('/');
  }

  function relsFor(files, partPath) {
    const dir = partPath.split('/').slice(0, -1).join('/');
    const name = partPath.split('/').pop();
    const relsPath = `${dir}/_rels/${name}.rels`;
    const map = new Map();
    const raw = files.get(relsPath);
    if (!raw) return map;

    for (const rel of X.findAll(X.parse(Zip.textOf(raw)), 'Relationship')) {
      const target = X.attr(rel, 'Target');
      if (!target) continue;
      map.set(X.attr(rel, 'Id'), {
        type: X.attr(rel, 'Type', ''),
        external: X.attr(rel, 'TargetMode') === 'External',
        path: resolvePath(partPath, target),
      });
    }
    return map;
  }

  const partXml = (files, path) => (files.has(path) ? X.parse(Zip.textOf(files.get(path))) : null);

  /* ── Colour ─────────────────────────────────────────────────────────────── */

  function readTheme(files, themePath) {
    const scheme = { dk1: '000000', lt1: 'FFFFFF', dk2: '44546A', lt2: 'E7E6E6' };
    const fonts = { major: 'Calibri', minor: 'Calibri' };
    const theme = themePath ? partXml(files, themePath) : null;
    if (!theme) return { scheme, fonts };

    const clrScheme = X.find(theme, 'a:clrScheme');
    if (clrScheme) {
      for (const entry of clrScheme.children) {
        const key = entry.name.replace(/^a:/, '');
        const srgb = X.child(entry, 'a:srgbClr');
        const sys = X.child(entry, 'a:sysClr');
        const value = srgb ? X.attr(srgb, 'val') : (sys ? X.attr(sys, 'lastClr') : null);
        if (value) scheme[key] = value;
      }
    }
    const fontScheme = X.find(theme, 'a:fontScheme');
    if (fontScheme) {
      const major = X.path(fontScheme, 'a:majorFont', 'a:latin');
      const minor = X.path(fontScheme, 'a:minorFont', 'a:latin');
      if (major && X.attr(major, 'typeface')) fonts.major = X.attr(major, 'typeface');
      if (minor && X.attr(minor, 'typeface')) fonts.minor = X.attr(minor, 'typeface');
    }
    return { scheme, fonts };
  }

  function clampByte(n) {
    return Math.max(0, Math.min(255, Math.round(n)));
  }

  /** Apply the luminance/shade modifiers PowerPoint layers onto theme colours. */
  function applyMods(hex, node) {
    let [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const modOf = (name) => {
      const el = X.child(node, name);
      const val = el && X.attr(el, 'val');
      return val === null || val === undefined ? null : Number(val) / 100000;
    };

    const lumMod = modOf('a:lumMod');
    const lumOff = modOf('a:lumOff');
    const shade = modOf('a:shade');
    const tint = modOf('a:tint');

    if (lumMod !== null) [r, g, b] = [r, g, b].map((c) => c * lumMod);
    if (lumOff !== null) [r, g, b] = [r, g, b].map((c) => c + 255 * lumOff);
    if (shade !== null) [r, g, b] = [r, g, b].map((c) => c * shade);
    if (tint !== null) [r, g, b] = [r, g, b].map((c) => c * tint + 255 * (1 - tint));

    return [r, g, b].map((c) => clampByte(c).toString(16).padStart(2, '0')).join('');
  }

  /** Turn a colour-bearing node (srgbClr / schemeClr / …) into {hex, alpha}. */
  function readColor(node, theme) {
    if (!node) return null;
    const srgb = X.child(node, 'a:srgbClr');
    const scheme = X.child(node, 'a:schemeClr');
    const sys = X.child(node, 'a:sysClr');
    const prst = X.child(node, 'a:prstClr');

    let hex = null;
    let source = null;

    if (srgb) { hex = X.attr(srgb, 'val'); source = srgb; }
    else if (scheme) {
      source = scheme;
      const name = X.attr(scheme, 'val', '');
      // tx1/bg1 are the mapped names for dk1/lt1 in the default colour map.
      const mapped = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' }[name] || name;
      hex = theme.scheme[mapped] || theme.scheme[name] || '000000';
    } else if (sys) { hex = X.attr(sys, 'lastClr', '000000'); source = sys; }
    else if (prst) { hex = '000000'; source = prst; }

    if (!hex) return null;
    hex = String(hex).replace(/^#/, '').slice(0, 6).padStart(6, '0');
    if (source) hex = applyMods(hex, source);

    const alphaEl = source && X.child(source, 'a:alpha');
    const alpha = alphaEl ? Number(X.attr(alphaEl, 'val', 100000)) / 100000 : 1;
    // Uppercase throughout, since applyMods would otherwise lowercase only the
    // colours that carry a modifier.
    return { hex: `#${hex.toUpperCase()}`, alpha: Number.isFinite(alpha) ? alpha : 1 };
  }

  /** Read a fill container (spPr, bgPr, tcPr…) into an SVG-ready fill. */
  function readFill(node, theme) {
    if (!node) return null;
    if (X.child(node, 'a:noFill')) return { none: true };

    const solid = X.child(node, 'a:solidFill');
    if (solid) return readColor(solid, theme);

    // Gradients aren't supported; the first stop reads closer than nothing.
    const grad = X.child(node, 'a:gradFill');
    if (grad) {
      const stop = X.find(grad, 'a:gs');
      const color = readColor(stop, theme);
      if (color) return color;
    }
    return null;
  }

  /* ── Geometry ───────────────────────────────────────────────────────────── */

  function readTransform(spPr) {
    const xfrm = X.child(spPr, 'a:xfrm');
    if (!xfrm) return null;
    const off = X.child(xfrm, 'a:off');
    const ext = X.child(xfrm, 'a:ext');
    const chOff = X.child(xfrm, 'a:chOff');
    const chExt = X.child(xfrm, 'a:chExt');
    return {
      x: emu(X.attr(off, 'x', 0)),
      y: emu(X.attr(off, 'y', 0)),
      w: emu(X.attr(ext, 'cx', 0)),
      h: emu(X.attr(ext, 'cy', 0)),
      rot: Number(X.attr(xfrm, 'rot', 0)) / 60000,
      flipH: X.attr(xfrm, 'flipH') === '1',
      flipV: X.attr(xfrm, 'flipV') === '1',
      childOff: chOff ? { x: emu(X.attr(chOff, 'x', 0)), y: emu(X.attr(chOff, 'y', 0)) } : null,
      childExt: chExt ? { w: emu(X.attr(chExt, 'cx', 0)), h: emu(X.attr(chExt, 'cy', 0)) } : null,
    };
  }

  /** Map a shape's own box through any enclosing group transforms. */
  function place(frame, ctx) {
    let { x, y, w, h } = frame;
    for (let i = ctx.groups.length - 1; i >= 0; i -= 1) {
      const g = ctx.groups[i];
      const sx = g.childExt && g.childExt.w ? g.w / g.childExt.w : 1;
      const sy = g.childExt && g.childExt.h ? g.h / g.childExt.h : 1;
      const ox = g.childOff ? g.childOff.x : 0;
      const oy = g.childOff ? g.childOff.y : 0;
      x = g.x + (x - ox) * sx;
      y = g.y + (y - oy) * sy;
      w *= sx;
      h *= sy;
    }
    return { x, y, w, h };
  }

  /* ── Text ───────────────────────────────────────────────────────────────── */

  function runStyle(rPr, theme, inherited) {
    const latin = rPr && X.child(rPr, 'a:latin');
    const fill = rPr ? readFill(rPr, theme) : null;
    return {
      size: pt(rPr && X.attr(rPr, 'sz'), inherited.size),
      bold: rPr ? X.attr(rPr, 'b') === '1' : inherited.bold,
      italic: rPr ? X.attr(rPr, 'i') === '1' : inherited.italic,
      underline: rPr ? (X.attr(rPr, 'u', 'none') !== 'none') : inherited.underline,
      font: (latin && X.attr(latin, 'typeface')) || inherited.font,
      color: fill && !fill.none ? fill.hex : inherited.color,
      alpha: fill && !fill.none ? fill.alpha : 1,
    };
  }

  /** Split a paragraph's runs into words that carry their own styling. */
  function tokenize(paragraph, theme, base) {
    const tokens = [];
    for (const node of paragraph.children) {
      if (node.name === 'a:br') {
        tokens.push({ br: true });
        continue;
      }
      if (node.name !== 'a:r' && node.name !== 'a:fld') continue;

      const style = runStyle(X.child(node, 'a:rPr'), theme, base);
      const text = X.allText(X.child(node, 'a:t')) || (node.name === 'a:fld' ? X.allText(node) : '');
      if (!text) continue;

      // Keep spaces attached so wrapping can break between words only.
      for (const piece of text.split(/(\s+)/)) {
        if (!piece) continue;
        tokens.push({ text: piece, style, space: /^\s+$/.test(piece) });
      }
    }
    return tokens;
  }

  function wrapTokens(tokens, maxWidth, measure) {
    const lines = [];
    let line = [];
    let width = 0;

    const flush = () => { lines.push(line); line = []; width = 0; };

    for (const token of tokens) {
      if (token.br) { flush(); continue; }
      const w = measure(token.text, token.style);
      if (token.space) {
        if (line.length) { line.push({ ...token, w }); width += w; }
        continue;
      }
      if (width + w > maxWidth && line.length) flush();
      line.push({ ...token, w });
      width += w;
    }
    if (line.length) flush();
    return lines.length ? lines : [[]];
  }

  function renderTextBody(txBody, box, theme, measure, out, defaults) {
    const bodyPr = X.child(txBody, 'a:bodyPr');
    const insets = {
      l: emu(X.attr(bodyPr, 'lIns', DEFAULT_INSETS.l)),
      t: emu(X.attr(bodyPr, 'tIns', DEFAULT_INSETS.t)),
      r: emu(X.attr(bodyPr, 'rIns', DEFAULT_INSETS.r)),
      b: emu(X.attr(bodyPr, 'bIns', DEFAULT_INSETS.b)),
    };
    const anchor = X.attr(bodyPr, 'anchor', 't');
    const innerX = box.x + insets.l;
    const innerW = Math.max(8, box.w - insets.l - insets.r);

    /** Lay the paragraphs out at a given font scale. */
    function layout(scale) {
      const blocks = [];
      let totalHeight = 0;

      for (const paragraph of X.children(txBody, 'a:p')) {
        const pPr = X.child(paragraph, 'a:pPr');
        const level = Number(X.attr(pPr, 'lvl', 0)) || 0;
        const marL = emu(X.attr(pPr, 'marL', 0)) || level * 24;
        const align = X.attr(pPr, 'algn', 'l');

        const base = { ...defaults, size: defaults.size };
        const endRPr = X.child(paragraph, 'a:endParaRPr');
        const paraDefault = runStyle(X.child(pPr, 'a:defRPr') || endRPr, theme, base);
        const scaled = (style) => (scale === 1 ? style : { ...style, size: style.size * scale });
        const tokens = tokenize(paragraph, theme, paraDefault)
          .map((token) => (token.br ? token : { ...token, style: scaled(token.style) }));

        // Bullets are only drawn when the deck asks for one explicitly; without
        // inheriting master list styles, guessing adds bullets that aren't there.
        let bullet = '';
        const buChar = X.child(pPr, 'a:buChar');
        const buAuto = X.child(pPr, 'a:buAutoNum');
        if (!X.child(pPr, 'a:buNone')) {
          if (buChar) bullet = X.attr(buChar, 'char', '•');
          else if (buAuto) bullet = '•';
        }

        const lineStyle = tokens.find((t) => t.style)?.style || scaled(paraDefault);
        const spacing = X.child(pPr, 'a:lnSpc');
        const spcPct = spacing && X.path(spacing, 'a:spcPct');
        const lineFactor = spcPct ? Number(X.attr(spcPct, 'val', 100000)) / 100000 : 1.0;

        const spcBefEl = X.path(pPr, 'a:spcBef', 'a:spcPts');
        const spcBef = (spcBefEl ? pt(X.attr(spcBefEl, 'val', 0), 0) : 0) * scale;

        const indent = marL;
        const lines = wrapTokens(tokens, Math.max(8, innerW - indent), measure);

        const blockLines = lines.map((segments, i) => ({
          segments,
          bullet: i === 0 ? bullet : '',
          indent,
          align,
          height: Math.max(lineStyle.size, 4) * 1.2 * lineFactor,
        }));

        totalHeight += spcBef + blockLines.reduce((sum, l) => sum + l.height, 0);
        blocks.push({ lines: blockLines, spcBef, style: lineStyle });
      }
      return { blocks, totalHeight };
    }

    const available = box.h - insets.t - insets.b;

    /*
     * The deck's own font usually isn't installed on the machine showing it, so
     * substituted metrics can wrap a line that used to fit and push text out of
     * its box and over whatever sits below. PowerPoint shrinks overflowing text
     * to fit; doing the same keeps slides readable instead of overlapping.
     */
    let { blocks, totalHeight } = layout(1);
    let scale = 1;
    if (available > 0) {
      for (let attempt = 0; attempt < 4 && totalHeight > available; attempt += 1) {
        // Each pass shrinks relative to the last, so the factor compounds.
        scale = Math.max(0.55, scale * Math.sqrt(available / totalHeight) * 0.98);
        const next = layout(scale);
        blocks = next.blocks;
        totalHeight = next.totalHeight;
        if (scale <= 0.55) break;
      }
    }

    let cursorY = box.y + insets.t;
    if (anchor === 'ctr') cursorY += Math.max(0, (available - totalHeight) / 2);
    else if (anchor === 'b') cursorY += Math.max(0, available - totalHeight);

    for (const block of blocks) {
      cursorY += block.spcBef;
      for (const line of block.lines) {
        const lineWidth = line.segments.reduce((sum, s) => sum + s.w, 0);
        const bulletWidth = line.bullet ? measure(`${line.bullet} `, block.style) : 0;
        const left = innerX + line.indent;

        let x = left + bulletWidth;
        if (line.align === 'ctr') x = innerX + (innerW - lineWidth) / 2;
        else if (line.align === 'r') x = innerX + innerW - lineWidth;

        const baseline = cursorY + line.height * 0.78;

        if (line.bullet) {
          out.push(`<text x="${(x - bulletWidth).toFixed(2)}" y="${baseline.toFixed(2)}"`
            + ` font-family="${esc(fontStack(block.style.font))}" font-size="${block.style.size.toFixed(2)}"`
            + ` fill="${block.style.color}">${esc(line.bullet)}</text>`);
        }

        if (line.segments.length) {
          const spans = line.segments.map((seg) => {
            const s = seg.style;
            const attrs = [
              `font-family="${esc(fontStack(s.font))}"`,
              `font-size="${s.size.toFixed(2)}"`,
              `fill="${s.color}"`,
              s.bold ? 'font-weight="bold"' : '',
              s.italic ? 'font-style="italic"' : '',
              s.underline ? 'text-decoration="underline"' : '',
              s.alpha < 1 ? `fill-opacity="${s.alpha.toFixed(3)}"` : '',
              'xml:space="preserve"',
            ].filter(Boolean).join(' ');
            return `<tspan ${attrs}>${esc(seg.text)}</tspan>`;
          }).join('');
          out.push(`<text x="${x.toFixed(2)}" y="${baseline.toFixed(2)}">${spans}</text>`);
        }
        cursorY += line.height;
      }
    }
  }

  /* ── Shapes ─────────────────────────────────────────────────────────────── */

  function shapeElement(geom, box, fillAttr, strokeAttrs) {
    const { x, y, w, h } = box;
    const common = `${fillAttr} ${strokeAttrs}`;
    if (geom === 'ellipse' || geom === 'circle') {
      return `<ellipse cx="${(x + w / 2).toFixed(2)}" cy="${(y + h / 2).toFixed(2)}"`
        + ` rx="${(w / 2).toFixed(2)}" ry="${(h / 2).toFixed(2)}" ${common}/>`;
    }
    if (geom === 'line' || geom === 'straightConnector1') {
      return `<line x1="${x.toFixed(2)}" y1="${y.toFixed(2)}" x2="${(x + w).toFixed(2)}"`
        + ` y2="${(y + h).toFixed(2)}" ${strokeAttrs}/>`;
    }
    const round = geom === 'roundRect' ? Math.min(w, h) * 0.1 : 0;
    return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(0, w).toFixed(2)}"`
      + ` height="${Math.max(0, h).toFixed(2)}"${round ? ` rx="${round.toFixed(2)}"` : ''} ${common}/>`;
  }

  function strokeFor(spPr, theme) {
    const ln = X.child(spPr, 'a:ln');
    if (!ln || X.child(ln, 'a:noFill')) return 'stroke="none"';
    const color = readFill(ln, theme);
    if (!color || color.none) return 'stroke="none"';
    const width = emu(X.attr(ln, 'w', 9525), 1);
    const dash = X.child(ln, 'a:prstDash');
    const dashVal = dash ? X.attr(dash, 'val', 'solid') : 'solid';
    const dashArray = dashVal === 'dash' ? ' stroke-dasharray="8 6"'
      : dashVal === 'dot' ? ' stroke-dasharray="2 5"' : '';
    return `stroke="${color.hex}" stroke-width="${Math.max(0.5, width).toFixed(2)}"`
      + `${color.alpha < 1 ? ` stroke-opacity="${color.alpha.toFixed(3)}"` : ''}${dashArray}`;
  }

  function rotateWrap(box, transform, body) {
    if (!transform || !transform.rot) return body;
    const cx = (box.x + box.w / 2).toFixed(2);
    const cy = (box.y + box.h / 2).toFixed(2);
    return `<g transform="rotate(${transform.rot.toFixed(2)} ${cx} ${cy})">${body}</g>`;
  }

  function renderPicture(node, ctx, out) {
    const spPr = X.child(node, 'p:spPr');
    const transform = readTransform(spPr);
    if (!transform) return;
    const box = place(transform, ctx);

    const blip = X.path(node, 'p:blipFill', 'a:blip');
    const embed = blip && (X.attr(blip, 'r:embed') || X.attr(blip, 'r:link'));
    const rel = embed && ctx.rels.get(embed);
    if (!rel || rel.external) return;

    const bytes = ctx.files.get(rel.path);
    if (!bytes) return;
    const ext = rel.path.split('.').pop().toLowerCase();
    const mime = IMAGE_MIME[ext] || 'image/png';
    // EMF/WMF are vector formats browsers can't draw; skip rather than show a broken image.
    if (mime === 'image/emf' || mime === 'image/wmf') return;

    const href = `data:${mime};base64,${toBase64(bytes)}`;
    const flip = [];
    if (transform.flipH) flip.push(`translate(${(2 * box.x + box.w).toFixed(2)},0) scale(-1,1)`);
    if (transform.flipV) flip.push(`translate(0,${(2 * box.y + box.h).toFixed(2)}) scale(1,-1)`);

    let body = `<image x="${box.x.toFixed(2)}" y="${box.y.toFixed(2)}"`
      + ` width="${Math.max(0, box.w).toFixed(2)}" height="${Math.max(0, box.h).toFixed(2)}"`
      + ` preserveAspectRatio="none" href="${href}"/>`;
    if (flip.length) body = `<g transform="${flip.join(' ')}">${body}</g>`;
    out.push(rotateWrap(box, transform, body));
  }

  function renderShape(node, ctx, out) {
    const spPr = X.child(node, 'p:spPr');
    const transform = readTransform(spPr);
    if (!transform) return;
    const box = place(transform, ctx);

    const geomEl = X.child(spPr, 'a:prstGeom');
    const geom = geomEl ? X.attr(geomEl, 'prst', 'rect') : 'rect';
    const fill = readFill(spPr, ctx.theme);
    const fillAttr = !fill || fill.none
      ? 'fill="none"'
      : `fill="${fill.hex}"${fill.alpha < 1 ? ` fill-opacity="${fill.alpha.toFixed(3)}"` : ''}`;

    const pieces = [];
    if (box.w > 0 && box.h > 0) {
      pieces.push(shapeElement(geom, box, fillAttr, strokeFor(spPr, ctx.theme)));
    }

    const txBody = X.child(node, 'p:txBody');
    if (txBody) renderTextBody(txBody, box, ctx.theme, ctx.measure, pieces, ctx.defaults);

    out.push(rotateWrap(box, transform, pieces.join('')));
  }

  function renderTable(graphicFrame, ctx, out, box) {
    const tbl = X.find(graphicFrame, 'a:tbl');
    if (!tbl) return false;

    const grid = X.child(tbl, 'a:tblGrid');
    const colWidths = X.children(grid, 'a:gridCol').map((c) => emu(X.attr(c, 'w', 0)));
    const totalW = colWidths.reduce((a, b) => a + b, 0) || box.w;
    const scale = box.w / totalW;

    let y = box.y;
    for (const row of X.children(tbl, 'a:tr')) {
      const rowH = emu(X.attr(row, 'h', 0)) || 24;
      let x = box.x;
      X.children(row, 'a:tc').forEach((cell, i) => {
        const w = (colWidths[i] || totalW / Math.max(1, colWidths.length)) * scale;
        const tcPr = X.child(cell, 'a:tcPr');
        const fill = readFill(tcPr, ctx.theme);
        const cellBox = { x, y, w, h: rowH };

        out.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}"`
          + ` height="${rowH.toFixed(2)}" fill="${fill && !fill.none ? fill.hex : 'none'}"`
          + ' stroke="#c9ccd4" stroke-width="1"/>');

        const txBody = X.child(cell, 'a:txBody');
        if (txBody) renderTextBody(txBody, cellBox, ctx.theme, ctx.measure, out, ctx.defaults);
        x += w;
      });
      y += rowH;
    }
    return true;
  }

  function renderGraphicFrame(node, ctx, out) {
    const xfrm = X.path(node, 'p:xfrm');
    const off = X.child(xfrm, 'a:off');
    const ext = X.child(xfrm, 'a:ext');
    const box = place({
      x: emu(X.attr(off, 'x', 0)), y: emu(X.attr(off, 'y', 0)),
      w: emu(X.attr(ext, 'cx', 0)), h: emu(X.attr(ext, 'cy', 0)),
    }, ctx);

    if (renderTable(node, ctx, out, box)) return;

    // Charts and SmartArt aren't rendered; leave a labelled space so the slide
    // still reads the way it was laid out instead of showing a blank gap.
    const uri = X.attr(X.find(node, 'a:graphicData'), 'uri', '');
    const label = uri.includes('chart') ? 'Chart' : uri.includes('diagram') ? 'Diagram' : 'Embedded object';
    out.push(`<rect x="${box.x.toFixed(2)}" y="${box.y.toFixed(2)}" width="${box.w.toFixed(2)}"`
      + ` height="${box.h.toFixed(2)}" fill="#f2f4f8" stroke="#c9ccd4" stroke-width="1"`
      + ' stroke-dasharray="6 5"/>');
    out.push(`<text x="${(box.x + box.w / 2).toFixed(2)}" y="${(box.y + box.h / 2).toFixed(2)}"`
      + ` text-anchor="middle" font-family="${esc(fontStack(''))}" font-size="16" fill="#8d97a8">`
      + `${esc(label)}</text>`);
  }

  function renderTree(tree, ctx, out) {
    for (const node of tree.children) {
      switch (node.name) {
        case 'p:sp':
          renderShape(node, ctx, out);
          break;
        case 'p:pic':
          renderPicture(node, ctx, out);
          break;
        case 'p:cxnSp':
          renderShape(node, ctx, out);
          break;
        case 'p:graphicFrame':
          renderGraphicFrame(node, ctx, out);
          break;
        case 'p:grpSp': {
          const transform = readTransform(X.child(node, 'p:grpSpPr'));
          if (!transform) { renderTree(node, ctx, out); break; }
          const placed = place(transform, ctx);
          ctx.groups.push({ ...transform, x: placed.x, y: placed.y, w: placed.w, h: placed.h });
          renderTree(node, ctx, out);
          ctx.groups.pop();
          break;
        }
        default:
          break;
      }
    }
  }

  /* ── Slides ─────────────────────────────────────────────────────────────── */

  function backgroundOf(slideXml, theme) {
    const bg = X.find(slideXml, 'p:bg');
    if (!bg) return null;
    const bgPr = X.child(bg, 'p:bgPr');
    if (bgPr) return readFill(bgPr, theme);
    const ref = X.child(bg, 'p:bgRef');
    if (ref) return readColor(ref, theme);
    return null;
  }

  function slideTitle(slideXml) {
    for (const sp of X.findAll(slideXml, 'p:sp')) {
      const ph = X.path(sp, 'p:nvSpPr', 'p:nvPr', 'p:ph');
      const type = ph && X.attr(ph, 'type', '');
      if (type === 'title' || type === 'ctrTitle') {
        const text = X.allText(X.child(sp, 'p:txBody')).trim();
        if (text) return text.slice(0, 120);
      }
    }
    const firstText = X.findAll(slideXml, 'a:t').map((n) => X.allText(n).trim()).find(Boolean);
    return firstText ? firstText.slice(0, 120) : '';
  }

  /** Rough text measurement for environments without a canvas (tests). */
  function approximateMeasure(text, style) {
    const factor = style.bold ? 0.56 : 0.52;
    return text.length * style.size * factor;
  }

  /**
   * Convert a .pptx into SVG slides.
   * `measureText(text, style)` should return a pixel width; pass a canvas-backed
   * implementation in the browser for accurate wrapping.
   */
  async function render(arrayBuffer, options = {}) {
    const measure = options.measureText || approximateMeasure;
    const files = await Zip.read(arrayBuffer);

    const presentationPath = 'ppt/presentation.xml';
    const presentation = partXml(files, presentationPath);
    if (!presentation) throw new Error('That file is not a PowerPoint presentation.');

    const sldSz = X.find(presentation, 'p:sldSz');
    const width = emu(X.attr(sldSz, 'cx', 12192000), 1280);
    const height = emu(X.attr(sldSz, 'cy', 6858000), 720);

    const presRels = relsFor(files, presentationPath);
    const themeRel = [...presRels.values()].find((r) => r.type.endsWith('/theme'));
    const theme = readTheme(files, themeRel && themeRel.path);

    const defaults = {
      size: pt(1800, 24),
      bold: false,
      italic: false,
      underline: false,
      font: theme.fonts.minor,
      color: '#000000',
      alpha: 1,
    };

    const order = X.findAll(X.find(presentation, 'p:sldIdLst') || presentation, 'p:sldId')
      .map((node) => presRels.get(X.attr(node, 'r:id')))
      .filter((rel) => rel && rel.path && files.has(rel.path));

    const slides = [];
    for (let i = 0; i < order.length; i += 1) {
      const slidePath = order[i].path;
      const slideXml = partXml(files, slidePath);
      if (!slideXml) continue;

      const slideRels = relsFor(files, slidePath);
      const layoutRel = [...slideRels.values()].find((r) => r.type.endsWith('/slideLayout'));
      const layoutXml = layoutRel ? partXml(files, layoutRel.path) : null;
      const layoutRels = layoutRel ? relsFor(files, layoutRel.path) : new Map();

      let masterXml = null;
      let masterRels = new Map();
      if (layoutRel) {
        const masterRel = [...layoutRels.values()].find((r) => r.type.endsWith('/slideMaster'));
        if (masterRel) {
          masterXml = partXml(files, masterRel.path);
          masterRels = relsFor(files, masterRel.path);
        }
      }

      const background = backgroundOf(slideXml, theme)
        || (layoutXml && backgroundOf(layoutXml, theme))
        || (masterXml && backgroundOf(masterXml, theme))
        || { hex: '#FFFFFF', alpha: 1 };

      const body = [];
      body.push(`<rect x="0" y="0" width="${width.toFixed(2)}" height="${height.toFixed(2)}"`
        + ` fill="${background.none ? '#FFFFFF' : background.hex}"/>`);

      // Decorative furniture from the layout and master sits behind the slide's
      // own shapes. Placeholders are skipped: unfilled ones carry prompt text.
      for (const [xml, rels] of [[masterXml, masterRels], [layoutXml, layoutRels]]) {
        const tree = xml && X.find(xml, 'p:spTree');
        if (!tree) continue;
        const decorative = {
          ...tree,
          children: tree.children.filter((n) => !X.path(n, 'p:nvSpPr', 'p:nvPr', 'p:ph')
            && !X.path(n, 'p:nvPicPr', 'p:nvPr', 'p:ph')),
        };
        renderTree(decorative, { files, rels, theme, measure, defaults, groups: [] }, body);
      }

      const spTree = X.find(slideXml, 'p:spTree');
      if (spTree) {
        renderTree(spTree, { files, rels: slideRels, theme, measure, defaults, groups: [] }, body);
      }

      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`
        + ` width="${width.toFixed(0)}" height="${height.toFixed(0)}"`
        + ` viewBox="0 0 ${width.toFixed(2)} ${height.toFixed(2)}">${body.join('')}</svg>`;

      slides.push({ index: slides.length, title: slideTitle(slideXml), svg });
    }

    if (!slides.length) throw new Error('That presentation has no slides.');
    return { width, height, slides };
  }

  return { render, approximateMeasure };
});
