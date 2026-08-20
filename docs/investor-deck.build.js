'use strict';
/* Vinboo investor deck. Palette sampled from the product's own brand tokens. */

const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';           // 13.3 x 7.5 — must precede any addSlide
pres.author = 'Vinboo';
pres.title = 'Vinboo — Investor Overview';

const C = {
  coral: 'FF8382', cyan: '51D1E3', amber: 'FDCA5C',
  coralInk: 'C8362F', cyanInk: '1F7884', amberInk: '936A10',
  coralSoft: 'FFEDEC', cyanSoft: 'E4F8FB', amberSoft: 'FFF4DE',
  ink: '2A2440', inkSoft: '6B6480',
  stage: '12101C', stageBar: '1C1830', stageText: 'F4F0FA', stageMuted: 'A79FC0',
  paper: 'FFFAF5', white: 'FFFFFF', line: 'E6E1DC',
};
const F = { head: 'Calibri', body: 'Calibri' };

const W = 13.3, H = 7.5, M = 0.62;

/* ── helpers ──────────────────────────────────────────────────────────────── */

function darkSlide() {
  const s = pres.addSlide();
  s.background = { color: C.stage };
  return s;
}
function lightSlide() {
  const s = pres.addSlide();
  s.background = { color: C.paper };
  return s;
}

/** Title + optional standfirst. Returns the y where content may start. */
function heading(s, title, standfirst, dark) {
  s.addText(title, {
    x: M, y: 0.42, w: W - M * 2, h: 0.72,
    fontFace: F.head, fontSize: 34, bold: true,
    color: dark ? C.stageText : C.ink, margin: 0, valign: 'top',
  });
  if (!standfirst) return 1.28;
  s.addText(standfirst, {
    x: M, y: 1.16, w: W - M * 2, h: 0.42,
    fontFace: F.body, fontSize: 15,
    color: dark ? C.stageMuted : C.inkSoft, margin: 0, valign: 'top',
  });
  return 1.78;
}

/** A tinted rounded card. */
function card(s, o) {
  s.addShape(pres.ShapeType.roundRect, {
    x: o.x, y: o.y, w: o.w, h: o.h,
    fill: { color: o.fill || C.white },
    line: { color: o.stroke || C.line, width: 1 },
    rectRadius: 0.12,
    shadow: { type: 'outer', angle: 90, blur: 10, offset: 2, color: '2A2440', opacity: 0.06 },
  });
}

/** Small filled circle with a number or glyph. */
function badge(s, x, y, text, fill, textColor) {
  s.addShape(pres.ShapeType.ellipse, {
    x, y, w: 0.42, h: 0.42, fill: { color: fill }, line: { color: fill, width: 0 },
  });
  s.addText(text, {
    x, y, w: 0.42, h: 0.42, align: 'center', valign: 'middle',
    fontFace: F.head, fontSize: 15, bold: true, color: textColor || C.white, margin: 0,
  });
}

/** Big number + label. */
function stat(s, o) {
  s.addText(o.value, {
    x: o.x, y: o.y, w: o.w, h: 0.78,
    fontFace: F.head, fontSize: o.size || 40, bold: true,
    color: o.color || C.coralInk, margin: 0, align: o.align || 'left', valign: 'bottom',
  });
  s.addText(o.label, {
    x: o.x, y: o.y + 0.86, w: o.w, h: o.lh || 0.72,
    fontFace: F.body, fontSize: 12.5, color: o.labelColor || C.inkSoft,
    margin: 0, align: o.align || 'left', valign: 'top',
  });
}

/** Bulleted body text inside a card. */
function bullets(s, items, o) {
  s.addText(items.map((t, i) => ({
    text: t, options: { bullet: true, breakLine: i !== items.length - 1 },
  })), {
    x: o.x, y: o.y, w: o.w, h: o.h,
    fontFace: F.body, fontSize: o.size || 13, color: o.color || C.ink,
    margin: 0, valign: 'top', paraSpaceAfter: o.gap === undefined ? 7 : o.gap,
  });
}

const IMG = __dirname + '/';

/* ── 1. Title ─────────────────────────────────────────────────────────────── */
{
  const s = darkSlide();
  s.addImage({ path: IMG + 'logo.png', x: M, y: 1.55, w: 4.3, h: 1.42 });
  s.addText('One slideshow, on every screen in the room —\nstreamed from your own device, stored nowhere.', {
    x: M, y: 3.25, w: 8.6, h: 1.5,
    fontFace: F.head, fontSize: 26, bold: true, color: C.stageText,
    margin: 0, lineSpacingMultiple: 1.16, valign: 'top',
  });
  s.addText('Investor overview  ·  August 2026  ·  vinboo.com', {
    x: M, y: 5.05, w: 8.6, h: 0.4,
    fontFace: F.body, fontSize: 14, color: C.stageMuted, margin: 0,
  });
  // Three brand dots as the recurring motif.
  [C.coral, C.cyan, C.amber].forEach((col, i) => {
    s.addShape(pres.ShapeType.ellipse, {
      x: M + i * 0.42, y: 5.75, w: 0.24, h: 0.24,
      fill: { color: col }, line: { color: col, width: 0 },
    });
  });
  s.addNotes('Vinboo is a working, deployed product built with no outside capital. This deck covers what it is, what is already built, the market it points at, and what the next phase of engineering buys.');
}

