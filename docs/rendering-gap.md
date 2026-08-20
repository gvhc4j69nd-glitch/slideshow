# What Real Decks Cost the Renderer

**Date:** 20 August 2026
**Method:** `node scripts/deck-report.js <deck.pptx>`
**Sample:** 76 corporate decks, of which 32 parse as valid `.pptx` — 1,126
slides. They are client documents and are not in this repository; only these
counts were kept.

---

## 1. What changed

The renderer went from failing almost every slide in the sample to drawing 98%
of them. The work that got it there was not the work anyone would have guessed,
which is the main lesson of this document.

| Stage | Slides rendering clean |
|---|---|
| Before any of this | ~0% on most decks |
| Ignoring invisible embedded objects | 94% |
| Adding the EMF renderer | 96% |
| Fixing SmartArt resolution | **98%** |

## 2. The finding that mattered most

**92% of every embedded object in the corpus is an invisible marker.**

Add-ins — think-cell in this sample, but the pattern is general — park their
bookkeeping on a slide as an embedded object roughly a fifth of an inch square.
Nobody looking at the deck can see it. Of 1,871 OLE objects measured, 1,708 were
named "think-cell Slide" and 1,674 were 0.2 × 0.2 inches.

The renderer drew a labelled placeholder for each one. One such object on a
**slide master** is inherited by every slide in the deck, so a single invisible
marker failed all sixty-six slides of one file at once.

Ignoring anything under half an inch took the corpus from roughly zero to 94%.
It took about an hour. Everything else in this document is worth four points
between them.

**The lesson is about sequencing, not about think-cell.** The first measurement
of a single deck said embedded objects appeared on 66 of 66 slides, which read
as an enormous problem. It was one object counted 66 times. Occurrences measure
damage; they do not measure work.

## 3. EMF

`public/emf.js` plays Enhanced Metafile records back as SVG, written from the
published MS-EMF specification.

Scope was measured rather than guessed. A histogram of record types across 51
real metafiles from the corpus showed about thirty types in use, and **no bitmap
records at all**, which removed a whole subsystem before it was written. What is
implemented: the device context — pens, brushes, fonts, the transform stack,
save and restore — path construction, polygons and béziers, ellipses and
rectangles, text with alignment and rotation, and clipping. Unknown records are
skipped by their own length, so an unfamiliar record costs a detail rather than
the render.

**Result: EMF failures fell from 30 slides to 1.** Of 51 sample metafiles, 42
render with content and none throw.

One bug worth recording because it was invisible: the four
`MODIFYWORLDTRANSFORM` mode constants were all mismapped. That record appears
2,612 times in the corpus, and getting it wrong puts shapes in the wrong place
without any error. There is now a test that pins the numbering.

## 4. SmartArt

A diagram's own parts describe it as data plus layout rules. Drawing it from
those would mean implementing the layout engine, and there is no need:
PowerPoint also writes the finished result as ordinary shapes in a
`diagramDrawing` part, so readers that cannot lay it out can still draw it.

The catch is **where that part is referenced from**, and the first
implementation guessed wrong. Every SmartArt diagram in the corpus — all 39 —
failed because the relationship was looked for on the diagram's data part. In
practice PowerPoint puts it on the **slide**. The resolver now tries, in order
of how firmly each says which drawing belongs to which diagram:

1. a `dataModelExt` inside the `relIds` element, naming a relationship;
2. a `diagramDrawing` relationship on the slide, paired to the data part by
   number when a slide carries more than one diagram;
3. a relationship on the data part itself.

**Result: SmartArt failures fell from 20 slides to none.**

## 5. Print hanging off the edge of its shape

Counting a slide as "clean" only says nothing was left undrawn. It says nothing
about whether what was drawn stayed inside its box, and it did not: **6.7% of
every line laid out across the corpus — 18,524 of 277,648 — was wider than the
shape holding it.**

Two causes, both in the line wrapper.

