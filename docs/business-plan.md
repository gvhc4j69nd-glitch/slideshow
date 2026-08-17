# Business plan — Vinboo

*August 2026. Companion to [competitive-analysis.md](competitive-analysis.md), which
this plan assumes and does not repeat. Every number is tagged: **[measured]** from
this codebase, **[sourced]** from a vendor or public figure cited at the end, or
**[assumed]** — a planning estimate that should be replaced with real data as soon
as there is any.*

---

## 1. Executive summary

Vinboo is a browser slideshow broadcaster: photos or a PowerPoint on every screen
at once, streamed from the presenter's own device, with nothing uploaded and no
account needed to watch.

**The model.** Free, funded by three ad placements — the landing page, the
signed-in library, and the viewer page. Paid tiers remove the ads and add what
the free architecture cannot do: **Plus** ($3.99) for a show that survives
everyone going offline, **Pro** ($15) for exact PowerPoint fidelity and the tools
a professional presenter needs, **Private** ($8.99) for end-to-end encryption,
and **Event** ($19 once) for a weekend. Pro and Private are alternatives rather
than rungs — a server cannot both render your deck and be unable to read it.

**The finding that matters most.** Ads are not the business. At a realistic
consumer display RPM, ads produce roughly a third of revenue at scale and cover
infrastructure comfortably — but subscriptions produce the rest. Modelled at
250,000 monthly presenters: **$135k/year advertising, $299k/year subscriptions,
$18k/year infrastructure.**

**The finding that costs the most.** In live mode a viewer holds only six slides
in memory, so a show re-fetches the same photos through the relay for as long as
it runs. **Cost therefore scales with duration rather than with content, and
break-even is 19 minutes** — a show earns $0.015 and costs about $0.048 an hour
to serve. Blended over a realistic mix of show lengths that is **18× more egress
than necessary**, which takes gross margin from **96% to 33%**; if shows really do
run all evening it reaches $72,000/month and exceeds revenue outright. Having a
viewer keep the show, which hand-off mode already does, is a few hours of work
and is the single highest-value engineering task in this document.

**Where the money most likely is.** Sized bottom-up in §2: **6,413 business
presenters would out-earn 250,000 consumer ones — 39× fewer people for 2.7× the
revenue.** The business segment is worth ~$115M/year serviceable in the US alone,
and it is the one currently blocked by deck fidelity rather than by demand.

**The pleasant surprise.** Premium is *cheaper to serve than free*. Object
storage costs $0.015/GB-month with free egress on both Railway and Cloudflare
R2, while relayed traffic costs $0.05/GB. A stored premium show serves at
near-zero marginal cost; a free relayed show does not. Ten thousand stored
slideshows cost **$2.50/month** to keep.

---

## 2. The market, and what the competition proves

The competitive analysis establishes the gap. Three of its findings carry
directly into the financial plan.

**The audience-follows-along market is real and large.** Mentimeter reached
**270 million participants against 14 million presenters** by the end of 2021 —
a **19:1 viewer-to-presenter ratio** — with 80,000 paying customers and $38M
revenue in 2024 [sourced]. That ratio is the most important number in this plan,
because in an ad-funded model *viewers are the inventory*. Vinboo's ratio will be
lower for living-room use (a party has three TVs, not nineteen guests with
phones) but the same shape: every presenter brings several ad impressions with
them at no acquisition cost.

**But the exact feature has failed before.** Microsoft retired PowerPoint Present
Live citing low usage [sourced]. That is direct evidence that "audience follows
on their own device" is a smaller want than it looks, and it is the strongest
argument for *not* betting the company on the presentation use case alone.

**Willingness to pay is proven at low prices.** Pixo charges from $1.49/month
**per television**, capped at three or six screens, and markets "no need to keep
the app open" as its headline [sourced via analysis]. Sync starts at $12.50/month.
Mentimeter charges $11.99–24.99 per presenter/month [sourced]. So the market pays
$1.50 at the ambient-photo end and $12–25 at the presentation end. Vinboo's
premium belongs between them, and its unlimited-screens position is worth real
money against a competitor that charges per screen and caps at six.

