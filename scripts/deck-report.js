#!/usr/bin/env node
'use strict';

/**
 * What a real deck costs this renderer.
 *
 *   node scripts/deck-report.js deck.pptx [--svg out-dir]
 *
 * The renderer already records what it could not draw, but "which kinds are
 * missing" does not say whether the hole is one expensive feature or four cheap
 * ones. This prints the breakdown — occurrences, and the slides they spoil —
 * which is the number that decides what is worth building next.
 *
 * With --svg it also writes each slide out, so a hole can be looked at rather
 * than inferred from a count.
 */

const fs = require('fs');
const path = require('path');
const Pptx = require('../public/pptx.js');

function bar(n, max, width = 28) {
  if (!max) return '';
  return '█'.repeat(Math.max(1, Math.round((n / max) * width)));
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const svgAt = args.indexOf('--svg');
  const svgDir = svgAt >= 0 ? args[svgAt + 1] : null;

  if (!file) {
    console.error('usage: node scripts/deck-report.js <deck.pptx> [--svg <out-dir>]');
    process.exit(2);
  }

  const bytes = fs.readFileSync(file);
  const rendered = await Pptx.render(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );

  const total = rendered.slides.length;
  const clean = total - rendered.incomplete;
  const pct = total ? Math.round((clean / total) * 100) : 0;

  console.log(`\n${path.basename(file)}`);
  console.log(`${total} slides · ${rendered.width.toFixed(0)}×${rendered.height.toFixed(0)}\n`);
  console.log(`  renders clean   ${clean}/${total}  (${pct}%)`);
  console.log(`  has a hole      ${rendered.incomplete}/${total}\n`);

  const entries = Object.entries(rendered.counts)
    .sort((a, b) => b[1].slides - a[1].slides || b[1].occurrences - a[1].occurrences);

  if (!entries.length) {
    console.log('  Nothing missing. The whole deck draws.\n');
  } else {
    const maxSlides = Math.max(...entries.map(([, c]) => c.slides));
    const width = Math.max(...entries.map(([k]) => k.length));
    console.log('  what is missing        slides  times');
    console.log('  ' + '─'.repeat(width + 24));
    for (const [kind, c] of entries) {
      console.log(`  ${kind.padEnd(width)}  ${String(c.slides).padStart(6)}`
        + `  ${String(c.occurrences).padStart(5)}   ${bar(c.slides, maxSlides)}`);
    }
    console.log('');

    // Which slides, so they can be opened and looked at.
    for (const [kind] of entries) {
      const on = rendered.slides
        .filter((s) => s.missing.includes(kind))
        .map((s) => s.index + 1);
      console.log(`  ${kind}: slides ${on.join(', ')}`);
    }
    console.log('');
  }

  if (svgDir) {
    fs.mkdirSync(svgDir, { recursive: true });
    for (const slide of rendered.slides) {
      const n = String(slide.index + 1).padStart(3, '0');
      const flag = slide.missing.length ? '-incomplete' : '';
      fs.writeFileSync(path.join(svgDir, `slide-${n}${flag}.svg`), slide.svg);
    }
    console.log(`  ${rendered.slides.length} slides written to ${svgDir}\n`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