/* ── 2. The problem ───────────────────────────────────────────────────────── */
{
  const s = lightSlide();
  const y0 = heading(s, 'Showing a deck in someone else’s room is still bad',
    'A sales representative walks into a client’s conference room. Three things can happen, and all of them are poor.');

  const items = [
    { t: 'They hand over the file', d: 'Emailed ahead or left on a USB stick. It now lives on the client’s machine and can be forwarded to a competitor. The presenter has no way to take it back.', fill: C.coralSoft, ink: C.coralInk, n: '1' },
    { t: 'They fight the room', d: 'The wrong adaptor, a dead HDMI port, guest wifi, a screen-sharing tool the client’s network blocks. Minutes of a short meeting go to cabling.', fill: C.cyanSoft, ink: C.cyanInk, n: '2' },
    { t: 'Everyone crowds one laptop', d: 'A room with three screens in it, and the deck is on a 13-inch display being turned around the table.', fill: C.amberSoft, ink: C.amberInk, n: '3' },
  ];
  const cw = (W - M * 2 - 0.5) / 3;
  items.forEach((it, i) => {
    const x = M + i * (cw + 0.25);
    card(s, { x, y: y0, w: cw, h: 3.1, fill: it.fill, stroke: it.fill });
    badge(s, x + 0.3, y0 + 0.3, it.n, it.ink);
    s.addText(it.t, {
      x: x + 0.3, y: y0 + 0.86, w: cw - 0.6, h: 0.6,
      fontFace: F.head, fontSize: 17, bold: true, color: it.ink, margin: 0, valign: 'top',
    });
    s.addText(it.d, {
      x: x + 0.3, y: y0 + 1.5, w: cw - 0.6, h: 1.4,
      fontFace: F.body, fontSize: 12.5, color: C.ink, margin: 0, valign: 'top',
    });
  });

  s.addText('The cost, at three client meetings a week and five minutes lost to connecting: roughly 7.7 million hours a year across 641,000 US representatives — about $385M of selling time.',
    { x: M, y: 5.6, w: W - M * 2, h: 0.9, fontFace: F.body, fontSize: 13.5, italic: true, color: C.inkSoft, margin: 0, valign: 'top' });
  s.addNotes('The meeting-time figure is derived, not sourced: headcounts are from BLS, the three-meetings and five-minutes assumptions are ours.');
}

/* ── 3. What Vinboo is ────────────────────────────────────────────────────── */
{
  const s = lightSlide();
  const y0 = heading(s, 'What Vinboo is',
    'A browser slideshow broadcaster. The presenter opens a page; every screen in the room shows the same slide.');

  card(s, { x: M, y: y0, w: 6.15, h: 2.75, fill: C.white });
  s.addText('For the presenter', {
    x: M + 0.35, y: y0 + 0.28, w: 5.4, h: 0.4,
    fontFace: F.head, fontSize: 18, bold: true, color: C.ink, margin: 0,
  });
  bullets(s, [
    'Open vinboo.com, choose photos or a PowerPoint file',
    'Nothing uploads — the files stay on the device',
    'A six-character code and a temporary password appear',
    'Hand off the show and the laptop can close entirely',
  ], { x: M + 0.35, y: y0 + 0.82, w: 5.45, h: 2.5 });

  card(s, { x: M + 6.4, y: y0, w: 6.15, h: 2.75, fill: C.cyanSoft, stroke: C.cyanSoft });
  s.addText('For everyone watching', {
    x: M + 6.75, y: y0 + 0.28, w: 5.4, h: 0.4,
    fontFace: F.head, fontSize: 18, bold: true, color: C.cyanInk, margin: 0,
  });
  bullets(s, [
    'Scan a QR code, or type the code into any browser',
    'No account, no app, no store approval on a television',
    'Televisions, laptops and phones, all at once',
    'No cable, no dongle, no shared network required',
  ], { x: M + 6.75, y: y0 + 0.82, w: 5.45, h: 2.5 });

  s.addText('Live today at vinboo.com. Photos, PowerPoint decks, unlimited screens.', {
    x: M, y: 5.95, w: W - M * 2, h: 0.5,
    fontFace: F.head, fontSize: 15, bold: true, color: C.coralInk, margin: 0,
  });
  s.addNotes('Everything on this slide is shipped and working today.');
}