### How big each segment is

Sized bottom-up from headcounts rather than top-down from a category, because
"the presentation software market is worth $X billion" says nothing about whether
anyone pays $15 for this.

**Business presenters.** The US has **1.3 million** wholesale and manufacturing
sales representatives plus **303,200** in technical and scientific products —
about **1.6 million** [sourced]. Assume 40% carry a deck into a client meeting
[assumed]: a serviceable market of ~641,000 people, or **$115M/year** at Pro's
$180.

| Penetration | Users | Revenue |
|---|---|---|
| 0.5% | 3,206 | $577k/yr |
| **1%** | **6,413** | **$1.15M/yr** |
| 3% | 19,238 | $3.46M/yr |

**Events.** About **2.5 million US weddings a year** [sourced]. At $19 a pass:
1% attach is $475k/yr, 5% is $2.4M/yr — but it is one-time revenue from a
customer who never returns, and it is reached through vendors rather than
couples, since a wedding DJ works forty weddings a year and a couple works one.

**Consumer, ad funded.** The largest population and the weakest economics: §7
models 250,000 monthly presenters producing $434k/year in total.

### The comparison that should decide the strategy

| | People | Revenue |
|---|---|---|
| Business presenters at 1% | **6,413** | **$1.15M/yr** |
| Consumer presenters (§7) | 250,000 | $434k/yr |

**39× fewer people, 2.7× the revenue.** And 6,413 customers would be 8% of
Mentimeter's 80,000 — aggressive for a niche, but not fantasy against a company
doing $38M in an adjacent category.

That single line argues the product should point at the business presenter, and
that the party use case the landing page leads with is commercially the weakest
of the three. It is also the segment currently blocked by the thing §5 prices:
**37% of a real enterprise deck renders as grey boxes** until Pro exists.

**The counterweight, which does not go away.** Microsoft retired Present Live for
low usage — the closest analogue to the core feature, with a billion-seat
channel, killed for lack of demand. What that argues is not that the segment is
empty but that *audience-follows-along* is the wrong pitch for it. The durable
one is different, and Present Live never offered it: **your deck never lands on
their machine, and everyone in the room sees it on their own screen.**

---

## 3. The free tier and its advertising

### Placements

| # | Placement | Seen by | Per session |
|---|---|---|---|
| 1 | Landing / sign-in page | Everyone who arrives | 1 |
| 2 | Signed-in library page | Presenters | 1 |
| 3 | Viewer page, at the join step | Every screen that watches | 1 |

A show with four screens therefore produces about **six impressions**: two from
the presenter, four from the screens.

### Revenue model

Consumer utility traffic earns a blended **$2.50 RPM** [assumed]; published
ranges are $0.25–$3 for generic sites and $3–12 across AdSense broadly, with
non-Tier-1 traffic earning 50–80% less [sourced]. $2.50 is deliberately near the
bottom of that range because Vinboo's traffic is international, low-intent and
short-session.

### Four honest problems with the ad plan

1. **The app is one page view per session.** The README already notes this: the
   app moves between landing, library and player without navigating, so a whole
   evening of presenting registers as a single view. Three placements is the
   ceiling, not a starting point — there is no scroll feed to add units to.
2. **The viewer page is often a television.** An ad on a TV at a party is
   low-value inventory: nobody clicks it, and it is exactly the kind of
   non-interactive placement ad networks scrutinise. Assume viewer impressions
   monetise **below** presenter impressions, and expect some networks to decline
   the placement entirely.
3. **Consent is a real cost.** EEA and UK traffic needs a certified consent
   platform before a single ad cookie is set. That is engineering work, a vendor
   relationship, and a measurable dent in fill rate.
4. **Ads contradict the product's one strong claim.** Vinboo's position is
   privacy — "nothing is uploaded". Third-party ad tags are the least private
   thing on the internet. This is not fatal, but the E2EE tier and the ad network
   cannot coexist on the same page, and the marketing has to be careful not to
   sound hypocritical.

