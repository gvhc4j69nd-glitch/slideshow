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
signed-in library, and the viewer page. Premium subscriptions remove the ads and
add the things the free architecture cannot do: a show that survives everyone
going offline, end-to-end encryption, and event-scale use.

**The finding that matters most.** Ads are not the business. At a realistic
consumer display RPM, ads produce roughly a third of revenue at scale and cover
infrastructure comfortably — but subscriptions produce the rest. Modelled at
250,000 monthly presenters: **$135k/year advertising, $299k/year subscriptions,
$18k/year infrastructure.**

**The finding that could sink it.** In live mode a viewer holds only six slides
in memory, so a long-running show re-fetches the same photos through the relay
all evening. At scale that is **$72,000/month of egress against $36,000/month of
revenue** — the free tier would cost twice what the whole business earns. Making
a viewer keep the whole show, which hand-off mode already does, cuts it **53×**
to $1,368/month. This is a few hours of work and it is the single highest-value
engineering task in this document.

**The pleasant surprise.** Premium is *cheaper to serve than free*. Object
storage costs $0.015/GB-month with free egress on both Railway and Cloudflare
R2, while relayed traffic costs $0.05/GB. A stored premium show serves at
near-zero marginal cost; a free relayed show does not. Ten thousand stored
slideshows cost **$2.50/month** to keep.

---

## 2. What the competition proves

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

### Vinboo Plus — $3.99/month or $29/year

The unattended tier. It closes the single biggest weakness in the competitive
analysis and directly answers Pixo.

- **Shows stored on the server** for their lifetime, so the slideshow survives
  everyone going offline. Today a handed-off show stops being joinable when the
  last screen with a copy switches off.
- **Longer life**: 7 days instead of 48 hours, and more than three standing shows.
- **No photo cap** on hand-off (free is 50).
- **No ads**, anywhere.
- **QR-code joining** — table stakes that every direct competitor already has.

*Why this price:* Pixo is $1.49/month for **one** television and caps at six.
Plus is unlimited screens at $3.99, which beats Pixo outright for anyone with
three or more TVs and reads as inexpensive against Sync at $12.50.

### Vinboo Private — $8.99/month or $79/year

End-to-end encryption. The competitive analysis is explicit that **no competitor
in the set offers it**, and the design already exists in
[architecture-e2ee.svg](architecture-e2ee.svg).

Storing photos on a server (Plus) and being unable to read them (Private) is a
natural bundle: the same feature that makes the show survive offline is the one
that creates the privacy exposure, and encryption is the answer to it. Sell
Private as Plus plus a promise: *we hold your slideshow and we cannot open it.*

This tier also resolves the contradiction in §3.4 — Private carries no ads and no
third-party tags at all.

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
| Railway egress | **$0.05** /GB | [sourced] |
| Railway object storage | **$0.015** /GB-month, **free egress** | [sourced] |
| Cloudflare R2 | **$0.015** /GB-month, **free egress**, 10 GB free | [sourced] |
| GitHub | **$0** on Free (unlimited private repos, 2,000 Actions min/mo) | [sourced] |
| Stripe | 2.9% + $0.30 | standard |

GitHub is free at this size and stays under $50/month even with a small team at
$4/user. It is not a cost driver and is not modelled further.

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

### Stripe eats low-priced monthly subscriptions

$3.99/month loses **10.4%** to Stripe. The same revenue billed annually at $29
loses **3.9%**. Annual billing should be the default offer and the discount
should be generous, because it is nearly free to give.

---

## 6. The two findings that decide the business

### Finding 1 — live mode re-fetches, and at scale that is fatal

A viewer keeps only six slides in memory in live mode [measured:
`MAX_CACHED = 6` in `public/watch.js`]. A 40-photo show looping for three hours
at five seconds a slide is 2,160 slide-views per screen, and nearly every one of
them is a fresh fetch through the relay.

| | Per show | At 500,000 shows/month |
|---|---|---|
| Live mode, 3-hour loop | 2.88 GB | **1,440 TB → $72,000/month** |
| One copy per screen | 54.7 MB | 27.4 TB → **$1,368/month** |