/* ── 4. How it works ──────────────────────────────────────────────────────── */
{
  const s = lightSlide();
  const y0 = heading(s, 'The inversion',
    'Every comparable service uploads your files and distributes them. Vinboo makes the presenter’s browser the origin and the server a blind relay.');

  const steps = [
    { n: '1', t: 'A screen asks', d: 'A television requests slide four.', fill: C.cyan, ink: C.cyanInk },
    { n: '2', t: 'The server parks it', d: 'Rather than answering, it holds the request open and hands the job to the presenter’s browser.', fill: C.amber, ink: C.amberInk },
    { n: '3', t: 'The browser answers', d: 'It reads the file off the device and returns the bytes.', fill: C.coral, ink: C.coralInk },
    { n: '4', t: 'One reply, many screens', d: 'The answer is fanned out to everyone waiting on that slide, then forgotten.', fill: C.coral, ink: C.coralInk },
  ];
  const cw = (W - M * 2 - 0.75) / 4;
  steps.forEach((st, i) => {
    const x = M + i * (cw + 0.25);
    card(s, { x, y: y0, w: cw, h: 2.5, fill: C.white });
    badge(s, x + 0.28, y0 + 0.28, st.n, st.ink);
    s.addText(st.t, {
      x: x + 0.28, y: y0 + 0.82, w: cw - 0.56, h: 0.45,
      fontFace: F.head, fontSize: 15, bold: true, color: C.ink, margin: 0, valign: 'top',
    });
    s.addText(st.d, {
      x: x + 0.28, y: y0 + 1.28, w: cw - 0.56, h: 1.05,
      fontFace: F.body, fontSize: 12, color: C.inkSoft, margin: 0, valign: 'top',
    });
  });

  card(s, { x: M, y: 4.72, w: W - M * 2, h: 1.55, fill: C.coralSoft, stroke: C.coralSoft });
  s.addText('Ten screens on the same slide cost the presenter one upload.', {
    x: M + 0.4, y: 4.95, w: W - M * 2 - 0.8, h: 0.42,
    fontFace: F.head, fontSize: 19, bold: true, color: C.coralInk, margin: 0,
  });
  s.addText('The bytes exist in server memory only while in flight. It runs over ordinary HTTPS long-polling — no WebSockets, no peer-to-peer — so it passes through the corporate proxies and hotel networks that block those protocols.', {
    x: M + 0.4, y: 5.42, w: W - M * 2 - 0.8, h: 0.72,
    fontFace: F.body, fontSize: 13, color: C.ink, margin: 0, valign: 'top',
  });
  s.addNotes('This is the mechanism that makes the privacy claim structural rather than a policy promise, and it is what makes unlimited-screens pricing affordable.');
}

/* ── 4b. Hand-off, from the architecture diagram ──────────────────────────── */
{
  const s = lightSlide();
  s.addText('The show outlives the tab that started it', {
    x: M, y: 0.36, w: W - M * 2, h: 0.55,
    fontFace: F.head, fontSize: 30, bold: true, color: C.ink, margin: 0, valign: 'top',
  });
  s.addText('SHIPPED AND RUNNING TODAY — hand-off mode. Every screen copies the whole show as it plays, so the presenter can close the laptop and leave the room.', {
    x: M, y: 0.96, w: W - M * 2, h: 0.4,
    fontFace: F.body, fontSize: 12.5, bold: true, color: C.cyanInk, margin: 0, valign: 'top',
  });

  // 2871 x 733, aspect 3.92 — width is the binding constraint here.
  {
    const iw = W - M * 2, ih = iw / 3.92;
    s.addImage({ path: IMG + 'arch-handoff.png', x: M, y: 1.5, w: iw, h: ih });
  }

  card(s, { x: M, y: 5.05, w: W - M * 2, h: 1.35, fill: 'EFE9FB', stroke: 'EFE9FB' });
  s.addText('The limit, stated plainly', {
    x: M + 0.42, y: 5.24, w: 11.5, h: 0.4,
    fontFace: F.head, fontSize: 16, bold: true, color: '6B46C1', margin: 0,
  });
  s.addText('One screen holding a complete copy has to stay open. When none is, a late arrival is told so rather than left waiting for a photo that will never come. The show expires after the 1-to-48 hours chosen at the start, extendable once — nothing here is long-term storage, by design.',
    { x: M + 0.42, y: 5.7, w: 11.5, h: 0.62, fontFace: F.body, fontSize: 12.5, color: C.ink, margin: 0, valign: 'top' });
  s.addNotes('This is what lets a wedding reception keep playing after the couple put their phones away, and a shop window keep playing after the manager goes home — without the platform ever holding the pictures.');
}

/* ── 5. Why it matters ────────────────────────────────────────────────────── */
{
  const s = lightSlide();
  const y0 = heading(s, 'What the architecture buys',
    'Three consequences fall out of the design rather than being features bolted on.');

  const cw = (W - M * 2 - 0.5) / 3;
  const tiles = [
    { v: 'Nothing', l: 'is stored. The relay keeps no copy, so a confidential deck never lands on a company server or a client’s machine. A competitor cannot match this without rebuilding.', c: C.coralInk, f: C.coralSoft },
    { v: 'Unlimited', l: 'screens for one price. Marginal cost for the eighth television is near zero, because one upload is fanned out. Pixo bills per screen and caps at six.', c: C.cyanInk, f: C.cyanSoft },
    { v: 'No app', l: 'anywhere. Viewers use a browser they already have — no install, no account, no app-store approval on a smart television.', c: C.amberInk, f: C.amberSoft },
  ];
  tiles.forEach((t, i) => {
    const x = M + i * (cw + 0.25);
    card(s, { x, y: y0, w: cw, h: 2.55, fill: t.f, stroke: t.f });
    stat(s, { x: x + 0.35, y: y0 + 0.3, w: cw - 0.7, value: t.v, label: t.l, color: t.c, labelColor: C.ink, size: 34, lh: 1.7 });
  });

  card(s, { x: M, y: 5.2, w: W - M * 2, h: 1.15, fill: C.white });
  s.addText('And it inverts the cost structure. A competitor built on store-and-distribute pays per screen served, so it must bill per screen. Vinboo’s bandwidth grows with shows, not with audience — which is why unlimited screens is a price they cannot follow.',
    { x: M + 0.4, y: 5.42, w: W - M * 2 - 0.8, h: 0.8, fontFace: F.body, fontSize: 13.5, color: C.ink, margin: 0, valign: 'top' });
  s.addNotes('This is the business-model moat. It is more durable than any patent we could realistically defend on the relay itself.');
}