**Conclusion: treat advertising as a floor that pays for infrastructure, not as
the business.** It covers hosting from early on and becomes meaningful at scale,
but the plan should not depend on it.

---

## 4. Premium tiers

Priced against the anchors above, and limited to things the free architecture
genuinely cannot do — a paid tier that only removes an artificial limit invites
resentment.

**These are not four rungs of one ladder.** Plus is the consumer tier. Pro and
Private branch off it in opposite directions and a customer picks one, because
they cannot coexist — see the note under Private.

### Vinboo Plus — $3.99/month or $29/year

The unattended tier. It closes the single biggest weakness in the competitive
analysis and directly answers Pixo.

- **Shows stored on the server** for their lifetime, so the slideshow survives
  everyone going offline. Today a handed-off show stops being joinable when the
  last screen with a copy switches off.
- **Longer life**: 7 days instead of 48 hours, and more than three standing shows.
- **No photo cap** on hand-off (free is 150).
- **No ads**, anywhere.
- *(QR-code joining was listed here and has instead shipped free for everyone —
  it is table stakes, and paywalling table stakes is how a free tier gets a
  reputation for being crippled.)*

*Why this price:* Pixo is $1.49/month for **one** television and caps at six.
Plus is unlimited screens at $3.99, which beats Pixo outright for anyone with
three or more TVs and reads as inexpensive against Sync at $12.50.

### Vinboo Pro — $15/month or $149/year

The business tier, and a different buyer from everything above: someone who
presents for a living, expenses the tool, and compares it against **Mentimeter at
$11.99–24.99** and **Sync at $12.50** rather than against Pixo. $15 sits inside
that band and is unambiguously a different product from a $3.99 consumer plan.

- **Exact deck fidelity.** The deck is converted server-side by LibreOffice, so
  SmartArt, embedded Visio and Windows metafiles all come through. On the one
  real enterprise deck tested in this repository that is the difference between
  **13 of 35 slides showing a grey box** and none.
- **PDF as an input** — nearly free once a converter exists, and PDF is what most
  people already have to hand.
- **Speaker notes and a presenter view.** Verified missing today, and a real gap
  for anyone presenting professionally.
- **A saved deck library.** A sales rep shows the same deck every week; today
  every show starts from a file picker. This is the feature that creates habit,
  and it is only possible once shows live on the server.
- **Your logo on the viewer page**, not Vinboo's. Cheap to build and it matters
  in front of a client.
- **Who joined, and for how long.** The relay already counts screens. Light
  attendance only — polls and engagement analytics are Sync's category and §4's
  last section says to stay out of it.
- **Team seats.** One champion at a company brings a team rather than a friend,
  which is where expansion revenue comes from.

*Why the bundle matters:* exact rendering alone is not worth $15/month. The
combination of fidelity, notes, a reusable library and branding is.

**Build it by buying it first.** A conversion API costs roughly a fraction of a
cent per deck against **$36–81/month of always-on capacity** self-hosted (§5), and
it avoids the part that should worry you most: **LibreOffice parsing untrusted
uploads is a classic remote-code-execution surface.** Self-hosting it properly
means a sandboxed container with no network, hard memory and time limits and
dropped privileges. Move in-house when volume justifies it — or when a
procurement team objects to the deck touching a third party, which is a better
objection to answer with "our server, deleted after" than with a vendor name.

### Vinboo Private — $8.99/month or $79/year

End-to-end encryption. The competitive analysis is explicit that **no competitor
in the set offers it**, and the design already exists in
[architecture-e2ee.svg](architecture-e2ee.svg).

Sell it as Plus plus a promise: *we hold your slideshow and we cannot open it.*
It also resolves the contradiction in §3.4 — Private carries no ads and no
third-party tags at all.