**A run too wide to fit on any line was placed anyway.** Wrapping between words
cannot help a single word wider than its box, so the wrapper put it down and
carried on, and every following word piled onto that already-oversized line.
PowerPoint breaks mid-word rather than spill. Now so does this: the break point
is guessed proportionally and then nudged, so a long run costs a couple of
measurements rather than one per character.

**A trailing space was counted in the line's width.** It draws nothing, but it
wrapped the next word slightly too early and shifted every centred and
right-aligned line left by the width of a space. Dropped when the line closes.

| | lines wider than their shape |
|---|---|
| Before | 18,524 (6.67%) |
| After breaking over-long runs | 8,558 (2.99%) |
| After dropping trailing spaces | **117 (0.04%)** |

What remains is single characters wider than their own box, which nothing can
break further.

**A third cause, and the one that actually reached users.** The two above were
found by measuring in Node, where the same approximation is used to lay out and
to check. In the browser the app measures with a real canvas, and it was asking
for the wrong font.

The deck's font is usually not installed — Calibri is in almost every corporate
deck and on almost no Mac. The layout measured bare `Calibri`, which let the
canvas fall back to its own default; the slide was then drawn with the full
stack, which falls back to Helvetica. Measured in one face, drawn in a wider
one:

| Sample line | Measured | Drawn | Error |
|---|---|---|---|
| "Market projected to reach $198B…" | 305.4px | 339.8px | −10.1% |
| "National Security Priority" | 186.0px | 198.6px | −6.4% |
| "quantum as a sovereign technology…" | 315.8px | 350.8px | −10.0% |

Every line was measured about a tenth narrower than it draws, so any line that
only just fitted ran off the end of its box — and none of it showed up in a Node
measurement, because there the approximation is used consistently for both.

`fontStack` is now exported and the app measures with the identical string it
draws with. Measurement error against the same three samples is **0%**.

The general lesson is worth keeping: a layout engine is only as good as its
measurement, and a measurement taken in a different font from the drawing is not
a measurement of anything.

Vertical overflow was measured at the same time and is a different story: 3% of
text shapes, of which the ones that *ask* to be shrunk to fit — `normAutofit` —
never overflow at all. The rest are shapes the deck marks as "do not shrink", or
shapes with no stated height, where letting print run past the box is what
PowerPoint does too. That was left alone deliberately.

## 6. What is left

17 slides of 1,126 — 1.5%.

| What is missing | Slides |
|---|---|
| an embedded object | 12 |
| a Windows metafile (WMF) | 4 |
| an embedded drawing (EMF) | 1 |

WMF is the older metafile format and is not implemented. The remaining embedded
objects are ones with no cached preview to extract.

None of this is worth building next. At 98% the renderer is no longer what
limits the product.

## 7. What this says about the roadmap

The plan of record — from `docs/business-plan.md` and the investor deck — put
server-side LibreOffice conversion as the gate on the business tier, on the
evidence that 37% of one deck rendered as placeholders.

That evidence no longer holds. The measured figure across 32 decks is **98%
clean, in the browser, with nothing uploaded**. The case for putting a document
converter on a server — with the sandboxing burden, the upload path, and the
asterisk it would put on the promise that files never leave the device — is
considerably weaker than it was.

Both documents still carry the old ordering and should be revised.

## 8. How much to trust this

Better than the previous version of this document, which rested on one deck, but
still one genre: corporate strategy and architecture decks from a consultancy,
heavy on pasted spreadsheet and diagram content. A sales pitch deck or a
marketing deck would exercise different things — gradients, photographs,
transitions.

34 of the 76 files did not parse as `.pptx` at all. They are most likely legacy
`.ppt`, which is a different format this renderer does not read.

The honest headline is therefore: **98% of slides in 32 real corporate decks**.
Any figure quoted to a customer or an investor should name the corpus it came
from.

## 9. Reproducing this

```
node scripts/deck-report.js <deck.pptx>            # counts, and which slides
node scripts/deck-report.js <deck.pptx> --svg out  # every slide, to look at
```

Keep test decks **outside this repository**. The file behind the first version
of this report was a client document sitting in `docs/`, one `git add -A` away
from a public repo.