/* ── 6. What is built ─────────────────────────────────────────────────────── */
{
  const s = lightSlide();
  const y0 = heading(s, 'This is already built',
    'Not a prototype and not a design document. A deployed product, in daily working order, with no outside capital in it.');

  const cw = (W - M * 2 - 0.5) / 3;
  [
    { v: '234', l: 'automated tests passing across six suites', c: C.coralInk },
    { v: '$0', l: 'of outside capital raised to date', c: C.cyanInk },
    { v: '~$227', l: 'monthly infrastructure at first-year volumes', c: C.amberInk },
  ].forEach((t, i) => {
    const x = M + i * (cw + 0.25);
    card(s, { x, y: y0, w: cw, h: 1.75, fill: C.white });
    stat(s, { x: x + 0.35, y: y0 + 0.22, w: cw - 0.7, value: t.v, label: t.l, color: t.c, size: 38, lh: 0.6 });
  });

  card(s, { x: M, y: y0 + 2.0, w: W - M * 2, h: 2.5, fill: C.white });
  s.addText('Shipped and working', {
    x: M + 0.4, y: y0 + 2.2, w: 5.5, h: 0.4,
    fontFace: F.head, fontSize: 17, bold: true, color: C.ink, margin: 0,
  });
  bullets(s, [
    'Live relay: photos and PowerPoint to unlimited screens',
    'Hand-off mode — the show survives the presenter leaving',
    'PowerPoint rendered to vector graphics in the browser',
    'QR joining, accounts, multiple concurrent shows, feedback',
  ], { x: M + 0.4, y: y0 + 2.72, w: 5.6, h: 1.6, size: 13 });

  s.addText('Not yet built', {
    x: M + 6.5, y: y0 + 2.2, w: 5.5, h: 0.4,
    fontFace: F.head, fontSize: 17, bold: true, color: C.coralInk, margin: 0,
  });
  bullets(s, [
    'Payment processing and subscription management',
    'Exact server-side rendering of complex decks',
    'End-to-end encryption (the Private tier)',
    'Horizontal scale — one process holds all state today',
  ], { x: M + 6.5, y: y0 + 2.72, w: 5.6, h: 1.6, size: 13, color: C.inkSoft });
  s.addNotes('Being candid about the "not yet" column is deliberate. Every item there is on the roadmap slide with a cost attached.');
}

/* ── 7. Who buys ──────────────────────────────────────────────────────────── */
{
  const s = lightSlide();
  const y0 = heading(s, 'Who buys it',
    'Sized bottom-up from headcounts, because “the presentation software market is worth $X billion” says nothing about whether anyone pays $15 for this.');

  const rows = [
    { n: 'Business presenters', s: 'The primary market', a: '1.6M US wholesale, manufacturing and technical sales representatives. Assuming 40% carry a deck into client meetings: ~641,000 people.', b: '$115M', c: 'serviceable market at $180/year', ink: C.coralInk, fill: C.coralSoft },
    { n: 'Event vendors', s: 'Reached through suppliers, not couples', a: '2.5M US weddings a year. A DJ works forty weddings; a couple works one — so a few thousand vendor businesses reach the whole volume.', b: '$475k', c: 'per year at 1% attach, $19 an event', ink: C.cyanInk, fill: C.cyanSoft },
    { n: 'Consumers', s: 'Largest audience, weakest economics', a: 'Ad-funded free tier. It is the funnel and the advertising floor rather than the revenue.', b: '$434k', c: 'per year at 250,000 monthly presenters', ink: C.amberInk, fill: C.amberSoft },
  ];
  const rh = 1.42;
  rows.forEach((r, i) => {
    const y = y0 + i * (rh + 0.22);
    card(s, { x: M, y, w: W - M * 2, h: rh, fill: r.fill, stroke: r.fill });
    s.addText(r.n, {
      x: M + 0.35, y: y + 0.2, w: 3.3, h: 0.4,
      fontFace: F.head, fontSize: 16, bold: true, color: r.ink, margin: 0, valign: 'top',
    });
    s.addText(r.s, {
      x: M + 0.35, y: y + 0.62, w: 3.3, h: 0.6,
      fontFace: F.body, fontSize: 11.5, italic: true, color: C.inkSoft, margin: 0, valign: 'top',
    });
    s.addText(r.a, {
      x: M + 3.85, y: y + 0.22, w: 5.4, h: 1.05,
      fontFace: F.body, fontSize: 12.5, color: C.ink, margin: 0, valign: 'top',
    });
    s.addText(r.b, {
      x: M + 9.45, y: y + 0.2, w: 2.55, h: 0.55,
      fontFace: F.head, fontSize: 26, bold: true, color: r.ink, margin: 0, align: 'right', valign: 'top',
    });
    s.addText(r.c, {
      x: M + 9.45, y: y + 0.78, w: 2.55, h: 0.5,
      fontFace: F.body, fontSize: 10.5, color: C.inkSoft, margin: 0, align: 'right', valign: 'top',
    });
  });
  s.addNotes('Headcounts are sourced. The 40% deck-carrying rate and the penetration assumptions are ours and are stated as such.');
}