**Private and Pro are mutually exclusive, and this is not a packaging choice.**
A server has to read a deck in order to convert it. If the slides arrive
encrypted, LibreOffice has nothing to work with, so Private cannot offer exact
fidelity, server-side rendering, or a preview of anything. It is deliberately
*less* capable than Pro, which is why it is cheaper:

| | Pro — $15 | Private — $8.99 |
|---|---|---|
| The fear it answers | "my deck will look wrong" | "my photos will be read" |
| Server can read your files | **yes**, and deletes them after | **no**, ever |
| Exact PowerPoint fidelity | yes | no — own renderer, and the warning when a deck loses something |
| Stored shows survive offline | yes | yes, as ciphertext |

A customer picks one per show. Selling both to the same person on the same
slideshow is not possible, and any marketing that implies otherwise will be found
out on first use.

### Vinboo Event — $19 one-off, 7 days

Weddings, conferences, parties. The analysis names events as a proven
willingness-to-pay segment. A one-off pass converts people who will never take a
subscription, and it is the right shape for the buyer: unlimited screens,
storage, no ads, for one weekend.

### Vinboo Venue — from $6/screen/month

Deliberately deprioritised. It is Yodeck's market, they are established, and it
pulls the product toward digital signage and away from the consumer story. Listed
only so the decision to skip it is on the record.

### What should *not* be paid

Polls, quizzes and engagement analytics — Sync's category, per the analysis. And
video, which should be free when it exists, because its absence is a parity gap
rather than a premium feature.

---

## 5. Infrastructure economics

### Current rates

| Item | Rate | Source |
|---|---|---|
| Railway RAM | **$10.14** /GB-month | derived from $0.00000386/GB/s [sourced] |
| Railway vCPU | **$20.29** /vCPU-month | derived from $0.00000772/vCPU/s [sourced] |
| Railway volume | **$0.158** /GB-month | derived from $0.00000006/GB/s [sourced] |
| Railway egress | **$0.05** /GB — i.e. **$50/TB** | [sourced] |
| Railway ingress | **free** — presenter uploads cost nothing | [sourced] |
| Railway object storage | **$0.015** /GB-month, **free egress** | [sourced] |
| Cloudflare R2 | **$0.015** /GB-month, **free egress**, 10 GB free | [sourced] |
| GitHub | **$0** on Free (unlimited private repos, 2,000 Actions min/mo) | [sourced] |
| Stripe | 2.9% + $0.30 | standard |

GitHub is free at this size and stays under $50/month even with a small team at
$4/user. It is not a cost driver and is not modelled further.

Two details about egress that change how the rate should be read. **Only
outbound traffic is charged**, so the presenter's upload into the relay is free
and only the relay's delivery out to each screen costs anything. And there is
**no free egress allowance** on any plan — the $5 Hobby and $20 Pro credits are
general resource credits that egress simply eats into alongside RAM and CPU.

### What a show actually costs

The wire format is capped at 2560px, JPEG q0.9 [measured — see the README]. A
photograph at that setting is modelled at **350 KB** [assumed]; a real
measurement of 12 photographs at a more aggressive setting (2048px WebP q82) gave
a **145 KB median** [measured], so 350 KB is a deliberately cautious figure.

For a 40-slide show on 4 screens, each screen taking one copy:

- **54.7 MB** of egress per show → **$0.0027**
- Server bookkeeping: **~2.9 KB per show** [measured], held for the show's life
- Relay photo cache: 6 frames, dropped after 5 minutes idle [measured]

Six ad impressions at $2.50 RPM earn **$0.015** per show. So a cached show earns
about **5× what it costs to serve**. The free tier works.

### When egress becomes worth acting on

The reassuring part first: with each slide fetched once, **egress is a fixed
share of revenue rather than a growing one**, because both scale with the number
of screens. It sits at **18% of what a show earns in advertising** and stays
there. Egress does not structurally *become* a problem; only its absolute size
grows.

So the thresholds below are cash-flow milestones, not cliffs:

