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
    module.exports = factory(require('./zip.js'), require('./xml.js'), require('./emf.js'));
  } else {
    root.Pptx = factory(root.Zip, root.Xml, root.Emf);
  }
})(typeof self !== 'undefined' ? self : this, function (Zip, X, Emf) {
  'use strict';

  const EMU_PER_PX = 9525;              // 914400 EMU per inch at 96 dpi

  /*
   * Below this, in pixels, an embedded object is not something anyone is
   * looking at — half an inch. See renderGraphicFrame for why it matters.
   */
  const MIN_VISIBLE = 48;
  const emu = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n / EMU_PER_PX : fallback;
  };
  /*
   * A point size, in hundredths, or the inherited one.
   *
   * The guard matters more than it looks: Number(null) is 0, and 0 is a finite
   * number, so an absent size used to resolve to nothing rather than fall back.
   * A paragraph with no a:defRPr and no a:endParaRPr — which older decks write
   * routinely — then laid every one of its runs out at zero and the slide came
   * back blank with the text present but invisible.
   */
  const pt = (hundredths, fallback) => {
    if (hundredths === null || hundredths === undefined || hundredths === '') return fallback;
    const n = Number(hundredths);
    return Number.isFinite(n) && n > 0 ? (n / 100) * (96 / 72) : fallback;
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
      size: pt(rPr ? X.attr(rPr, 'sz') : undefined, inherited.size),
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

  /*
   * Split a run too wide to sit on a line of its own.
   *
   * Wrapping between words cannot help a single word wider than its box — a
   * long identifier, a URL, a column of digits — and putting it on a line
   * anyway is what pushes text out past the shape and over whatever is beside
   * it. PowerPoint breaks mid-word rather than spill, so this does too.
   *
   * The first guess is proportional, which lands within a character or two, and
   * then it is nudged: measuring every prefix of a long run is needlessly slow.
   */
  function breakToken(token, maxWidth, measure) {
    const pieces = [];
    let rest = token.text;

    while (rest) {
      const full = measure(rest, token.style);
      if (full <= maxWidth) { pieces.push({ ...token, text: rest, w: full }); break; }

      let take = Math.max(1, Math.min(rest.length - 1,
        Math.floor((rest.length * maxWidth) / full)));
      while (take > 1 && measure(rest.slice(0, take), token.style) > maxWidth) take -= 1;
      while (take < rest.length - 1
        && measure(rest.slice(0, take + 1), token.style) <= maxWidth) take += 1;

      pieces.push({ ...token, text: rest.slice(0, take), w: measure(rest.slice(0, take), token.style) });
      rest = rest.slice(take);
    }
    return pieces;
  }

  function wrapTokens(tokens, maxWidth, measure) {
    const lines = [];
    let line = [];
    let width = 0;

    /*
     * A space at the end of a line draws nothing, so counting its width wraps
     * the next word a little too early and shifts centred and right-aligned
     * text left by the width of a space. Drop it when the line closes.
     */
    const flush = () => {
      while (line.length && line[line.length - 1].space) line.pop();
      lines.push(line);
      line = [];
      width = 0;
    };

    for (const token of tokens) {
      if (token.br) { flush(); continue; }
      const w = measure(token.text, token.style);
      if (token.space) {
        if (line.length) { line.push({ ...token, w }); width += w; }
        continue;
      }

      /* Wider than a whole line: break it rather than let it hang off the box. */
      if (w > maxWidth && token.text.length > 1) {
        if (line.length) flush();
        const pieces = breakToken(token, maxWidth, measure);
        pieces.forEach((piece, i) => {
          line.push(piece);
          width += piece.w;
          if (i < pieces.length - 1) flush();
        });
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

  /*
   * Preset geometries, as outlines in a unit box that the shape's own box then
   * scales. PowerPoint defines these with adjust handles and formulas; these
   * are the default proportions, which is what all but a hand-edited shape
   * uses.
   *
   * The point of having them is meaning, not decoration: an arrow drawn as a
   * rectangle turns "A → B" into "A ▭ B", and a deck full of boxes and arrows
   * loses the half that carries the argument.
   */
  const PRESETS = {
    triangle:        (a) => [[a, 0], [1, 1], [0, 1]],
    rtTriangle:      () => [[0, 0], [0, 1], [1, 1]],
    diamond:         () => [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]],
    parallelogram:   (a) => [[a, 0], [1, 0], [1 - a, 1], [0, 1]],
    trapezoid:       (a) => [[a, 0], [1 - a, 0], [1, 1], [0, 1]],
    pentagon:        () => [[0.5, 0], [1, 0.38], [0.81, 1], [0.19, 1], [0, 0.38]],
    hexagon:         (a) => [[a, 0], [1 - a, 0], [1, 0.5], [1 - a, 1], [a, 1], [0, 0.5]],
    octagon:         (a) => [[a, 0], [1 - a, 0], [1, a], [1, 1 - a],
                             [1 - a, 1], [a, 1], [0, 1 - a], [0, a]],
    plus:            (a) => [[a, 0], [1 - a, 0], [1 - a, a], [1, a], [1, 1 - a], [1 - a, 1 - a],
                             [1 - a, 1], [a, 1], [a, 1 - a], [0, 1 - a], [0, a], [a, a]],
    // "homePlate" is the pentagon-shaped process arrow; "chevron" is its
    // notched cousin, and both are staples of a process diagram.
    homePlate:       (a) => [[0, 0], [1 - a, 0], [1, 0.5], [1 - a, 1], [0, 1]],
    chevron:         (a) => [[0, 0], [1 - a, 0], [1, 0.5], [1 - a, 1], [0, 1], [a, 0.5]],
    rightArrow:      (a, b) => [[0, b], [1 - a, b], [1 - a, 0], [1, 0.5],
                                [1 - a, 1], [1 - a, 1 - b], [0, 1 - b]],
    leftArrow:       (a, b) => [[1, b], [a, b], [a, 0], [0, 0.5],
                                [a, 1], [a, 1 - b], [1, 1 - b]],
    downArrow:       (a, b) => [[b, 0], [1 - b, 0], [1 - b, 1 - a], [1, 1 - a],
                                [0.5, 1], [0, 1 - a], [b, 1 - a]],
    upArrow:         (a, b) => [[b, 1], [1 - b, 1], [1 - b, a], [1, a],
                                [0.5, 0], [0, a], [b, a]],
    leftRightArrow:  (a, b) => [[0, 0.5], [a, 0], [a, b], [1 - a, b], [1 - a, 0], [1, 0.5],
                                [1 - a, 1], [1 - a, 1 - b], [a, 1 - b], [a, 1]],
    upDownArrow:     (a, b) => [[0.5, 0], [1, a], [1 - b, a], [1 - b, 1 - a], [1, 1 - a],
                                [0.5, 1], [0, 1 - a], [b, 1 - a], [b, a], [0, a]],
  };

  // Default adjust values, as fractions of the box.
  const PRESET_ADJUST = {
    triangle: [0.5], parallelogram: [0.25], trapezoid: [0.25], hexagon: [0.25],
    octagon: [0.29], plus: [0.25], homePlate: [0.25], chevron: [0.25],
    rightArrow: [0.35, 0.25], leftArrow: [0.35, 0.25],
    downArrow: [0.35, 0.25], upArrow: [0.35, 0.25],
    leftRightArrow: [0.25, 0.25], upDownArrow: [0.25, 0.25],
  };

  function presetPath(geom, box) {
    const build = PRESETS[geom];
    if (!build) return null;
    const points = build(...(PRESET_ADJUST[geom] || []));
    const d = points
      .map(([ux, uy], i) => `${i ? 'L' : 'M'}${(box.x + ux * box.w).toFixed(2)},`
        + `${(box.y + uy * box.h).toFixed(2)}`)
      .join(' ');
    return `${d} Z`;
  }

  /**
   * Mirror an outline in its own box.
   *
   * A flipped right-arrow is a left-arrow, so the flags have to be honoured or
   * half the arrows in a process diagram point the wrong way. Only the outline
   * is mirrored: PowerPoint leaves the text in a flipped shape reading
   * normally, and so does this.
   */
  function flipWrap(box, transform, body) {
    if (!transform || (!transform.flipH && !transform.flipV)) return body;
    const parts = [];
    if (transform.flipH) parts.push(`translate(${(2 * box.x + box.w).toFixed(2)},0) scale(-1,1)`);
    if (transform.flipV) parts.push(`translate(0,${(2 * box.y + box.h).toFixed(2)}) scale(1,-1)`);
    return `<g transform="${parts.join(' ')}">${body}</g>`;
  }

  /*
   * Elbow connectors. PowerPoint routes these itself; the box plus the flip
   * flags say which corner it turns, which is enough to draw the same elbow.
   */
  function connectorPath(geom, box) {
    const x1 = box.x;
    const x2 = box.x + box.w;
    const y1 = box.y;
    const y2 = box.y + box.h;
    if (geom === 'bentConnector2') {
      return `M${x1.toFixed(2)},${y1.toFixed(2)} L${x2.toFixed(2)},${y1.toFixed(2)}`
        + ` L${x2.toFixed(2)},${y2.toFixed(2)}`;
    }
    // bentConnector3 turns twice, halfway along.
    const midX = (x1 + x2) / 2;
    return `M${x1.toFixed(2)},${y1.toFixed(2)} L${midX.toFixed(2)},${y1.toFixed(2)}`
      + ` L${midX.toFixed(2)},${y2.toFixed(2)} L${x2.toFixed(2)},${y2.toFixed(2)}`;
  }

  function shapeElement(geom, box, fillAttr, strokeAttrs) {
    const { x, y, w, h } = box;
    const common = `${fillAttr} ${strokeAttrs}`;
    if (geom === 'ellipse' || geom === 'circle') {
      return `<ellipse cx="${(x + w / 2).toFixed(2)}" cy="${(y + h / 2).toFixed(2)}"`
        + ` rx="${(w / 2).toFixed(2)}" ry="${(h / 2).toFixed(2)}" ${common}/>`;
    }
    if (geom === 'line' || /^straightConnector/.test(geom)) {
      return `<line x1="${x.toFixed(2)}" y1="${y.toFixed(2)}" x2="${(x + w).toFixed(2)}"`
        + ` y2="${(y + h).toFixed(2)}" ${strokeAttrs}/>`;
    }
    if (/^bentConnector[23]$/.test(geom)) {
      return `<path d="${connectorPath(geom, box)}" fill="none" ${strokeAttrs}/>`;
    }

    const path = presetPath(geom, box);
    if (path) return `<path d="${path}" ${common}/>`;

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
    /*
     * EMF is a Windows vector format no browser draws, and it is what sits
     * behind most embedded charts and Visio drawings. emf.js plays the records
     * back as SVG; when it manages that, the result travels as an ordinary
     * image. WMF is the older format and is not implemented, so it is still
     * recorded rather than silently dropped.
     */
    let href;
    if (mime === 'image/emf' || mime === 'image/wmf') {
      const drawn = mime === 'image/emf' && Emf && Emf.isEmf(bytes)
        ? Emf.render(bytes, { width: Math.max(1, box.w), height: Math.max(1, box.h) })
        : null;
      if (!drawn) {
        note(ctx, ext === 'wmf' ? 'a Windows metafile' : 'an embedded drawing');
        return;
      }
      href = `data:image/svg+xml;base64,${toBase64(new TextEncoder().encode(drawn))}`;
    } else {
      href = `data:${mime};base64,${toBase64(bytes)}`;
    }
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
      pieces.push(flipWrap(box, transform,
        shapeElement(geom, box, fillAttr, strokeFor(spPr, ctx.theme))));
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

  /* ── Charts ─────────────────────────────────────────────────────────────── */

  /*
   * PowerPoint stores a chart's numbers twice: as a reference into an embedded
   * workbook, and as a cache of the values as they were last drawn. The cache
   * is what is rendered here, which means a chart draws from the slide alone —
   * no spreadsheet to open, and nothing that has to leave the device.
   */

  const CHART_KINDS = ['barChart', 'lineChart', 'pieChart', 'doughnutChart',
    'areaChart', 'scatterChart'];

  const FALLBACK_SERIES = ['#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F', '#EDC948'];
  const ACCENTS = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];

  /** Read a c:strCache / c:numCache into a dense array, honouring gaps. */
  function cacheValues(holder, kind) {
    const cache = X.find(holder, kind);
    if (!cache) return [];
    const out = [];
    for (const point of X.findAll(cache, 'c:pt')) {
      const idx = Number(X.attr(point, 'idx', out.length));
      out[idx] = X.allText(X.child(point, 'c:v'));
    }
    const count = Number(X.attr(X.child(cache, 'c:ptCount'), 'val', out.length));
    return Array.from({ length: Math.max(count, out.length) }, (unused, i) => out[i]);
  }

  /*
   * Category labels come three ways: a plain string cache, a number cache, or —
   * whenever the axis has any grouping at all, which is common — a multi-level
   * cache whose first level holds the labels a reader actually sees.
   */
  function readCategories(cat) {
    const flat = cacheValues(cat, 'c:strCache');
    if (flat.length) return flat;

    const multi = X.find(cat, 'c:multiLvlStrCache');
    const level = multi && X.child(multi, 'c:lvl');
    if (level) {
      const out = [];
      for (const point of X.findAll(level, 'c:pt')) {
        const idx = Number(X.attr(point, 'idx', out.length));
        out[idx] = X.allText(X.child(point, 'c:v'));
      }
      const count = Number(X.attr(X.child(multi, 'c:ptCount'), 'val', out.length));
      return Array.from({ length: Math.max(count, out.length) }, (unused, i) => out[i]);
    }
    return cacheValues(cat, 'c:numCache');
  }

  function readSeries(ser, theme, index) {
    const label = X.allText(X.find(X.child(ser, 'c:tx'), 'c:v')).trim();
    const categories = readCategories(X.child(ser, 'c:cat'));

    const values = cacheValues(X.child(ser, 'c:val'), 'c:numCache').map((raw) => {
      const n = raw === undefined || raw === '' ? NaN : Number(raw);
      return Number.isFinite(n) ? n : null;
    });

    const own = readFill(X.child(ser, 'c:spPr'), theme);
    // Per-point colours, which is how a pie gets more than one.
    const points = new Map();
    for (const dPt of X.children(ser, 'c:dPt')) {
      const idx = Number(X.attr(X.child(dPt, 'c:idx'), 'val', -1));
      const fill = readFill(X.child(dPt, 'c:spPr'), theme);
      if (idx >= 0 && fill && !fill.none) points.set(idx, fill.hex);
    }

    return {
      name: label || `Series ${index + 1}`,
      categories,
      values,
      color: own && !own.none ? own.hex : null,
      points,
    };
  }

  function seriesColor(series, i, theme) {
    if (series && series.color) return series.color;
    const themed = theme.scheme[ACCENTS[i % ACCENTS.length]];
    return themed ? `#${themed.toUpperCase()}` : FALLBACK_SERIES[i % FALLBACK_SERIES.length];
  }

  /** Round an axis bound out to a number a person would have chosen. */
  function niceBound(value) {
    if (!(value > 0)) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    const scaled = value / magnitude;
    const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
    return step * magnitude;
  }

  function fmtTick(value) {
    const abs = Math.abs(value);
    if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
    if (Number.isInteger(value)) return String(value);
    return String(Number(value.toFixed(2)));
  }

  const textEl = (x, y, size, fill, anchor, font, body, weight) =>
    `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" font-family="${esc(font)}"`
    + ` font-size="${size.toFixed(1)}" fill="${fill}" text-anchor="${anchor}"`
    + `${weight ? ` font-weight="${weight}"` : ''}>${esc(body)}</text>`;

  /*
   * A chart carries the colour its text is meant to be, which matters: these
   * decks put white-labelled charts on near-black slides. Hard-coding a grey
   * would leave the axis unreadable on exactly the slides that took the most
   * care over their design. Gridlines are the same ink, faint.
   */
  function chartInk(chartXml, theme) {
    const txPr = X.find(chartXml, 'c:txPr');
    const colour = txPr && readColor(X.find(txPr, 'a:solidFill'), theme);
    return colour && !colour.none ? colour.hex : '#5A6270';
  }

  /** Bars, lines and areas — everything drawn against a pair of axes. */
  function drawAxes(kind, plot, seriesList, area, font, ink, pieces) {
    const stacked = /stacked/i.test(X.attr(X.child(plot, 'c:grouping'), 'val', 'clustered'));
    const percent = /percentStacked/i.test(X.attr(X.child(plot, 'c:grouping'), 'val', ''));
    const horizontal = kind === 'barChart'
      && X.attr(X.child(plot, 'c:barDir'), 'val', 'col') === 'bar';

    const categories = seriesList.reduce(
      (best, s) => (s.categories.length > best.length ? s.categories : best), [],
    );
    const count = Math.max(1, categories.length
      || Math.max(...seriesList.map((s) => s.values.length)));

    // Bounds. Stacked series add up; everything else is plotted independently.
    let high = 0;
    let low = 0;
    for (let i = 0; i < count; i += 1) {
      if (stacked) {
        const sum = seriesList.reduce((a, s) => a + Math.max(0, s.values[i] || 0), 0);
        const neg = seriesList.reduce((a, s) => a + Math.min(0, s.values[i] || 0), 0);
        high = Math.max(high, sum);
        low = Math.min(low, neg);
      } else {
        for (const s of seriesList) {
          const v = s.values[i];
          if (v === null || v === undefined) continue;
          high = Math.max(high, v);
          low = Math.min(low, v);
        }
      }
    }
    if (percent) { high = 1; low = 0; }
    const top = niceBound(high) || 1;
    const bottom = low < 0 ? -niceBound(-low) : 0;
    const span = top - bottom || 1;

    const tick = Math.max(8, Math.min(11, area.h * 0.05));
    const valueGut = horizontal ? tick * 3.4 : tick * 2.8;
    const catGut = tick * 1.9;
    const plotBox = horizontal
      ? { x: area.x + valueGut, y: area.y, w: area.w - valueGut, h: area.h - catGut }
      : { x: area.x + valueGut, y: area.y, w: area.w - valueGut, h: area.h - catGut };
    if (plotBox.w <= 2 || plotBox.h <= 2) return;

    const STEPS = 4;
    // Gridlines and their labels, along whichever axis carries the values.
    for (let i = 0; i <= STEPS; i += 1) {
      const value = bottom + (span * i) / STEPS;
      const label = percent ? `${Math.round(value * 100)}%` : fmtTick(value);
      if (horizontal) {
        const x = plotBox.x + (plotBox.w * i) / STEPS;
        pieces.push(`<line x1="${x.toFixed(2)}" y1="${plotBox.y.toFixed(2)}" x2="${x.toFixed(2)}"`
          + ` y2="${(plotBox.y + plotBox.h).toFixed(2)}" stroke="${ink}" stroke-opacity="0.22" stroke-width="1"/>`);
        pieces.push(textEl(x, plotBox.y + plotBox.h + tick * 1.3, tick, ink, 'middle', font, label));
      } else {
        const y = plotBox.y + plotBox.h - (plotBox.h * i) / STEPS;
        pieces.push(`<line x1="${plotBox.x.toFixed(2)}" y1="${y.toFixed(2)}"`
          + ` x2="${(plotBox.x + plotBox.w).toFixed(2)}" y2="${y.toFixed(2)}"`
          + ` stroke="${ink}" stroke-opacity="0.22" stroke-width="1"/>`);
        pieces.push(textEl(plotBox.x - tick * 0.5, y + tick * 0.35, tick, ink, 'end', font, label));
      }
    }

    const zero = horizontal
      ? plotBox.x + ((0 - bottom) / span) * plotBox.w
      : plotBox.y + plotBox.h - ((0 - bottom) / span) * plotBox.h;

    const slot = (horizontal ? plotBox.h : plotBox.w) / count;

    // Category labels. Crowded ones are thinned rather than overlapped.
    const every = Math.ceil(count / Math.max(1, Math.floor((horizontal ? plotBox.h : plotBox.w) / (tick * 3.2))));
    categories.forEach((name, i) => {
      if (name === undefined || i % every) return;
      if (horizontal) {
        pieces.push(textEl(plotBox.x - tick * 0.5, plotBox.y + slot * (i + 0.5) + tick * 0.35,
          tick, ink, 'end', font, String(name)));
      } else {
        pieces.push(textEl(plotBox.x + slot * (i + 0.5), plotBox.y + plotBox.h + tick * 1.4,
          tick, ink, 'middle', font, String(name)));
      }
    });

    const toLength = (v) => (Math.abs(v) / span) * (horizontal ? plotBox.w : plotBox.h);

    if (kind === 'barChart') {
      const inner = slot * 0.72;
      const each = stacked ? inner : inner / seriesList.length;
      const running = new Array(count).fill(0);

      seriesList.forEach((series, si) => {
        for (let i = 0; i < count; i += 1) {
          const raw = series.values[i];
          if (raw === null || raw === undefined) continue;
          const value = percent
            ? raw / (seriesList.reduce((a, s) => a + Math.abs(s.values[i] || 0), 0) || 1)
            : raw;
          const len = toLength(value);
          if (horizontal) {
            const y = plotBox.y + slot * i + (slot - inner) / 2 + (stacked ? 0 : each * si);
            const x = value >= 0 ? zero + running[i] : zero - running[i] - len;
            pieces.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${len.toFixed(2)}"`
              + ` height="${each.toFixed(2)}" fill="${series.plotFill}"/>`);
          } else {
            const x = plotBox.x + slot * i + (slot - inner) / 2 + (stacked ? 0 : each * si);
            const y = value >= 0 ? zero - running[i] - len : zero + running[i];
            pieces.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${each.toFixed(2)}"`
              + ` height="${len.toFixed(2)}" fill="${series.plotFill}"/>`);
          }
          if (stacked) running[i] += len;
        }
      });
    } else {
      // Lines, areas and scatter all reduce to a run of points.
      seriesList.forEach((series) => {
        const pts = [];
        for (let i = 0; i < count; i += 1) {
          const v = series.values[i];
          if (v === null || v === undefined) continue;
          const along = horizontal
            ? plotBox.y + slot * (i + 0.5)
            : plotBox.x + slot * (i + 0.5);
          const across = horizontal
            ? zero + ((v - 0) / span) * plotBox.w
            : zero - ((v - 0) / span) * plotBox.h;
          pts.push(horizontal ? [across, along] : [along, across]);
        }
        if (pts.length < 1) return;
        const d = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(2)},${py.toFixed(2)}`).join(' ');

        if (kind === 'areaChart') {
          const first = pts[0];
          const last = pts[pts.length - 1];
          pieces.push(`<path d="${d} L${last[0].toFixed(2)},${zero.toFixed(2)}`
            + ` L${first[0].toFixed(2)},${zero.toFixed(2)} Z" fill="${series.plotFill}"`
            + ' fill-opacity="0.45"/>');
        }
        pieces.push(`<path d="${d}" fill="none" stroke="${series.plotFill}" stroke-width="2.5"`
          + ' stroke-linejoin="round" stroke-linecap="round"/>');
        if (pts.length <= 24) {
          for (const [px, py] of pts) {
            pieces.push(`<circle cx="${px.toFixed(2)}" cy="${py.toFixed(2)}" r="3"`
              + ` fill="${series.plotFill}"/>`);
          }
        }
      });
    }

    // The baseline sits on top of the bars so it doesn't get buried.
    if (horizontal) {
      pieces.push(`<line x1="${zero.toFixed(2)}" y1="${plotBox.y.toFixed(2)}" x2="${zero.toFixed(2)}"`
        + ` y2="${(plotBox.y + plotBox.h).toFixed(2)}" stroke="${ink}" stroke-opacity="0.55" stroke-width="1.25"/>`);
    } else {
      pieces.push(`<line x1="${plotBox.x.toFixed(2)}" y1="${zero.toFixed(2)}"`
        + ` x2="${(plotBox.x + plotBox.w).toFixed(2)}" y2="${zero.toFixed(2)}"`
        + ` stroke="${ink}" stroke-opacity="0.55" stroke-width="1.25"/>`);
    }
  }

  function drawPie(kind, series, area, font, ink, pieces) {
    const total = series.values.reduce((a, v) => a + Math.abs(v || 0), 0);
    if (!total) return;

    const cx = area.x + area.w / 2;
    const cy = area.y + area.h / 2;
    const radius = Math.min(area.w, area.h) / 2 * 0.92;
    const hole = kind === 'doughnutChart' ? radius * 0.5 : 0;

    let angle = -Math.PI / 2;                    // twelve o'clock, as PowerPoint does
    series.values.forEach((raw, i) => {
      const value = Math.abs(raw || 0);
      if (!value) return;
      const sweep = (value / total) * Math.PI * 2;
      const end = angle + sweep;
      const large = sweep > Math.PI ? 1 : 0;
      const p = (r, a) => `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;

      // A single value fills the ring, and an arc cannot express a full circle.
      const d = sweep >= Math.PI * 2 - 1e-9
        ? `M${p(radius, 0)} A${radius},${radius} 0 1 1 ${p(radius, Math.PI)}`
          + ` A${radius},${radius} 0 1 1 ${p(radius, 0)} Z`
        : `M${p(hole, angle)} L${p(radius, angle)}`
          + ` A${radius},${radius} 0 ${large} 1 ${p(radius, end)}`
          + (hole
            ? ` L${p(hole, end)} A${hole},${hole} 0 ${large} 0 ${p(hole, angle)} Z`
            : ` L${cx.toFixed(2)},${cy.toFixed(2)} Z`);

      pieces.push(`<path d="${d}" fill="${series.sliceFill(i)}" stroke="#FFFFFF" stroke-width="1"/>`);
      angle = end;
    });
  }

  function drawLegend(entries, box, area, pos, legendW, font, ink, pieces) {
    const size = Math.max(8, Math.min(11, box.h * 0.045));
    const swatch = size * 0.85;
    if (pos === 'b' || pos === 't') {
      const y = pos === 'b' ? box.y + box.h - size * 0.8 : box.y + size * 1.4;
      const width = entries.reduce((a, e) => a + swatch + 6 + e.name.length * size * 0.5 + 12, 0);
      let x = box.x + Math.max(0, (box.w - width) / 2);
      for (const entry of entries) {
        pieces.push(`<rect x="${x.toFixed(2)}" y="${(y - swatch).toFixed(2)}"`
          + ` width="${swatch.toFixed(2)}" height="${swatch.toFixed(2)}" rx="2" fill="${entry.fill}"/>`);
        pieces.push(textEl(x + swatch + 5, y, size, ink, 'start', font, entry.name));
        x += swatch + 6 + entry.name.length * size * 0.5 + 12;
      }
      return;
    }
    const x = pos === 'l' ? box.x + 4 : area.x + area.w + 8;
    let y = area.y + size * 1.4;
    for (const entry of entries) {
      pieces.push(`<rect x="${x.toFixed(2)}" y="${(y - swatch).toFixed(2)}"`
        + ` width="${swatch.toFixed(2)}" height="${swatch.toFixed(2)}" rx="2" fill="${entry.fill}"/>`);
      pieces.push(textEl(x + swatch + 5, y, size, ink, 'start', font,
        entry.name.length > 18 ? `${entry.name.slice(0, 17)}…` : entry.name));
      y += size * 1.7;
      if (y > area.y + area.h) break;
    }
  }

  function chartTitle(chartXml) {
    if (X.attr(X.find(chartXml, 'c:autoTitleDeleted'), 'val') === '1') return '';
    const title = X.find(chartXml, 'c:title');
    if (!title) return '';
    return X.findAll(title, 'a:t').map((node) => X.allText(node)).join('').trim();
  }

  function renderChart(chartXml, box, theme, out) {
    const plotArea = X.find(chartXml, 'c:plotArea');
    if (!plotArea) return false;

    let kind = null;
    let plot = null;
    for (const name of CHART_KINDS) {
      const found = X.find(plotArea, `c:${name}`);
      if (found) { kind = name; plot = found; break; }
    }
    if (!plot) return false;

    const seriesList = X.children(plot, 'c:ser').map((ser, i) => readSeries(ser, theme, i));
    if (!seriesList.length || !seriesList.some((s) => s.values.some((v) => v !== null))) return false;
    seriesList.forEach((s, i) => { s.plotFill = seriesColor(s, i, theme); });

    const pie = kind === 'pieChart' || kind === 'doughnutChart';
    if (pie) {
      const first = seriesList[0];
      first.sliceFill = (i) => first.points.get(i)
        || seriesColor(null, i, theme);
    }

    const font = fontStack(theme.fonts.minor);
    const ink = chartInk(chartXml, theme);
    const title = chartTitle(chartXml);
    const hasLegend = Boolean(X.find(chartXml, 'c:legend'));
    const legendPos = X.attr(X.find(chartXml, 'c:legendPos'), 'val', 'r');

    const legendEntries = pie
      ? (seriesList[0].categories || [])
        .map((name, i) => ({ name: String(name ?? ''), fill: seriesList[0].sliceFill(i) }))
        .filter((e) => e.name)
      : seriesList.map((s) => ({ name: s.name, fill: s.plotFill }));
    const showLegend = hasLegend && legendEntries.length > 1;

    const pad = Math.min(box.w, box.h) * 0.06;
    const titleH = title ? Math.max(12, Math.min(22, box.h * 0.1)) : 0;
    const sideways = legendPos === 'r' || legendPos === 'l';
    const legendH = showLegend && !sideways ? Math.max(14, box.h * 0.09) : 0;
    const legendW = showLegend && sideways ? Math.min(box.w * 0.3, 130) : 0;

    const area = {
      x: box.x + pad + (legendPos === 'l' ? legendW : 0),
      y: box.y + pad + titleH + (legendPos === 't' ? legendH : 0),
      w: box.w - pad * 2 - legendW,
      h: box.h - pad * 2 - titleH - legendH,
    };
    if (area.w <= 8 || area.h <= 8) return false;

    const pieces = [];
    if (title) {
      pieces.push(textEl(box.x + box.w / 2, box.y + pad + titleH * 0.78,
        titleH * 0.75, ink, 'middle', font, title, '600'));
    }

    if (pie) drawPie(kind, seriesList[0], area, font, ink, pieces);
    else drawAxes(kind, plot, seriesList, area, font, ink, pieces);

    if (showLegend) drawLegend(legendEntries, box, area, legendPos, legendW, font, ink, pieces);

    out.push(pieces.join(''));
    return true;
  }

  /**
   * Record something this renderer could not draw.
   *
   * A grey box on a slide is a small problem in a living room and a large one in
   * front of a client. Counting them lets the presenter be told plainly, and
   * pointed at the export that renders everything exactly.
   */
  function note(ctx, what) {
    if (ctx && ctx.missing) ctx.missing.push(what);
  }

  function renderChartFrame(node, ctx, box, out) {
    const ref = X.find(node, 'c:chart');
    const id = ref && (X.attr(ref, 'r:id') || X.attr(ref, 'r:embed'));
    const rel = id && ctx.rels.get(id);
    if (!rel || rel.external) return false;

    let chartXml = null;
    try {
      chartXml = partXml(ctx.files, rel.path);
    } catch {
      return false;                      // a malformed chart falls back to the placeholder
    }
    if (!chartXml) return false;

    try {
      return renderChart(chartXml, box, ctx.theme, out);
    } catch {
      return false;
    }
  }

  /*
   * SmartArt, by way of the picture PowerPoint has already drawn.
   *
   * A diagram's own parts describe it as data plus layout rules, so drawing it
   * from those would mean implementing the layout engine. There is no need:
   * PowerPoint also writes a `diagramDrawing` part holding the finished result
   * as ordinary shapes, precisely so that readers which cannot lay it out can
   * still draw it. Find that part and the existing shape renderer does the rest
   * without ever knowing it is looking at SmartArt.
   *
   * The part is a Microsoft extension rather than something the base standard
   * promises, so a file without one still falls through to the placeholder.
   */
  function diagramDrawing(node, ctx) {
    const relIds = X.find(node, 'dgm:relIds');
    if (!relIds) return null;
    const dataRel = ctx.rels.get(X.attr(relIds, 'r:dm'));

    /*
     * Where the drawing is referenced from varies, and guessing one place gets
     * it wrong on most real files. In order of how firmly each says which
     * drawing belongs to this diagram:
     *
     *   1. a dataModelExt inside the relIds element, naming a relationship;
     *   2. a diagramDrawing relationship on the slide, which is where
     *      PowerPoint normally puts it — paired to the data part by number
     *      when a slide carries more than one diagram;
     *   3. a relationship on the data part itself.
     */
    const onSlide = [...ctx.rels.entries()]
      .filter(([, rel]) => rel.type.endsWith('/diagramDrawing') && !rel.external);

    const ext = X.find(relIds, 'dsp:dataModelExt');
    const named = ext && ctx.rels.get(X.attr(ext, 'relId'));

    let drawingRel = named && !named.external ? named : null;

    if (!drawingRel && onSlide.length === 1) [, drawingRel] = onSlide[0];
    if (!drawingRel && onSlide.length > 1 && dataRel) {
      // data1.xml belongs with drawing1.xml.
      const n = (dataRel.path.match(/(\d+)\.xml$/) || [])[1];
      const paired = onSlide.find(([, rel]) => new RegExp(`${n}\\.xml$`).test(rel.path));
      if (paired) [, drawingRel] = paired;
      else [, drawingRel] = onSlide[0];
    }

    if (!drawingRel && dataRel && !dataRel.external) {
      drawingRel = [...relsFor(ctx.files, dataRel.path).values()]
        .find((rel) => rel.type.endsWith('/diagramDrawing') && !rel.external);
    }
    if (!drawingRel) return null;

    const xml = partXml(ctx.files, drawingRel.path);
    const tree = xml && X.find(xml, 'dsp:spTree');
    if (!tree) return null;
    return { tree, rels: relsFor(ctx.files, drawingRel.path) };
  }

  /*
   * The drawing part is DrawingML under a different prefix: dsp:sp holds an
   * a:xfrm and an a:p exactly as p:sp does. Renaming the handful of wrappers is
   * enough to hand it to the renderer that already draws shapes.
   */
  const DSP_TO_PML = new Map([
    ['dsp:spTree', 'p:spTree'], ['dsp:sp', 'p:sp'], ['dsp:spPr', 'p:spPr'],
    ['dsp:txBody', 'p:txBody'], ['dsp:grpSpPr', 'p:grpSpPr'], ['dsp:style', 'p:style'],
    ['dsp:nvSpPr', 'p:nvSpPr'], ['dsp:cNvPr', 'p:cNvPr'], ['dsp:cNvSpPr', 'p:cNvSpPr'],
  ]);

  function asPresentationML(node) {
    return {
      ...node,
      name: DSP_TO_PML.get(node.name) || node.name,
      children: node.children.map(asPresentationML),
    };
  }

  function renderDiagram(node, ctx, box, out) {
    const found = diagramDrawing(node, ctx);
    if (!found) return false;

    const tree = asPresentationML(found.tree);
    if (!X.children(tree, 'p:sp').length) return false;

    /*
     * The drawing has a coordinate space of its own. Mapping it onto the frame
     * is exactly what a group transform does, so say so and reuse that: one
     * group, already in slide coordinates, because `box` has been placed.
     */
    const grp = readTransform(X.child(tree, 'p:grpSpPr'));
    const frameExt = X.child(X.path(node, 'p:xfrm'), 'a:ext');
    const childOff = (grp && (grp.childOff || { x: grp.x, y: grp.y })) || { x: 0, y: 0 };
    const childExt = (grp && (grp.childExt || { w: grp.w, h: grp.h }))
      || { w: emu(X.attr(frameExt, 'cx', 0)), h: emu(X.attr(frameExt, 'cy', 0)) };
    if (!childExt.w || !childExt.h) return false;

    const group = { x: box.x, y: box.y, w: box.w, h: box.h, childOff, childExt };
    renderTree(tree, { ...ctx, rels: found.rels, groups: [group] }, out);
    return true;
  }

  /*
   * The picture an embedded object shows when nobody activates it.
   *
   * PowerPoint caches one so that a reader which cannot run Excel or Visio has
   * something to draw, but it hides it two layers down. The object is wrapped
   * in mc:AlternateContent: the mc:Choice branch is for readers that understand
   * the add-in and carries no picture, and only the mc:Fallback branch holds
   * the p:pic. Reading the first oleObj in document order finds the empty one —
   * which is why 810 previews in the corpus looked absent when they were not.
   */
  function objectPreview(node) {
    const fallback = X.find(node, 'mc:Fallback');
    const pic = X.find(fallback || node, 'p:pic');
    return pic || null;
  }

  function renderObjectPreview(node, ctx, box, out) {
    const pic = objectPreview(node);
    if (!pic) return false;

    /*
     * Draw it where the frame is, not where the picture claims to be: the
     * cached picture carries the offset it had when it was captured, which is
     * not always the frame it now sits in.
     */
    const framed = {
      ...pic,
      children: pic.children.map((child) => (child.name === 'p:spPr' ? {
        ...child,
        children: child.children.filter((c) => c.name !== 'a:xfrm').concat([{
          name: 'a:xfrm',
          attrs: {},
          children: [
            { name: 'a:off', attrs: { x: String(Math.round(box.x * EMU_PER_PX)), y: String(Math.round(box.y * EMU_PER_PX)) }, children: [] },
            { name: 'a:ext', attrs: { cx: String(Math.round(box.w * EMU_PER_PX)), cy: String(Math.round(box.h * EMU_PER_PX)) }, children: [] },
          ],
        }]),
      } : child)),
    };

    const before = out.length;
    const saved = ctx.groups;
    ctx.groups = [];                 // box is already in slide coordinates
    renderPicture(framed, ctx, out);
    ctx.groups = saved;

    /*
     * A metafile preview draws nothing yet, but renderPicture has already said
     * so. Report it as handled: letting the caller fall through would label it
     * an embedded object as well and count the same hole twice.
     */
    if (out.length > before) return true;
    return metafilePreview(pic, ctx) ? 'noted' : false;
  }

  /** Whether the cached picture is a metafile, which nothing here can draw yet. */
  function metafilePreview(pic, ctx) {
    const blip = X.path(pic, 'p:blipFill', 'a:blip');
    const rel = blip && ctx.rels.get(X.attr(blip, 'r:embed') || X.attr(blip, 'r:link'));
    if (!rel || rel.external) return false;
    const mime = IMAGE_MIME[rel.path.split('.').pop().toLowerCase()];
    return mime === 'image/emf' || mime === 'image/wmf';
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

    const uri = X.attr(X.find(node, 'a:graphicData'), 'uri', '');
    if (uri.includes('chart') && renderChartFrame(node, ctx, box, out)) return;
    if (uri.includes('diagram') && renderDiagram(node, ctx, box, out)) return;

    /*
     * Add-ins park their bookkeeping on the slide as an embedded object a fifth
     * of an inch square, invisible to anyone looking at the deck. Measured over
     * a corpus of real decks, 92% of all embedded objects are these markers,
     * and drawing a labelled box for each one spoils every slide it touches
     * while telling the presenter about something they cannot see. Nothing this
     * small is content, so say nothing and draw nothing.
     */
    if (box.w < MIN_VISIBLE || box.h < MIN_VISIBLE) return;

    // A real object may still carry the picture PowerPoint showed in its place.
    const preview = renderObjectPreview(node, ctx, box, out);
    if (preview === true) return;

    // Otherwise leave a labelled space so the slide reads the way it was laid
    // out rather than showing a blank gap. A metafile preview has already been
    // reported by name, so only say something when nothing else has.
    const label = uri.includes('chart') ? 'Chart' : uri.includes('diagram') ? 'Diagram' : 'Embedded object';
    if (preview !== 'noted') {
      note(ctx, uri.includes('diagram') ? 'SmartArt' : uri.includes('chart') ? 'a chart' : 'an embedded object');
    }
    out.push(`<rect x="${box.x.toFixed(2)}" y="${box.y.toFixed(2)}" width="${box.w.toFixed(2)}"`
      + ` height="${box.h.toFixed(2)}" fill="#f2f4f8" stroke="#c9ccd4" stroke-width="1"`
      + ' stroke-dasharray="6 5"/>');
    out.push(`<text x="${(box.x + box.w / 2).toFixed(2)}" y="${(box.y + box.h / 2).toFixed(2)}"`
      + ` text-anchor="middle" font-family="${esc(fontStack(''))}" font-size="16" fill="#8d97a8">`
      + `${esc(label)}</text>`);
  }

  /*
   * Template furniture the designer switched off.
   *
   * A master or layout usually carries a set of guides the house style keeps to
   * hand — an on-page tracker, a legend, a unit-of-measure caption — parked on
   * the slide and marked hidden. PowerPoint does not draw them, and drawing
   * them puts "Legend" and "Unit of measure" across the top of every slide in
   * the deck. The flag sits on the cNvPr inside whichever non-visual properties
   * element the shape happens to use, so find it by shape rather than by name.
   */
  function isHidden(node) {
    for (const child of node.children) {
      if (!child.name.startsWith('p:nv')) continue;
      const cNvPr = X.child(child, 'p:cNvPr');
      if (cNvPr && X.attr(cNvPr, 'hidden') === '1') return true;
    }
    return false;
  }

  function renderTree(tree, ctx, out) {
    for (const node of tree.children) {
      if (isHidden(node)) continue;
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
      const missing = [];

      // own shapes. Placeholders are skipped: unfilled ones carry prompt text.
      for (const [xml, rels] of [[masterXml, masterRels], [layoutXml, layoutRels]]) {
        const tree = xml && X.find(xml, 'p:spTree');
        if (!tree) continue;
        const decorative = {
          ...tree,
          children: tree.children.filter((n) => !X.path(n, 'p:nvSpPr', 'p:nvPr', 'p:ph')
            && !X.path(n, 'p:nvPicPr', 'p:nvPr', 'p:ph')),
        };
        renderTree(decorative, { files, rels, theme, measure, defaults, groups: [], missing }, body);
      }

      const spTree = X.find(slideXml, 'p:spTree');
      if (spTree) {
        renderTree(spTree, { files, rels: slideRels, theme, measure, defaults, groups: [], missing }, body);
      }

      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`
        + ` width="${width.toFixed(0)}" height="${height.toFixed(0)}"`
        + ` viewBox="0 0 ${width.toFixed(2)} ${height.toFixed(2)}">${body.join('')}</svg>`;

      slides.push({ index: slides.length, title: slideTitle(slideXml), svg, missing });
    }

    if (!slides.length) throw new Error('That presentation has no slides.');

    /*
     * What could not be drawn, summarised. PowerPoint's own export renders all
     * of it, so the honest thing is to say so rather than let a grey box be
     * discovered on the night.
     */
    const incomplete = slides.filter((slide) => slide.missing.length);
    const kinds = [...new Set(incomplete.flatMap((slide) => slide.missing))];

    /*
     * The same summary broken down, because "which kinds are missing" does not
     * say whether the hole is one expensive feature or four cheap ones. Deciding
     * what to build next needs the count, and the count of slides spoilt by it —
     * ten metafiles on one slide cost one slide, not ten.
     */
    const counts = {};
    for (const slide of slides) {
      const seenHere = new Set();
      for (const kind of slide.missing) {
        const entry = counts[kind] || (counts[kind] = { occurrences: 0, slides: 0 });
        entry.occurrences += 1;
        if (!seenHere.has(kind)) {
          entry.slides += 1;
          seenHere.add(kind);
        }
      }
    }

    return { width, height, slides, incomplete: incomplete.length, kinds, counts };
  }

  return { render, approximateMeasure, fontStack };
});