/* ── 8. The comparison that decides strategy ──────────────────────────────── */
{
  const s = lightSlide();
  const y0 = heading(s, 'The number that decides the strategy',
    'Both models were built. One of them needs 39 times fewer people to make more money.');

  card(s, { x: M, y: y0, w: 5.9, h: 2.55, fill: C.coralSoft, stroke: C.coralSoft });
  s.addText('Business presenters at 1%', {
    x: M + 0.4, y: y0 + 0.26, w: 5.1, h: 0.4,
    fontFace: F.head, fontSize: 16, bold: true, color: C.coralInk, margin: 0,
  });
  stat(s, { x: M + 0.4, y: y0 + 0.74, w: 2.4, value: '6,413', label: 'customers', color: C.coralInk, size: 36, lh: 0.4 });
  stat(s, { x: M + 3.0, y: y0 + 0.74, w: 2.5, value: '$1.15M', label: 'per year', color: C.coralInk, size: 36, lh: 0.4 });
  s.addText('8% of Mentimeter’s customer count, in an adjacent category doing $38M.', {
    x: M + 0.4, y: y0 + 1.92, w: 5.1, h: 0.5,
    fontFace: F.body, fontSize: 12, color: C.ink, margin: 0, valign: 'top',
  });

  card(s, { x: M + 6.15, y: y0, w: 5.9, h: 2.55, fill: C.white });
  s.addText('Consumer presenters', {
    x: M + 6.55, y: y0 + 0.26, w: 5.1, h: 0.4,
    fontFace: F.head, fontSize: 16, bold: true, color: C.inkSoft, margin: 0,
  });
  stat(s, { x: M + 6.55, y: y0 + 0.74, w: 2.4, value: '250,000', label: 'presenters', color: C.inkSoft, size: 36, lh: 0.4 });
  stat(s, { x: M + 9.15, y: y0 + 0.74, w: 2.5, value: '$434k', label: 'per year', color: C.inkSoft, size: 36, lh: 0.4 });
  s.addText('Plus all the bandwidth that 500,000 shows a month brings with it.', {
    x: M + 6.55, y: y0 + 1.92, w: 5.1, h: 0.5,
    fontFace: F.body, fontSize: 12, color: C.inkSoft, margin: 0, valign: 'top',
  });

  card(s, { x: M, y: 5.05, w: W - M * 2, h: 1.35, fill: C.stage, stroke: C.stage });
  s.addText('39× fewer people. 2.7× the revenue.', {
    x: M + 0.45, y: 5.24, w: 6.0, h: 0.5,
    fontFace: F.head, fontSize: 22, bold: true, color: C.stageText, margin: 0,
  });
  s.addText('The party use case the landing page leads with is commercially the weakest of the three. The product should point at the business presenter — and that segment is gated behind one engineering problem.',
    { x: M + 0.45, y: 5.76, w: 11.4, h: 0.55, fontFace: F.body, fontSize: 12.5, color: C.stageMuted, margin: 0, valign: 'top' });
  s.addNotes('This slide is the strategic hinge of the whole deck. It sets up the roadmap.');
}

/* ── 9. Competition ───────────────────────────────────────────────────────── */
{
  const s = lightSlide();
  const y0 = heading(s, 'The competition, and the real incumbent',
    'The paid products are not what we mostly lose to.');

  const rows = [
    ['', 'Approach', 'Price', 'Where it falls short'],
    ['Pixo', 'Ambient photos to televisions', '$1.49 per screen / month', 'Bills per screen, caps at three or six; stores your photos'],
    ['Mentimeter', 'Slides onto the audience’s phones', '$12–25 per presenter / month', 'Uploads your deck; built for polling, not for a room'],
    ['Sync', 'Screen mirroring', 'From $12.50 / month', 'Uploads; no hand-off'],
    ['PowerPoint Present Live', 'Audience follows along', 'Bundled with Office', 'Retired by Microsoft for low usage'],
  ];
  s.addTable(rows.map((r, ri) => r.map((cell, ci) => ({
    text: cell,
    options: {
      bold: ri === 0 || ci === 0,
      color: ri === 0 ? C.inkSoft : (ci === 0 ? C.ink : C.ink),
      fontSize: ri === 0 ? 11.5 : 12,
      fill: { color: ri === 0 ? C.paper : C.white },
    },
  }))), {
    x: M, y: y0, w: W - M * 2, colW: [2.5, 3.1, 2.5, 3.96],
    fontFace: F.body, border: { type: 'solid', color: C.line, pt: 1 },
    rowH: 0.46, valign: 'middle', margin: 0.08,
  });

  card(s, { x: M, y: 5.05, w: W - M * 2, h: 1.4, fill: C.cyanSoft, stroke: C.cyanSoft });
  s.addText('What we actually displace: an HDMI cable, an emailed PDF, and Teams.', {
    x: M + 0.42, y: 5.24, w: 11.5, h: 0.42,
    fontFace: F.head, fontSize: 17, bold: true, color: C.cyanInk, margin: 0,
  });
  s.addText('A representative arrives with a bag of adaptors or emails the deck ahead. Those, not the paid products, are the incumbents — and Microsoft retiring Present Live is evidence that “the audience follows along” is the wrong pitch. The durable one is: your deck never lands on their machine.',
    { x: M + 0.42, y: 5.7, w: 11.5, h: 0.65, fontFace: F.body, fontSize: 12.5, color: C.ink, margin: 0, valign: 'top' });
  s.addNotes('Naming Teams and the cable as the real competition is more credible than a feature grid where we win every row.');
}