| Egress bill | Traffic | Shows/month | Presenters |
|---|---|---|---|
| $5 — consumes the whole Hobby credit | 100 GB | ~1,900 | ~940 |
| $20 — consumes the whole Pro credit | 400 GB | ~7,500 | ~3,700 |
| $25 — matches a small compute bill | 500 GB | ~9,400 | ~4,700 |
| $100 | 2 TB | ~37,000 | ~19,000 |
| $500 | 10 TB | ~187,000 | ~94,000 |
| $1,000 | 20 TB | ~374,000 | ~187,000 |

#### The threshold that is a cliff

It is not a scale at all — it is whether the viewer-page ad works. If networks
decline the television placement, which §3 says to expect, revenue falls to the
presenter's two impressions while egress still scales with every screen:

| | Revenue per show | Egress | Egress as a share |
|---|---|---|---|
| Viewer-page ads running | $0.0150 | $0.0027 | 18% |
| Viewer-page ads declined | $0.0050 | $0.0027 | **53%** |

And in that case **a show stops paying for itself above about 7.5 screens** — the
better the product does at its own core promise of unlimited screens, the worse
each show performs. This arrives at any scale, on day one, and it is the reason
the viewer placement should be measured separately from the other two rather than
assumed into the blended figure.

#### The levers, in the order worth pulling

1. **Send fewer bytes.** No migration and no new vendor. The wire is currently
   2560px JPEG q0.9 (~350 KB a slide); the 2048px WebP q82 setting measured at a
   **145 KB median** [measured] would cut **59% off every byte at every scale** —
   $1,335/month becomes $553. The cost is some quality on a large television,
   which is a judgement call rather than a technical one.
2. **Serve stored and premium shows from object storage.** Railway's own is
   $0.015/GB-month with **free egress**, so this is free from the first day and
   has no threshold to wait for. It is also Finding 2 restated: premium traffic
   need never touch the metered path.
3. **Move the relay to a host with included bandwidth.** Railway is **$50/TB**; a
   Hetzner-class VPS includes 20 TB and then charges **$1/TB** [sourced] — 50× on
   marginal bytes. The gap reaches roughly $100/month at about **40,000
   shows/month**, which is where a day of migration pays back within a quarter.
   Below that the saving does not cover losing managed Postgres, deploys and
   health checks.

#### What would invalidate all of this

**Video.** Every figure here assumes photographs. Video is one to two orders of
magnitude more bytes and brings **no additional ad impressions** with it, which
would move egress from a fixed 18% of revenue to the dominant cost of the
business. The competitive analysis lists video as a parity gap worth closing; if
it is closed, this section has to be rewritten before it ships, not after.

### What server-side conversion costs

The Pro tier's anchor feature is the only part of the product that needs real
compute. The arithmetic is unusual: the work itself is free, and the *readiness*
to do it is not.

| | Cost |
|---|---|
| One conversion — 35 slides, ~15 seconds, 1 GB and 1 vCPU | **$0.00017** — about 5,700 per dollar |
| Capacity reserved for one at a time | **$36/month**, used or not |
| Capacity reserved for three at a time | **$81/month**, used or not |
| 10,000 converted decks kept | **$1.03/month**, egress free |

So it is a **fixed floor of roughly $60/month** rather than a per-unit cost, and
**five subscribers at $15 cover it**. Conversions themselves never become the
expense; idle headroom is.

Which is the argument for **not building it first**. A conversion API costs on the
order of a fraction of a cent per deck with a ~$9/month floor [sourced], so a
thousand decks a month runs to about $12 all-in — cheaper than the reserved
capacity, and it avoids standing up a sandbox around a document parser. The
reasons to bring it in-house later are volume, and the day a procurement team
asks where the deck goes.

### Stripe eats low-priced monthly subscriptions

$3.99/month loses **10.4%** to Stripe. The same revenue billed annually at $29
loses **3.9%**. Annual billing should be the default offer and the discount
should be generous, because it is nearly free to give.

---

## 6. The two findings that decide the business

### Finding 1 — live mode's cost scaled with time, not content