**$72,000/month against $36,000/month of revenue.** The free tier would cost
twice what the entire business earns, and the harder people used it the worse it
would get.

The fix is small. Hand-off mode already stores the whole show in the browser's
Cache API and fetches each slide exactly once; live mode should do the same, or
at minimum raise its in-memory cache to cover the whole playlist. A 40-photo show
is ~14 MB in the browser — nothing. **This is the highest-value engineering task
in this plan: a few hours of work for a 53× reduction in the dominant cost.**

### Finding 2 — premium is cheaper to serve than free

Object storage is $0.015/GB-month **with free egress**; relayed traffic is
$0.05/GB. So a stored premium show costs almost nothing to serve, while a free
relayed show costs real money every time a screen watches it.

- 50 slides stored = **17 MB per show**
- **10,000 stored shows = 167 GB = $2.50/month**, egress free

This inverts the usual freemium worry. The premium tier does not need to subsidise
an expensive free tier — it is structurally cheaper. It also means Plus can be
priced on value rather than cost, and that generous storage limits cost nothing to
offer.

---

## 7. Three-year scenarios

Assumes 2 shows per presenter per month, 4 screens per show, 40 slides, $2.50
RPM, **2.5% free-to-paid conversion** (published consumer freemium median is
2.1–5% [sourced]), $3.99/month blended subscription, and Finding 1 fixed.

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
| **Railway egress at $0.05/GB** | Above commodity rates; 26.7 TB/mo is $1,335 that a cheaper host or object storage would not charge | Serve premium from object storage; revisit host if free-tier egress dominates |

---

## 9. Sequencing

1. **Fix live-mode caching.** A few hours. Removes a cost that would otherwise
   grow to twice revenue. Do this before anything else.
2. **QR-code joining.** A day's work, closes a table-stakes gap named in the
   analysis, and makes the TV experience bearable. Free tier.
3. **Ads and consent.** Landing and library placements first; treat the viewer
   placement as an experiment and measure it separately.
4. **Vinboo Plus.** Server-stored shows, longer life, no ads, QR. This is the
   first real revenue and it answers Pixo directly.
5. **Vinboo Event.** Cheap to build once Plus exists — it is Plus with a clock.
6. **Vinboo Private.** The E2EE tier. Highest engineering cost, strongest
   position, and the only feature here that no competitor can answer quickly.
7. **Video.** Free tier, parity, only if the party use case is being taken
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

**Assumed, and least reliable:** 350 KB per slide on the wire; $2.50 blended RPM;
2.5% conversion; 4 screens per show; 40 slides per show; 2 shows per presenter per
month; $200/month compute; and every user-count figure in §7 — those are
scenarios chosen to show the shape of the model, not forecasts.

**Unknown and material:** customer acquisition cost, retention, and whether
anyone wants this at all. Nothing in this plan addresses distribution, and
distribution is the thing most likely to decide the outcome.

---

## Sources

- [Railway pricing](https://railway.com/pricing)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [GitHub pricing](https://github.com/pricing)
- [Mentimeter plans](https://www.mentimeter.com/plans)
- [Mentimeter revenue and customer figures — GetLatka](https://getlatka.com/companies/mentimeter)
- [Mentimeter — Wikipedia](https://en.wikipedia.org/wiki/Mentimeter) (270M participants / 14M presenters, end of 2021)
- [Freemium conversion benchmarks — Artisan Strategies](https://www.artisangrowthstrategies.com/blog/freemium-conversion-rate-benchmarks)
- [The 2026 free-to-paid conversion report — Growth Unhinged](https://www.growthunhinged.com/p/free-to-paid-conversion-report)
- [Display ad RPM by niche 2026 — ToolSignal](https://toolsignal.site/articles/blog-display-ad-rpm-by-niche-2026)
- [AdSense RPM benchmarks — Adstimate](https://adstimate.com/blog/highest-paying-adsense-niches.html)
- Competitor pricing and the Present Live retirement: see [competitive-analysis.md](competitive-analysis.md)