/* ── 10. Model and economics ──────────────────────────────────────────────── */
{
  const s = lightSlide();
  const y0 = heading(s, 'How it makes money',
    'A free tier that funds itself on advertising, and subscriptions where the revenue actually is.');

  const tiers = [
    { n: 'Free', p: 'Ad supported', d: 'The funnel and the advertising floor. Full live sharing, limited hand-off.', ink: C.inkSoft, fill: C.white },
    { n: 'Pro', p: '$180 / year', d: 'The business presenter. Exact deck fidelity, longer hand-off, unlimited screens.', ink: C.coralInk, fill: C.coralSoft },
    { n: 'Events', p: '$19 / event', d: 'One-time pass sold through wedding and event vendors.', ink: C.amberInk, fill: C.amberSoft },
    { n: 'Private', p: 'Premium', d: 'End-to-end encrypted. Designed, not yet built.', ink: C.cyanInk, fill: C.cyanSoft },
  ];
  const cw = (W - M * 2 - 0.75) / 4;
  tiers.forEach((t, i) => {
    const x = M + i * (cw + 0.25);
    card(s, { x, y: y0, w: cw, h: 2.15, fill: t.fill, stroke: t.fill });
    s.addText(t.n, { x: x + 0.3, y: y0 + 0.22, w: cw - 0.6, h: 0.38, fontFace: F.head, fontSize: 18, bold: true, color: t.ink, margin: 0 });
    s.addText(t.p, { x: x + 0.3, y: y0 + 0.63, w: cw - 0.6, h: 0.34, fontFace: F.body, fontSize: 13, bold: true, color: C.ink, margin: 0 });
    s.addText(t.d, { x: x + 0.3, y: y0 + 1.02, w: cw - 0.6, h: 1.0, fontFace: F.body, fontSize: 11.5, color: C.inkSoft, margin: 0, valign: 'top' });
  });

  s.addChart(pres.ChartType.bar, [{
    name: 'Total revenue',
    labels: ['Year 1', 'Year 2', 'Year 3', 'Year 5'],
    values: [8.7, 87, 434, 1530],
  }], {
    x: M, y: y0 + 2.45, w: 7.2, h: 3.0,
    barDir: 'col', chartColors: [C.coral, C.coral, C.coral, C.cyan],
    showTitle: true, title: 'Revenue path ($ thousands)', titleFontFace: F.head,
    titleFontSize: 14, titleColor: C.ink,
    showValue: true, dataLabelPosition: 'outEnd', dataLabelFontSize: 11,
    dataLabelColor: C.ink, dataLabelFontFace: F.body,
    showLegend: false,
    catAxisLabelColor: C.inkSoft, catAxisLabelFontSize: 11, catAxisLabelFontFace: F.body,
    valAxisLabelColor: C.inkSoft, valAxisLabelFontSize: 10, valAxisHidden: true,
    valGridLine: { color: C.line, size: 1 }, catGridLine: { style: 'none' },
  });

  card(s, { x: M + 7.5, y: y0 + 2.45, w: 4.55, h: 3.0, fill: C.white });
  s.addText('Why the margin holds', {
    x: M + 7.85, y: y0 + 2.68, w: 3.9, h: 0.38,
    fontFace: F.head, fontSize: 16, bold: true, color: C.ink, margin: 0,
  });
  stat(s, { x: M + 7.85, y: y0 + 3.15, w: 3.9, value: '94%', label: 'gross margin at Year 2 and above. The relay is I/O-bound long-polling, not CPU-bound: what matters is open connections, not volume.', color: C.cyanInk, size: 40, lh: 1.5 });
  s.addNotes('Year 1 and 2 are the consumer model; Year 5 assumes the business tier carries the revenue. Compute stays near flat because the relay is I/O bound.');
}

/* ── 11. Roadmap ──────────────────────────────────────────────────────────── */
{
  const s = darkSlide();
  const y0 = heading(s, 'Where it goes next', 'Four pieces of engineering, in dependency order. The first three are prerequisites to the adoption curve; the fourth is the moat.', true);

  const phases = [
    { n: '1', t: 'Survive its own deploys', d: 'Persist the session record so a restart stops ending every live show. Days of work.', ink: C.cyan },
    { n: '2', t: 'Scale past one machine', d: 'Shard on the show code so requests for a show always meet in one process. Removes a hard 200-show ceiling.', ink: C.cyan },
    { n: '3', t: 'Exact deck fidelity', d: 'Server-side conversion. 37% of a real enterprise deck currently renders as placeholders. This gates the entire business tier.', ink: C.amber },
    { n: '4', t: 'Vinboo Private', d: 'End-to-end encryption. The strongest differentiator, and the one no competitor offers.', ink: C.coral },
  ];
  const cw = (W - M * 2 - 0.75) / 4;
  phases.forEach((p, i) => {
    const x = M + i * (cw + 0.25);
    card(s, { x, y: y0, w: cw, h: 3.05, fill: C.stageBar, stroke: '2E2748' });
    badge(s, x + 0.3, y0 + 0.3, p.n, p.ink, C.stage);
    s.addText(p.t, {
      x: x + 0.3, y: y0 + 0.88, w: cw - 0.6, h: 0.72,
      fontFace: F.head, fontSize: 16, bold: true, color: C.stageText, margin: 0, valign: 'top',
    });
    s.addText(p.d, {
      x: x + 0.3, y: y0 + 1.62, w: cw - 0.6, h: 1.25,
      fontFace: F.body, fontSize: 12, color: C.stageMuted, margin: 0, valign: 'top',
    });
  });

  s.addText('Commercially, the gap is smaller: no payment processing, subscription management or password recovery exists yet. All are prerequisites to charging anyone, and none are hard.',
    { x: M, y: 5.6, w: W - M * 2, h: 0.8, fontFace: F.body, fontSize: 13, color: C.stageMuted, margin: 0, valign: 'top' });
  s.addNotes('Order is by dependency. Fidelity is the commercial gate; encryption is the differentiator.');
}