**Fixed since this plan was written.** A viewing screen now keeps decoded slides
to a 100 MB budget, measured at 12 network requests for 36 slide-views on a
twelve-photo loop — each photo fetched exactly once. The analysis below is kept
because it is what the numbers in §7 rest on, and because the shape of the
mistake is worth remembering.

A viewer kept only six slides in memory in live mode [previously
`MAX_CACHED = 6` in `public/watch.js`]. Once a show looped past those six, nearly
every advance is a fresh fetch through the relay — so **cost scales with how long
a show runs, not with how much content it holds.**

That is the wrong shape. A slideshow left on a television all evening is the use
case the landing page leads with, and it is precisely the one this punishes.

**Break-even is 19 minutes.** A show earns $0.015 in advertising and costs about
**$0.048 per show-hour** to serve at four screens:

| Show length | Egress | Egress cost | Ad revenue | Net |
|---|---|---|---|---|
| 10 minutes | 156 MB | $0.0076 | $0.0150 | **+$0.0074** |
| 19 minutes | ~300 MB | $0.0147 | $0.0150 | break-even |
| 30 minutes | 484 MB | $0.0236 | $0.0150 | −$0.0086 |
| 1 hour | 976 MB | $0.0477 | $0.0150 | −$0.0327 |
| 3 hours | 2.9 GB | $0.1438 | $0.0150 | **−$0.1288** |

Blended over a realistic mix — 25% ambient at three hours, 35% family
walkthroughs at fifteen minutes, 40% presentations at twenty-five [assumed] — the
average show sends **980 MB where 54.7 MB would do: 18× more than it needs to.**

#### What it does to the model

| At Year 3 (500,000 shows/month) | Egress | Infrastructure | Gross margin |
|---|---|---|---|
| Each slide fetched once | $1,335/mo | $1,535/mo | **96%** |
| Live mode as it stands | $23,932/mo | $24,132/mo | **33%** |
| Worst case, every show 3 hours | $72,000/mo | $72,200/mo | **negative** |

The middle row does not bankrupt the business — it gives away two thirds of gross
margin, and the more successful the party use case becomes the worse the trade
gets. The bottom row is the one that ends it, and the only thing separating the
two is how long people leave shows running, which is not something the business
controls.

#### The fix, and the one thing to watch

Hand-off mode already stores the whole show and fetches each slide exactly once.
Live mode should do the same — but **as a byte budget, not "cache everything"**,
because live mode has no photo cap the way hand-off does:

| Slides held | Memory in the tab |
|---|---|
| 40 | 14 MB |
| 285 | 97 MB |
| 2,000 | 684 MB |

A ~100 MB budget holds about 285 slides, which is more than almost any real show,
while stopping a 2,000-photo folder from exhausting a television's memory — which
is why the cache was small to begin with. **A few hours of work for an 18×
reduction in the dominant cost, and it makes spend depend on content size rather
than on how long the party lasts.**

### Finding 2 — premium is cheaper to serve than free

Object storage is $0.015/GB-month **with free egress**; relayed traffic is
$0.05/GB. So a stored premium show costs almost nothing to serve, while a free
relayed show costs real money every time a screen watches it.

- 50 slides stored = **17 MB per show**; at the 150-photo cap, 51 MB
- **10,000 stored shows = 167 GB = $2.50/month**, egress free

This inverts the usual freemium worry. The premium tier does not need to subsidise
an expensive free tier — it is structurally cheaper. It also means Plus can be
priced on value rather than cost, and that generous storage limits cost nothing to
offer.

---

## 7. Three-year scenarios

Assumes 2 shows per presenter per month, 4 screens per show, 40 slides, $2.50
RPM, **2.5% free-to-paid conversion** (published consumer freemium median is
2.1–5% [sourced]), $3.99/month blended subscription, **and Finding 1 fixed** —
the italic row shows the same scenario if it is not.

