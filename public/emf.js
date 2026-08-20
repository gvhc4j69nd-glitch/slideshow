/**
 * Enhanced Metafile (EMF) to SVG.
 *
 * EMF is what PowerPoint leaves behind whenever something was pasted from
 * another Windows program: the cached picture of an embedded chart, a Visio
 * drawing, an add-in's output. No browser draws it, so those pictures are holes
 * in a deck that otherwise renders. Across a corpus of real decks they are the
 * single largest remaining cause.
 *
 * The format is a header followed by variable-length records, each a drawing
 * command against a device context — a state machine with pens, brushes, fonts,
 * a current position, a transform stack and a path under construction. This
 * plays those records back and writes SVG.
 *
 * It implements what real files actually contain, measured rather than guessed:
 * the thirty-odd record types that appear across the corpus. Bitmap blits are
 * absent from it entirely and are not implemented. Anything unrecognised is
 * skipped by its own length, which is why an unknown record costs a missing
 * detail rather than a failed render.
 *
 * Written from the published MS-EMF specification.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Emf = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── Record types ─────────────────────────────────────────────────────────
   * Only the ones this draws; everything else falls through to "skip".
   */
  const R = {
    HEADER: 1, POLYBEZIER: 2, POLYGON: 3, POLYLINE: 4, POLYBEZIERTO: 5,
    POLYLINETO: 6, POLYPOLYLINE: 7, POLYPOLYGON: 8,
    SETWINDOWEXTEX: 9, SETWINDOWORGEX: 10, SETVIEWPORTEXTEX: 11, SETVIEWPORTORGEX: 12,
    EOF: 14, SETMAPMODE: 17, SETBKMODE: 18, SETPOLYFILLMODE: 19, SETROP2: 20,
    SETTEXTALIGN: 22, SETTEXTCOLOR: 24, SETBKCOLOR: 25, MOVETOEX: 27,
    SETMETARGN: 28, EXCLUDECLIPRECT: 29, INTERSECTCLIPRECT: 30,
    SAVEDC: 33, RESTOREDC: 34, SETWORLDTRANSFORM: 35, MODIFYWORLDTRANSFORM: 36,
    SELECTOBJECT: 37, CREATEPEN: 38, CREATEBRUSHINDIRECT: 39, DELETEOBJECT: 40,
    ELLIPSE: 42, RECTANGLE: 43, ROUNDRECT: 44, LINETO: 54,
    BEGINPATH: 59, ENDPATH: 60, CLOSEFIGURE: 61, FILLPATH: 62,
    STROKEANDFILLPATH: 63, STROKEPATH: 64, SELECTCLIPPATH: 67, ABORTPATH: 68,
    EXTSELECTCLIPRGN: 75, EXTCREATEFONTINDIRECTW: 82,
    EXTTEXTOUTA: 83, EXTTEXTOUTW: 84,
    POLYBEZIER16: 85, POLYGON16: 86, POLYLINE16: 87, POLYBEZIERTO16: 88,
    POLYLINETO16: 89, POLYPOLYLINE16: 90, POLYPOLYGON16: 91,
    EXTCREATEPEN: 95,
  };

  /* Stock objects, selected by handle with the high bit set. */
  const STOCK = 0x80000000;
  const STOCK_WHITE_BRUSH = 0, STOCK_LTGRAY_BRUSH = 1, STOCK_GRAY_BRUSH = 2,
    STOCK_DKGRAY_BRUSH = 3, STOCK_BLACK_BRUSH = 4, STOCK_NULL_BRUSH = 5,
    STOCK_WHITE_PEN = 6, STOCK_BLACK_PEN = 7, STOCK_NULL_PEN = 8;

  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const n2 = (v) => (Math.round(v * 100) / 100);

  /* ── Reading ──────────────────────────────────────────────────────────── */

  function reader(view) {
    return {
      u32: (o) => view.getUint32(o, true),
      i32: (o) => view.getInt32(o, true),
      u16: (o) => view.getUint16(o, true),
      i16: (o) => view.getInt16(o, true),
      u8: (o) => view.getUint8(o),
      f32: (o) => view.getFloat32(o, true),
    };
  }

  /** COLORREF is 0x00BBGGRR. */
  function colorAt(r, o) {
    const v = r.u32(o);
    const red = v & 0xff, green = (v >> 8) & 0xff, blue = (v >> 16) & 0xff;
    return `#${((1 << 24) + (red << 16) + (green << 8) + blue).toString(16).slice(1)}`;
  }

  function utf16At(view, off, chars) {
    let s = '';
    for (let i = 0; i < chars; i += 1) {
      const c = view.getUint16(off + i * 2, true);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  /* ── Transforms ───────────────────────────────────────────────────────────
   * EMF's XFORM is [eM11 eM12 eM21 eM22 eDx eDy], the same order SVG uses.
   */
  const IDENTITY = [1, 0, 0, 1, 0, 0];

  function multiply(a, b) {
    return [
      a[0] * b[0] + a[2] * b[1],
      a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3],
      a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4],
      a[1] * b[4] + a[3] * b[5] + a[5],
    ];
  }

  const apply = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

  /* ── Device context ───────────────────────────────────────────────────── */

  function freshDc() {
    return {
      world: IDENTITY.slice(),
      winOrg: { x: 0, y: 0 }, winExt: null,
      viewOrg: { x: 0, y: 0 }, viewExt: null,
      pen: { color: '#000000', width: 1, style: 0 },
      brush: { color: '#ffffff', style: 0 },
      font: { size: 12, family: '', bold: false, italic: false, underline: false, escapement: 0 },
      textColor: '#000000',
      bkColor: '#ffffff',
      bkMode: 1,
      polyFill: 1,             // 1 ALTERNATE, 2 WINDING
      textAlign: 0,
      pos: { x: 0, y: 0 },
      clip: null,
    };
  }

  const cloneDc = (d) => ({
    ...d,
    world: d.world.slice(),
    winOrg: { ...d.winOrg }, winExt: d.winExt && { ...d.winExt },
    viewOrg: { ...d.viewOrg }, viewExt: d.viewExt && { ...d.viewExt },
    pen: { ...d.pen }, brush: { ...d.brush }, font: { ...d.font }, pos: { ...d.pos },
  });

  /* ── The renderer ─────────────────────────────────────────────────────── */

  /**
   * Render EMF bytes to an SVG string, or return null if the bytes are not EMF.
   *
   * `width` and `height` are the box the picture has to fill, in the caller's
   * units; the metafile's own bounds become the viewBox, so it scales to fit.
   */
  function render(buffer, options = {}) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.length < 88) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const r = reader(view);
    if (r.u32(0) !== R.HEADER) return null;

    // rclBounds: inclusive device-unit rectangle the picture occupies.
    const left = r.i32(8), top = r.i32(12), right = r.i32(16), bottom = r.i32(20);
    let vbW = right - left + 1;
    let vbH = bottom - top + 1;
    if (!(vbW > 0) || !(vbH > 0)) { vbW = 1; vbH = 1; }

    const out = [];
    const objects = new Map();
    const stack = [];
    let dc = freshDc();
    let path = null;             // array of subpath strings while BEGINPATH is open
    let clipId = 0;
    const defs = [];

    /* Logical point to device point: world transform, then window/viewport. */
    function map(x, y) {
      const p = apply(dc.world, x, y);
      let dx = p.x, dy = p.y;
      if (dc.winExt && dc.viewExt && dc.winExt.x && dc.winExt.y) {
        dx = (dx - dc.winOrg.x) * (dc.viewExt.x / dc.winExt.x) + dc.viewOrg.x;
        dy = (dy - dc.winOrg.y) * (dc.viewExt.y / dc.winExt.y) + dc.viewOrg.y;
      }
      return { x: dx, y: dy };
    }

    const strokeAttrs = () => {
      if (dc.pen.style === 5) return 'stroke="none"';        // PS_NULL
      const scale = Math.sqrt(Math.abs(dc.world[0] * dc.world[3] - dc.world[1] * dc.world[2])) || 1;
      const w = Math.max(0.35, (dc.pen.width || 1) * scale);
      const dash = dc.pen.style === 1 ? ` stroke-dasharray="${n2(w * 4)} ${n2(w * 3)}"`
        : dc.pen.style === 2 ? ` stroke-dasharray="${n2(w)} ${n2(w * 2)}"`
          : dc.pen.style === 3 ? ` stroke-dasharray="${n2(w * 4)} ${n2(w * 2)} ${n2(w)} ${n2(w * 2)}"` : '';
      return `stroke="${dc.pen.color}" stroke-width="${n2(w)}"${dash}`;
    };

    const fillAttr = () => (dc.brush.style === 1 ? 'fill="none"' : `fill="${dc.brush.color}"`);
    const fillRule = () => (dc.polyFill === 2 ? ' fill-rule="nonzero"' : ' fill-rule="evenodd"');
    const clipAttr = () => (dc.clip ? ` clip-path="url(#${dc.clip})"` : '');

    function emit(el) { out.push(el); }

    /** Points, either 32-bit or 16-bit, starting at `off`. */
    function points(off, count, small) {
      const pts = [];
      for (let i = 0; i < count; i += 1) {
        const x = small ? r.i16(off + i * 4) : r.i32(off + i * 8);
        const y = small ? r.i16(off + i * 4 + 2) : r.i32(off + i * 8 + 4);
        pts.push(map(x, y));
      }
      return pts;
    }

    const d = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${n2(p.x)} ${n2(p.y)}`).join(' ');

    /** Either add to the open path, or draw immediately. */
    function figure(data, close, mode) {
      if (path) { path.push(data + (close ? ' Z' : '')); return; }
      const geom = data + (close ? ' Z' : '');
      if (mode === 'fill') emit(`<path d="${geom}" ${fillAttr()}${fillRule()} stroke="none"${clipAttr()}/>`);
      else if (mode === 'both') emit(`<path d="${geom}" ${fillAttr()}${fillRule()} ${strokeAttrs()}${clipAttr()}/>`);
      else emit(`<path d="${geom}" fill="none" ${strokeAttrs()}${clipAttr()}/>`);
    }

    function selectStock(handle) {
      const which = handle & 0x7fffffff;
      if (which === STOCK_NULL_BRUSH) dc.brush = { color: 'none', style: 1 };
      else if (which === STOCK_WHITE_BRUSH) dc.brush = { color: '#ffffff', style: 0 };
      else if (which === STOCK_BLACK_BRUSH) dc.brush = { color: '#000000', style: 0 };
      else if (which === STOCK_LTGRAY_BRUSH) dc.brush = { color: '#c0c0c0', style: 0 };
      else if (which === STOCK_GRAY_BRUSH) dc.brush = { color: '#808080', style: 0 };
      else if (which === STOCK_DKGRAY_BRUSH) dc.brush = { color: '#404040', style: 0 };
      else if (which === STOCK_NULL_PEN) dc.pen = { ...dc.pen, style: 5 };
      else if (which === STOCK_WHITE_PEN) dc.pen = { color: '#ffffff', width: 1, style: 0 };
      else if (which === STOCK_BLACK_PEN) dc.pen = { color: '#000000', width: 1, style: 0 };
    }

    function text(off, size, wide) {
      const gm = r.u32(off + 24);                      // iGraphicsMode
      const emrOff = off + 36;
      const ref = { x: r.i32(emrOff), y: r.i32(emrOff + 4) };
      const chars = r.u32(emrOff + 8);
      const strOff = r.u32(emrOff + 12);
      if (!chars || !strOff || off + strOff + 2 > off + size) return;

      let s = '';
      if (wide) s = utf16At(view, off + strOff, chars);
      else {
        for (let i = 0; i < chars; i += 1) {
          const c = r.u8(off + strOff + i);
          if (!c) break;
          s += String.fromCharCode(c);
        }
      }
      if (!s.trim()) return;

      const p = map(ref.x, ref.y);
      const f = dc.font;
      const scale = Math.sqrt(Math.abs(dc.world[0] * dc.world[3] - dc.world[1] * dc.world[2])) || 1;
      const size2 = Math.max(1, Math.abs(f.size) * scale);

      // TA_CENTER is 6, TA_RIGHT 2 in the low bits; TA_BASELINE is 24.
      const halign = (dc.textAlign & 6) === 6 ? 'middle' : (dc.textAlign & 2) ? 'end' : 'start';
      const baseline = (dc.textAlign & 24) === 24 ? '' : ' dominant-baseline="text-before-edge"';

      const rot = f.escapement ? ` transform="rotate(${n2(-f.escapement / 10)} ${n2(p.x)} ${n2(p.y)})"` : '';
      emit(`<text x="${n2(p.x)}" y="${n2(p.y)}" fill="${dc.textColor}"`
        + ` font-family="${esc(f.family || 'sans-serif')}" font-size="${n2(size2)}"`
        + (f.bold ? ' font-weight="bold"' : '')
        + (f.italic ? ' font-style="italic"' : '')
        + (f.underline ? ' text-decoration="underline"' : '')
        + ` text-anchor="${halign}"${baseline}${rot}${clipAttr()}>${esc(s)}</text>`);
    }

    /* ── Record loop ────────────────────────────────────────────────────── */

    let off = 0;
    let guard = 0;
    while (off + 8 <= bytes.length && guard < 200000) {
      guard += 1;
      const type = r.u32(off);
      const size = r.u32(off + 4);
      if (size < 8 || off + size > bytes.length) break;

      switch (type) {
        case R.EOF: off = bytes.length; continue;

        /* State */
        case R.SAVEDC: stack.push(cloneDc(dc)); break;
        case R.RESTOREDC: { const prev = stack.pop(); if (prev) dc = prev; break; }
        case R.SETWORLDTRANSFORM:
          dc.world = [r.f32(off + 8), r.f32(off + 12), r.f32(off + 16),
            r.f32(off + 20), r.f32(off + 24), r.f32(off + 28)];
          break;
        case R.MODIFYWORLDTRANSFORM: {
          const m = [r.f32(off + 8), r.f32(off + 12), r.f32(off + 16),
            r.f32(off + 20), r.f32(off + 24), r.f32(off + 28)];
          /* MWT_IDENTITY 1, MWT_LEFTMULTIPLY 2, MWT_RIGHTMULTIPLY 3, MWT_SET 4. */
          const mode = r.u32(off + 32);
          if (mode === 1) dc.world = IDENTITY.slice();
          else if (mode === 2) dc.world = multiply(m, dc.world);
          else if (mode === 3) dc.world = multiply(dc.world, m);
          else if (mode === 4) dc.world = m.slice();
          break;
        }
        case R.SETWINDOWORGEX: dc.winOrg = { x: r.i32(off + 8), y: r.i32(off + 12) }; break;
        case R.SETWINDOWEXTEX: dc.winExt = { x: r.i32(off + 8), y: r.i32(off + 12) }; break;
        case R.SETVIEWPORTORGEX: dc.viewOrg = { x: r.i32(off + 8), y: r.i32(off + 12) }; break;
        case R.SETVIEWPORTEXTEX: dc.viewExt = { x: r.i32(off + 8), y: r.i32(off + 12) }; break;
        case R.SETTEXTCOLOR: dc.textColor = colorAt(r, off + 8); break;
        case R.SETBKCOLOR: dc.bkColor = colorAt(r, off + 8); break;
        case R.SETBKMODE: dc.bkMode = r.u32(off + 8); break;
        case R.SETPOLYFILLMODE: dc.polyFill = r.u32(off + 8); break;
        case R.SETTEXTALIGN: dc.textAlign = r.u32(off + 8); break;
        case R.MOVETOEX: dc.pos = { x: r.i32(off + 8), y: r.i32(off + 12) }; break;

        /* Clipping — rectangles only; regions fall back to no clip. */
        case R.INTERSECTCLIPRECT: {
          const a = map(r.i32(off + 8), r.i32(off + 12));
          const b = map(r.i32(off + 16), r.i32(off + 20));
          const id = `emfc${clipId += 1}`;
          defs.push(`<clipPath id="${id}"><rect x="${n2(Math.min(a.x, b.x))}" y="${n2(Math.min(a.y, b.y))}"`
            + ` width="${n2(Math.abs(b.x - a.x))}" height="${n2(Math.abs(b.y - a.y))}"/></clipPath>`);
          dc.clip = id;
          break;
        }
        /*
         * A clipping region, carried as a list of rectangles. Ignoring it is
         * not harmless: a background fill drawn through a region it should have
         * been trimmed to paints straight over the picture, which is worse than
         * leaving it out. The union of the rectangles is a faithful clip,
         * because that is exactly what a region is.
         */
        case R.EXTSELECTCLIPRGN: {
          const rgnBytes = r.u32(off + 8);
          if (!rgnBytes) { dc.clip = null; break; }              // no region: clip cleared
          const count = r.u32(off + 24);
          if (!count || count > 20000) break;
          const first = off + 48;
          if (first + count * 16 > off + size) break;
          const rects = [];
          for (let i = 0; i < count; i += 1) {
            const q = first + i * 16;
            const a = map(r.i32(q), r.i32(q + 4));
            const b = map(r.i32(q + 8), r.i32(q + 12));
            rects.push(`<rect x="${n2(Math.min(a.x, b.x))}" y="${n2(Math.min(a.y, b.y))}"`
              + ` width="${n2(Math.abs(b.x - a.x))}" height="${n2(Math.abs(b.y - a.y))}"/>`);
          }
          const id = `emfc${clipId += 1}`;
          defs.push(`<clipPath id="${id}">${rects.join('')}</clipPath>`);
          dc.clip = id;
          break;
        }

        /* Objects */
        case R.CREATEPEN: {
          const h = r.u32(off + 8);
          objects.set(h, {
            kind: 'pen',
            style: r.u32(off + 12) & 0xff,
            width: r.i32(off + 16),
            color: colorAt(r, off + 24),
          });
          break;
        }
        case R.EXTCREATEPEN: {
          const h = r.u32(off + 8);
          objects.set(h, {
            kind: 'pen',
            style: r.u32(off + 28) & 0xff,
            width: r.i32(off + 32),
            color: colorAt(r, off + 40),
          });
          break;
        }
        case R.CREATEBRUSHINDIRECT: {
          const h = r.u32(off + 8);
          const style = r.u32(off + 12);
          objects.set(h, { kind: 'brush', style, color: colorAt(r, off + 16) });
          break;
        }
        case R.EXTCREATEFONTINDIRECTW: {
          const h = r.u32(off + 8);
          const lf = off + 12;
          objects.set(h, {
            kind: 'font',
            size: Math.abs(r.i32(lf)),
            escapement: r.i32(lf + 8),
            bold: r.i32(lf + 16) >= 600,
            italic: r.u8(lf + 20) !== 0,
            underline: r.u8(lf + 21) !== 0,
            family: utf16At(view, lf + 28, 32),
          });
          break;
        }
        case R.SELECTOBJECT: {
          const h = r.u32(off + 8);
          if (h & STOCK) { selectStock(h); break; }
          const o = objects.get(h);
          if (!o) break;
          if (o.kind === 'pen') dc.pen = { color: o.color, width: o.width, style: o.style };
          else if (o.kind === 'brush') dc.brush = { color: o.color, style: o.style };
          else if (o.kind === 'font') dc.font = { ...o };
          break;
        }
        case R.DELETEOBJECT: objects.delete(r.u32(off + 8)); break;

        /* Paths */
        case R.BEGINPATH: path = []; break;
        case R.ENDPATH: break;
        case R.ABORTPATH: path = null; break;
        case R.CLOSEFIGURE: if (path && path.length) path[path.length - 1] += ' Z'; break;
        case R.FILLPATH:
        case R.STROKEPATH:
        case R.STROKEANDFILLPATH: {
          if (path && path.length) {
            const geom = path.join(' ');
            if (type === R.FILLPATH) emit(`<path d="${geom}" ${fillAttr()}${fillRule()} stroke="none"${clipAttr()}/>`);
            else if (type === R.STROKEPATH) emit(`<path d="${geom}" fill="none" ${strokeAttrs()}${clipAttr()}/>`);
            else emit(`<path d="${geom}" ${fillAttr()}${fillRule()} ${strokeAttrs()}${clipAttr()}/>`);
          }
          path = null;
          break;
        }
        case R.SELECTCLIPPATH: path = null; break;

        /* Lines and curves */
        case R.LINETO: {
          const a = map(dc.pos.x, dc.pos.y);
          const bx = r.i32(off + 8), by = r.i32(off + 12);
          const b = map(bx, by);
          figure(`M${n2(a.x)} ${n2(a.y)} L${n2(b.x)} ${n2(b.y)}`, false, 'stroke');
          dc.pos = { x: bx, y: by };
          break;
        }
        case R.POLYLINE: case R.POLYLINE16:
        case R.POLYGON: case R.POLYGON16: {
          const small = type === R.POLYLINE16 || type === R.POLYGON16;
          const count = r.u32(off + 24);
          if (!count || count > 100000) break;
          const pts = points(off + 28, count, small);
          const closed = type === R.POLYGON || type === R.POLYGON16;
          figure(d(pts), closed, closed ? 'both' : 'stroke');
          break;
        }
        case R.POLYLINETO: case R.POLYLINETO16: {
          const small = type === R.POLYLINETO16;
          const count = r.u32(off + 24);
          if (!count || count > 100000) break;
          const pts = points(off + 28, count, small);
          const start = map(dc.pos.x, dc.pos.y);
          figure(`M${n2(start.x)} ${n2(start.y)} ` + pts.map((p) => `L${n2(p.x)} ${n2(p.y)}`).join(' '),
            false, 'stroke');
          const lastX = small ? r.i16(off + 28 + (count - 1) * 4) : r.i32(off + 28 + (count - 1) * 8);
          const lastY = small ? r.i16(off + 28 + (count - 1) * 4 + 2) : r.i32(off + 28 + (count - 1) * 8 + 4);
          dc.pos = { x: lastX, y: lastY };
          break;
        }
        case R.POLYBEZIER: case R.POLYBEZIER16:
        case R.POLYBEZIERTO: case R.POLYBEZIERTO16: {
          const small = type === R.POLYBEZIER16 || type === R.POLYBEZIERTO16;
          const to = type === R.POLYBEZIERTO || type === R.POLYBEZIERTO16;
          const count = r.u32(off + 24);
          if (!count || count > 100000) break;
          const pts = points(off + 28, count, small);
          let data;
          let i = 0;
          if (to) {
            const s = map(dc.pos.x, dc.pos.y);
            data = `M${n2(s.x)} ${n2(s.y)}`;
          } else {
            data = `M${n2(pts[0].x)} ${n2(pts[0].y)}`;
            i = 1;
          }
          for (; i + 2 < pts.length + 1 && i + 2 <= pts.length; i += 3) {
            data += ` C${n2(pts[i].x)} ${n2(pts[i].y)} ${n2(pts[i + 1].x)} ${n2(pts[i + 1].y)}`
              + ` ${n2(pts[i + 2].x)} ${n2(pts[i + 2].y)}`;
          }
          figure(data, false, 'stroke');
          const lastIdx = count - 1;
          const lx = small ? r.i16(off + 28 + lastIdx * 4) : r.i32(off + 28 + lastIdx * 8);
          const ly = small ? r.i16(off + 28 + lastIdx * 4 + 2) : r.i32(off + 28 + lastIdx * 8 + 4);
          dc.pos = { x: lx, y: ly };
          break;
        }
        case R.POLYPOLYGON: case R.POLYPOLYGON16:
        case R.POLYPOLYLINE: case R.POLYPOLYLINE16: {
          const small = type === R.POLYPOLYGON16 || type === R.POLYPOLYLINE16;
          const polys = r.u32(off + 24);
          const total = r.u32(off + 28);
          if (!polys || polys > 10000 || !total || total > 200000) break;
          const counts = [];
          for (let i = 0; i < polys; i += 1) counts.push(r.u32(off + 32 + i * 4));
          let p = off + 32 + polys * 4;
          const closed = type === R.POLYPOLYGON || type === R.POLYPOLYGON16;
          const parts = [];
          for (const c of counts) {
            if (!c || c > total) break;
            parts.push(d(points(p, c, small)) + (closed ? ' Z' : ''));
            p += c * (small ? 4 : 8);
          }
          if (!parts.length) break;
          const geom = parts.join(' ');
          if (path) path.push(geom);
          else if (closed) emit(`<path d="${geom}" ${fillAttr()}${fillRule()} ${strokeAttrs()}${clipAttr()}/>`);
          else emit(`<path d="${geom}" fill="none" ${strokeAttrs()}${clipAttr()}/>`);
          break;
        }

        /* Closed shapes */
        case R.RECTANGLE: case R.ELLIPSE: case R.ROUNDRECT: {
          const a = map(r.i32(off + 8), r.i32(off + 12));
          const b = map(r.i32(off + 16), r.i32(off + 20));
          const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
          const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
          if (type === R.ELLIPSE) {
            emit(`<ellipse cx="${n2(x + w / 2)}" cy="${n2(y + h / 2)}" rx="${n2(w / 2)}" ry="${n2(h / 2)}"`
              + ` ${fillAttr()} ${strokeAttrs()}${clipAttr()}/>`);
          } else {
            const rr = type === R.ROUNDRECT
              ? ` rx="${n2(Math.abs(map(r.i32(off + 24), 0).x - map(0, 0).x) / 2)}"` : '';
            emit(`<rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}"${rr}`
              + ` ${fillAttr()} ${strokeAttrs()}${clipAttr()}/>`);
          }
          break;
        }

        /* Text */
        case R.EXTTEXTOUTW: text(off, size, true); break;
        case R.EXTTEXTOUTA: text(off, size, false); break;

        default: break;      // unknown records cost a detail, not the render
      }

      off += size;
    }

    const w = options.width || vbW;
    const h = options.height || vbH;
    const body = (defs.length ? `<defs>${defs.join('')}</defs>` : '') + out.join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${n2(w)}" height="${n2(h)}"`
      + ` viewBox="${left} ${top} ${vbW} ${vbH}" preserveAspectRatio="xMidYMid meet">${body}</svg>`;
  }

  /** Cheap check: does this look like an EMF at all? */
  function isEmf(buffer) {
    const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (b.length < 44) return false;
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    // EMR_HEADER, and the signature " EMF" at offset 40.
    return v.getUint32(0, true) === R.HEADER && v.getUint32(40, true) === 0x464d4520;
  }

  return { render, isEmf };
});