/* ── 12. Vinboo Private — the diagram (core) ─────────────────────────────── */
{
  const s = lightSlide();
  s.addText('Vinboo Private: the same relay, carrying sealed boxes', {
    x: M, y: 0.36, w: W - M * 2, h: 0.55,
    fontFace: F.head, fontSize: 28, bold: true, color: C.ink, margin: 0, valign: 'top',
  });
  s.addText('DESIGNED, NOT YET BUILT — this is the architecture for the Private tier, not the system running today.', {
    x: M, y: 0.94, w: W - M * 2, h: 0.36,
    fontFace: F.body, fontSize: 12.5, bold: true, color: C.coralInk, margin: 0, valign: 'top',
  });
  // 2270 x 1270, aspect 1.787. Height is the binding constraint, not width:
  // from y = 1.40 there are 5.85 inches left before the bottom margin.
  {
    const ih = 5.85, iw = ih * (2270 / 1270);
    s.addImage({ path: IMG + 'e2ee-core.png', x: (W - iw) / 2, y: 1.40, w: iw, h: ih });
  }
  s.addNotes('The key never reaches the server. The viewer secret is split by HKDF: Vinboo receives the half that proves you know it, never the half that opens the box.');
}

/* ── 13. What encryption buys and costs ───────────────────────────────────── */
{
  const s = lightSlide();
  const y0 = heading(s, 'What that buys — and what it costs',
    'The design is written down in full, including the parts that do not flatter it.');

  const cols = [
    { t: 'What the server cannot see', ink: C.cyanInk, fill: C.cyanSoft, items: ['The pictures and the deck', 'The file names', 'The title of the show', 'A breach or subpoena yields ciphertext and timings — no images'] },
    { t: 'What it still learns', ink: C.amberInk, fill: C.amberSoft, items: ['That you are presenting, and when', 'How many screens, and for how long', 'How many slides, and the size of each', 'Shape and time, not content'] },
    { t: 'The honest limit', ink: C.coralInk, fill: C.coralSoft, items: ['The browser runs code Vinboo serves', 'A compromised operator could ship JavaScript that copies the key', 'Encryption narrows what a breach exposes; it does not remove trust in the page', 'Lose the link and the show is gone, by design'] },
  ];
  const cw = (W - M * 2 - 0.5) / 3;
  cols.forEach((c, i) => {
    const x = M + i * (cw + 0.25);
    card(s, { x, y: y0, w: cw, h: 2.95, fill: c.fill, stroke: c.fill });
    s.addText(c.t, {
      x: x + 0.32, y: y0 + 0.26, w: cw - 0.64, h: 0.42,
      fontFace: F.head, fontSize: 16, bold: true, color: c.ink, margin: 0, valign: 'top',
    });
    bullets(s, c.items, { x: x + 0.32, y: y0 + 0.8, w: cw - 0.64, h: 2.4, size: 12, gap: 8 });
  });

  card(s, { x: M, y: 5.55, w: W - M * 2, h: 1.0, fill: C.white });
  s.addText('The tension worth naming: encryption and server-side conversion are mutually exclusive. If the server cannot read the deck, it cannot convert it — so Private trades exact fidelity for secrecy. That is a deliberate, disclosed choice, not an oversight.',
    { x: M + 0.4, y: 5.72, w: W - M * 2 - 0.8, h: 0.7, fontFace: F.body, fontSize: 12.5, italic: true, color: C.ink, margin: 0, valign: 'top' });
  s.addNotes('Investors with security backgrounds will ask about the JavaScript delivery problem. Answering it before they raise it is worth more than the claim itself.');
}