| | Year 1 | Year 2 | Year 3 |
|---|---|---|---|
| Monthly active presenters | 5,000 | 50,000 | 250,000 |
| Shows / month | 10,000 | 100,000 | 500,000 |
| Ad impressions / month | 90,000 | 900,000 | 4,500,000 |
| **Ad revenue** | $225/mo | $2,250/mo | $11,250/mo |
| Subscribers @ 2.5% | 125 | 1,250 | 6,250 |
| **Subscription revenue** | $499/mo | $4,988/mo | $24,938/mo |
| **Total revenue** | **$8.7k/yr** | **$87k/yr** | **$434k/yr** |
| Egress | 534 GB → $27 | 5.3 TB → $267 | 26.7 TB → $1,335 |
| Compute (assumed) | $200 | $200 | $200 |
| **Infrastructure** | $227/mo | $467/mo | $1,535/mo |
| **Gross margin** | 69% | 94% | 96% |
| *Margin if Finding 1 is left unfixed* | *6%* | *31%* | *33%* |

Compute is held flat at $200/month because the relay is I/O-bound long-polling,
not CPU-bound: what matters is concurrent open connections, not total volume, and
a single Node process handles thousands. Even tripled for redundancy this stays
under $600/month at Year 3 — trivial beside egress.

**Read the shape, not the numbers.** Year 1 revenue does not pay a salary. This
is a business that works at 50,000+ monthly presenters and is a hobby below that.
The user-acquisition question — not the technology, and not the unit economics —
is what determines whether it gets there, and this plan has nothing to say about
it because there is no data yet.

---

### These scenarios are the consumer shape

Everything above counts *presenters* and monetises them with advertising, which
is the free tier's shape. §2 sizes the business one, and it reaches Year 3's
revenue with **6,413 customers instead of 250,000 presenters** — 39× fewer people
for 2.7× the money, with none of the egress that comes from 500,000 shows a
month.

Both are modelled because they are not exclusive: the free consumer tier is the
funnel and the advertising floor, and Pro is where the revenue is. But if only
one can be pursued, the arithmetic says the smaller audience.

The reason the plan leads with the consumer model anyway is honesty about
readiness: the consumer product **exists and works today**, and the business one
is gated behind deck fidelity that has not been built.

---

## 8. Risks

Carried from the competitive analysis, with financial consequences attached.

| Risk | Consequence | Response |
|---|---|---|
| **Google or Apple ship multi-screen casting** | The TV use case evaporates; ad inventory falls with it | Lean on "nothing uploaded" and PowerPoint, which platforms will not copy |
| **The Present Live signal is right** | Demand is smaller than modelled; every scenario shifts right by years | Validate with the party/event use case, which is a different buyer |
| **Egress is not fixed (Finding 1)** | Losses scale with success | Fix before any growth spend |
| **Ad networks decline the TV placement** | A third of impressions disappear | Model without viewer-page ads as the downside case |
| **Consent compliance** | Engineering cost, lower EEA fill | Budget a CMP before EU traffic matters |
| **Ads undermine the privacy claim** | Weakens the one defensible position | Keep Private tag-free; consider making all paid tiers ad-free |
| **Railway egress at $0.05/GB** | $50/TB, against $1/TB on a VPS with included bandwidth | Cut wire bytes first (−59%, no migration); object storage for premium; move the relay above ~40,000 shows/month — see §5 |
| **Viewer-page ads declined** | Egress goes from 18% to 53% of ad revenue, and a show above ~7.5 screens loses money | Measure that placement separately from day one; it is the one threshold that does not wait for scale |

---

## 9. Sequencing

1. ~~**Fix live-mode caching.**~~ **Done.** A 100 MB byte budget, verified at 12
   requests for 36 slide-views. This was the dominant running cost.
2. ~~**QR-code joining.**~~ **Done**, and free rather than part of Plus. The code
   carries a single-use ticket, so nothing reusable is in the URL.
3. **Ads and consent.** Landing and library placements first; treat the viewer
   placement as an experiment and measure it separately.
4. **Vinboo Plus.** Server-stored shows, longer life, no ads. This is the first
   real revenue and it answers Pixo directly.
5. **Vinboo Pro**, if the business segment validates. Buy the conversion rather
   than building it, and lead with exact fidelity plus a saved deck library.
6. **Vinboo Event.** Cheap to build once Plus exists — it is Plus with a clock.
7. **Vinboo Private.** The E2EE tier. Highest engineering cost, strongest
   position, and the only feature here that no competitor can answer quickly.
   Note that it forecloses Pro's rendering for anyone who takes it.
8. **Video.** Free tier, parity, only if the party use case is being taken
   seriously.

---

## 10. Assumptions register

Replace these with real data as soon as any exists; the plan is only as good as
they are.

**Measured in this repository:** wire format 2560px/JPEG q0.9; 145 KB median for
12 real photographs at 2048px WebP q82; ~2.9 KB session bookkeeping per show;
relay cache of 6 frames dropped after 5 minutes idle; live-mode client cache of 6
slides.

**Sourced:** Railway, Cloudflare R2, GitHub and Mentimeter pricing; Mentimeter's
270M/14M participant-to-presenter figures and $38M revenue; AdSense RPM ranges;
consumer freemium conversion benchmarks; Present Live's retirement.

**Assumed, and least reliable:** that 40% of sales representatives carry a deck
into a client meeting — the segment sizing in §2 scales directly with it, and it
is a guess rather than a measurement; that a 35-slide conversion takes about 15
seconds in 1 GB — plausible for headless LibreOffice but unmeasured here, and the
capacity floor moves with it; 350 KB per slide on the wire — the egress
thresholds in §5 move in direct proportion to it, so it is the single number most
worth replacing with a real measurement of real photographs; $2.50 blended RPM;
2.5% conversion; 4 screens per show; 40 slides per show; 2 shows per presenter per
month; $200/month compute; and every user-count figure in §7 — those are
scenarios chosen to show the shape of the model, not forecasts.

**Unknown and material:** customer acquisition cost, retention, and whether
anyone wants this at all. Nothing in this plan addresses distribution, and
distribution is the thing most likely to decide the outcome.

---

## Sources

- [Railway pricing](https://railway.com/pricing)
- [Railway plans and per-unit rates](https://docs.railway.com/reference/pricing/plans) (egress only, no included allowance)
- [CloudConvert pricing](https://www.capterra.com/p/157495/CloudConvert/) — conversion-API floor and per-minute rate
- [Hetzner Cloud](https://www.hetzner.com/cloud/) — 20 TB included, then ~$1/TB, per [2026 pricing summaries](https://onedollarvps.com/pricing/hetzner-cloud-pricing)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [GitHub pricing](https://github.com/pricing)
- [US Bureau of Labor Statistics — wholesale and manufacturing sales representatives](https://www.bls.gov/ooh/sales/wholesale-and-manufacturing-sales-representatives.htm) (1.3M + 303,200 jobs, 2024)
- [US wedding volume, ~2.5M a year](https://www.zippia.com/advice/wedding-industry-statistics/)
- [Mentimeter plans](https://www.mentimeter.com/plans)
- [Mentimeter revenue and customer figures — GetLatka](https://getlatka.com/companies/mentimeter)
- [Mentimeter — Wikipedia](https://en.wikipedia.org/wiki/Mentimeter) (270M participants / 14M presenters, end of 2021)
- [Freemium conversion benchmarks — Artisan Strategies](https://www.artisangrowthstrategies.com/blog/freemium-conversion-rate-benchmarks)
- [The 2026 free-to-paid conversion report — Growth Unhinged](https://www.growthunhinged.com/p/free-to-paid-conversion-report)
- [Display ad RPM by niche 2026 — ToolSignal](https://toolsignal.site/articles/blog-display-ad-rpm-by-niche-2026)
- [AdSense RPM benchmarks — Adstimate](https://adstimate.com/blog/highest-paying-adsense-niches.html)
- Competitor pricing and the Present Live retirement: see [competitive-analysis.md](competitive-analysis.md)