/* ── 14. Risks ────────────────────────────────────────────────────────────── */
{
  const s = lightSlide();
  const y0 = heading(s, 'What could go wrong',
    'The four we take most seriously, and what each would take to answer.');

  const risks = [
    { r: 'Nobody wants the feature', m: 'Microsoft retired Present Live for low usage — the closest analogue, with a billion-seat channel.', a: 'Re-pitch on control, not participation. Validate with real sales professionals before building further.' },
    { r: 'Deck fidelity blocks the business tier', m: '37% of a real enterprise deck renders as placeholders today.', a: 'Server-side conversion. Costed, scoped, and first in the funded roadmap.' },
    { r: 'The architecture will not scale', m: 'All state is in one process; a hard ceiling of 200 concurrent shows, breached by the Year 3 model.', a: 'Shard by show code. Days of work, not a rewrite. Documented in full.' },
    { r: 'No proven acquisition channel', m: 'The plan has no data on how customers are reached, and this is the weakest part of it.', a: 'Event vendors first: one DJ serves forty weddings a year where a couple serves one.' },
  ];
  const rh = 0.92;
  risks.forEach((r, i) => {
    const y = y0 + i * (rh + 0.16);
    card(s, { x: M, y, w: W - M * 2, h: rh, fill: C.white });
    s.addText(r.r, {
      x: M + 0.32, y: y + 0.16, w: 3.3, h: 0.75,
      fontFace: F.head, fontSize: 13.5, bold: true, color: C.coralInk, margin: 0, valign: 'top',
    });
    s.addText(r.m, {
      x: M + 3.75, y: y + 0.16, w: 4.1, h: 0.78,
      fontFace: F.body, fontSize: 11.5, color: C.inkSoft, margin: 0, valign: 'top',
    });
    s.addText(r.a, {
      x: M + 8.0, y: y + 0.16, w: 3.95, h: 0.78,
      fontFace: F.body, fontSize: 11.5, color: C.ink, margin: 0, valign: 'top',
    });
  });
  s.addText('Left: the risk.   Centre: the evidence against us.   Right: the answer.', {
    x: M, y: 6.55, w: W - M * 2, h: 0.35,
    fontFace: F.body, fontSize: 11, italic: true, color: C.inkSoft, margin: 0,
  });
  s.addNotes('Leading with the Present Live evidence is deliberate: a sophisticated investor will find it anyway.');
}

/* ── 15. Close ────────────────────────────────────────────────────────────── */
{
  const s = darkSlide();
  s.addText('A working product, a costed roadmap,\nand a moat that is architectural.', {
    x: M, y: 1.5, w: 11.5, h: 1.7,
    fontFace: F.head, fontSize: 32, bold: true, color: C.stageText,
    margin: 0, lineSpacingMultiple: 1.14, valign: 'top',
  });

  const cw = (W - M * 2 - 0.5) / 3;
  [
    { v: '$1.53M', l: 'projected Year 5 revenue', c: C.coral },
    { v: '7', l: 'Pennsylvania employees by Year 5', c: C.cyan },
    { v: '4', l: 'engineering milestones to get there', c: C.amber },
  ].forEach((t, i) => {
    const x = M + i * (cw + 0.25);
    card(s, { x, y: 3.55, w: cw, h: 1.75, fill: C.stageBar, stroke: '2E2748' });
    stat(s, { x: x + 0.35, y: 3.78, w: cw - 0.7, value: t.v, label: t.l, color: t.c, labelColor: C.stageMuted, size: 38, lh: 0.6 });
  });

  s.addText('The capital does not buy an idea. It buys the four things standing between a product that works and a product that sells.', {
    x: M, y: 5.65, w: 11.5, h: 0.6,
    fontFace: F.body, fontSize: 14, color: C.stageMuted, margin: 0, valign: 'top',
  });
  s.addText('vinboo.com', {
    x: M, y: 6.45, w: 6, h: 0.42,
    fontFace: F.head, fontSize: 16, bold: true, color: C.coral, margin: 0,
  });
  s.addNotes('Close on the distinction between funding an idea and funding the gap to revenue.');
}

/* ── 16. Appendix: the architecture as built ─────────────────────────────── */
{
  const s = lightSlide();
  s.addText('Appendix — the architecture as built', {
    x: M, y: 0.3, w: 8.6, h: 0.5,
    fontFace: F.head, fontSize: 22, bold: true, color: C.ink, margin: 0, valign: 'top',
  });
  s.addText('Shipped and running today. The encrypted design overleaf changes only what the server is able to read.', {
    x: M, y: 0.8, w: 8.6, h: 0.34,
    fontFace: F.body, fontSize: 12, color: C.cyanInk, margin: 0, valign: 'top',
  });
  // 2400 x 2074, aspect 1.157. Height-constrained.
  {
    const ih = 6.1, iw = ih * (2400 / 2074);
    s.addImage({ path: IMG + 'arch-full.png', x: (W - iw) / 2, y: 1.25, w: iw, h: ih });
  }
  s.addNotes('Full-resolution source: docs/architecture.svg in the repository.');
}

/* ── 17. Appendix: the full encrypted diagram ────────────────────────────── */
{
  const s = lightSlide();
  s.addText('Appendix — Vinboo Private, in full', {
    x: M, y: 0.3, w: 8.0, h: 0.5,
    fontFace: F.head, fontSize: 22, bold: true, color: C.ink, margin: 0, valign: 'top',
  });
  s.addText('Complete architecture for the end-to-end encrypted tier. Designed, not yet built.', {
    x: M, y: 0.8, w: 8.0, h: 0.34,
    fontFace: F.body, fontSize: 12, color: C.coralInk, margin: 0, valign: 'top',
  });
  // 2400 x 2140, aspect 1.121. Fit to height.
  const h = 6.1, w = h * (2400 / 2140);
  s.addImage({ path: IMG + 'e2ee.png', x: (W - w) / 2, y: 1.25, w, h });
  s.addNotes('Full-resolution source: docs/architecture-e2ee.svg in the repository.');
}

pres.writeFile({ fileName: __dirname + '/Vinboo-Investor-Deck.pptx' })
  .then((f) => console.log('written:', f))
  .catch((e) => { console.error('FAILED', e); process.exit(1); });
