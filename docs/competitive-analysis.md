# Competitive analysis — Vinboo

*August 2026. Competitive detail goes stale quickly; pricing and feature claims
below are as advertised on vendors' own pages at the time of writing.*

## The short version

Vinboo sits between two markets that barely overlap:

- **Slide-sync tools** (ShowSlide, Sync, PowerPoint Live) put *your deck* on the
  audience's own devices. They do not do photos, and they need your file.
- **Photos-to-TV tools** (Pixo, TVYou, Chromecast apps) put *your photos* on
  televisions. They upload to a cloud and they are ambient, not presenter-driven.

Nothing found does both, and nothing found streams from the presenter's own
device without uploading first. That gap is real and defensible.

The uncomfortable finding is in the other direction: **the landing page leads
with the use case the architecture is worst at**, and the biggest company to
ship this exact feature retired it for lack of use.

---

## The competitive set

### Direct — audience follows your slides on their own device

| Product | Model | Price | Notes |
|---|---|---|---|
| [ShowSlide](https://showslide.com/) | Markdown decks, live session, QR to join | Free tier, paid upgrades | Audience needs no app or login. Live highlighting, embed anywhere. |
| [Sync](https://synclive.io/) | Live presentation + audience interaction | From $12.50/mo | AI-generated polls and quizzes, real-time engagement analytics. Positions against Mentimeter. |
| [Slides.com](https://slides.com/features) | Deck hosting + live broadcast | Free tier, paid plans | Broadcast to any audience size, viewers anywhere. |
| [PowerPoint Present Live](https://support.microsoft.com/en-US/PowerPoint/present-live-engage-your-audience-with-live-presentations) | QR/short URL, audience follows | Included with M365 | **Being retired.** Microsoft announced deprecation in May 2025 citing low usage; still functioning in early 2026. |
| [PowerPoint Live in Teams](https://support.microsoft.com/en-us/teams/meetings/share-slides-in-microsoft-teams-meetings-with-powerpoint-live) | Slides inside a Teams meeting | Included with M365 | The official replacement. Richer, but requires a Teams meeting and Microsoft accounts. |
| [reveal.js multiplex](https://revealjs.com/multiplex/) | Open-source plugin, master controls clients | Free, self-hosted | Closest technical analogue. Requires running a socket.io server and hosting the deck **publicly**. Developer-only. |

### Direct — photos on one or more televisions

| Product | Model | Price | Notes |
|---|---|---|---|
| [Pixo](https://pixo.life/) | Phone app + TV app, cloud-synced | From $1.49/mo **per TV** (~$15/yr) | Up to 3 or 6 TVs "anywhere in the world". Explicitly markets *"no need to keep the app open"*. |
| [TVYou](https://apps.apple.com/app/tvyou/id6756995528) | Upload, build slideshow, push to TVs | App store pricing | One-tap push to multiple TVs. |
| [PartyMeister](https://apps.apple.com/us/app/-/id1542623897) | Guests' photos onto a party TV | App store pricing | Event-specific: live guest photo wall. |
| [Photo Video Cast to Chromecast](https://apps.apple.com/us/app/-/id733144626) | Cast with multicast option | Freemium | Multicast to several TVs at once. |
| [Yodeck](https://www.yodeck.com/use-cases/how-to-play-slideshow-on-tv/) and digital signage | Central dashboard → many screens | Per-screen subscription | Built for venues, not living rooms. |

### Indirect — what people actually do today

- **Chromecast / AirPlay**: free, built in, no account. One screen at a time, same
  Wi-Fi only. This is the true default and the hardest competitor to beat.
- **Google Photos / Apple Shared Albums**: cloud, asynchronous, everyone browses
  at their own pace. Solves "share the photos", not "show them together".
- **Zoom / Meet / Teams screen share**: works today, everyone knows it, but it is
  a meeting, it streams video, and it is heavy for showing holiday snaps.
- **Digital photo frames** (Nixplay, Aura, Skylight): hardware, cloud, ambient.
- **[Proton](https://proton.me/blog/share-photos-online-privately) and private
  album apps**: own the privacy claim, but with real encryption and permanence.

### Substitutes

A USB stick in the TV. An HDMI cable. Handing the phone around. Posting to the
family WhatsApp group. These are free, understood by everyone, and lose almost
nothing for a dozen photos — the real competition for casual use.

---

## Feature comparison

Rated on what matters to the buyer, not feature count.

| Capability | Vinboo | ShowSlide / Sync | Pixo / TV apps | Chromecast / AirPlay |
|---|---|---|---|---|
| **Getting content in** | | | | |
| Photos from a phone camera roll | Strong | Absent | Strong | Strong |
| A folder of photos with subfolders | Strong | Absent | Adequate | Weak |
| PowerPoint | Adequate (no charts, no animation) | Strong (own format) | Absent | Weak |
| Video | **Absent** | Weak | Adequate | Strong |
| **Showing it** | | | | |
| Many screens at once | Strong (unlimited) | Strong | Adequate (plan-capped) | Weak (one) |
| Viewers need no account or app | Strong | Strong | **Weak** (TV app required) | Strong |
| Works beyond the local network | Strong | Strong | Strong | **Absent** |
| Presenter drives every screen | Strong | Strong | Absent (ambient) | Adequate |
| Leave it running unattended | **Absent** | Absent | **Strong** | Strong |
| Join by QR code | **Absent** | Strong | n/a | n/a |
| **Trust** | | | | |
| Files never uploaded | **Strong (unique)** | Absent | Absent | Strong (local) |
| End-to-end encrypted | Absent | Absent | Absent | n/a |
| Nothing retained afterwards | Strong | Weak | Absent | Strong |
| **Around the edges** | | | | |
| Polls, Q&A, audience interaction | Absent | **Strong** | Absent | Absent |
| Engagement analytics | Absent | **Strong** (Sync) | Absent | Absent |
| Replay or persistent album | Absent | Adequate | Strong | Absent |
| Price | Free (self-hosted) | $0–12.50/mo | ~$1.49/mo per TV | Free |

---

## Positioning

**Vinboo today**: *For someone who wants their photos or slides on every screen
at once, Vinboo is a browser-based slideshow broadcaster that streams from your
own device. Unlike cloud photo apps and presentation tools, nothing is uploaded
and viewers need no account.*

How the others claim their ground:

- **Sync** — the *interaction* layer. Polls, quizzes, engagement data. Competing
  with Mentimeter, not with photo sharing.
- **ShowSlide** — *live and editable*. Change a slide mid-session and every
  screen updates. Markdown-native, aimed at technical presenters.
- **Pixo** — the *ambient frame*. Any screen becomes a photo frame, set and
  forget, family members anywhere.
- **Chromecast/AirPlay** — *already on your device and free*.

**Unclaimed ground Vinboo could own**: "your photos never leave your phone." No
competitor in this set makes that claim, because none of them are built to. It
is the one position that is architecturally defensible rather than a feature
anyone could copy in a sprint.

---

## Strengths

1. **Nothing is uploaded.** Genuinely differentiated. Every competitor found
   requires your content in their cloud first.
2. **Photos *and* PowerPoint in one tool.** The slide-sync tools have no photo
   story; the TV apps have no deck story.
3. **No per-screen cost and no cap.** Pixo charges per TV and caps at six.
4. **Works beyond the local network**, which AirPlay and Chromecast cannot.
5. **Viewers need nothing** — no account, no app, any browser. Matches the best
   of the slide-sync tools and beats every TV app.
6. **Nothing is retained**, so there is no library to leak or curate later.

## Weaknesses

1. **The presenting tab must stay open and awake.** This is the big one. Pixo
   advertises the opposite as a headline feature. For a party — photos running
   on the TV all evening — this architecture is actively the wrong shape.
2. **The presenter's upload is the bottleneck.** A cloud CDN serving ten TVs is
   not constrained by a home connection; Vinboo is.
3. **No video.** Common in both photo sharing and presentations.
4. ~~**No QR code to join.**~~ **Closed.** The share dialog shows a QR carrying a
   single-use ticket, so a screen joins without typing anything.
5. **No audience interaction or analytics.** Sync's entire business.
6. **PowerPoint fidelity is approximate** — no charts, SmartArt or animation.
7. **Privacy positioning outruns the implementation.** The pitch says "your files
   stay yours", but the service is not end-to-end encrypted and could be.
8. **No brand, no distribution, no reviews.** Every competitor has app-store
   presence or an existing user base.

---

## Opportunities

- **The unattended gap.** Nobody offers "nothing uploaded" *and* "leave it
  running". Solving it — a lightweight always-on mode, or a phone that keeps
  serving with the screen off — would remove the single biggest objection.
- **Microsoft is leaving the standalone niche.** Present Live is being retired
  and the replacement requires a Teams meeting. Anyone who wants audience-follows-
  along *without* a meeting now has fewer options.
- ~~**QR codes are cheap and expected.**~~ **Done** — a generated QR sits beside
  the share code and carries a single-use ticket rather than the credentials.
- **End-to-end encryption is unclaimed here.** No competitor in this set offers
  it. The design sketch already exists in this repo; shipping it would make the
  privacy claim unassailable rather than merely accurate.
- **Events and weddings** are a proven willingness-to-pay segment (PartyMeister,
  guest-photo apps) and align with the multi-screen strength.

## Threats

- **Google and Apple can close this with a feature.** Multi-target casting is a
  platform capability, not a product. If Chromecast adds it, the TV use case
  evaporates.
- **The "low usage" signal.** Microsoft retired the closest analogue because
  people did not use it. That is real evidence that "audience follows on their
  own device" may be a smaller want than it appears.
- **Sync and ShowSlide can add images faster than Vinboo can add polls,
  analytics, and a brand.**
- **Free defaults are strong.** Chromecast, AirPlay, and a USB stick are free,
  installed, and understood.

---

## Strategic implications

**Differentiate on:** nothing uploaded, unlimited screens, photos *and* decks in
one tool. These are architectural, not features to be copied in a quarter.

**Reach parity on:** video, if the party use case is to be taken seriously.
QR-code joining is done.

**Decide deliberately about the party use case.** The landing page leads with
"photos on every TV all evening", which is precisely what a tab-must-stay-open
architecture handles worst, and precisely what Pixo built its product around. Two
honest options: build an unattended mode, or move the presenting use cases —
family walkthrough, remote presentation — to the front and let parties be a
secondary story.

**Do not chase** polls, quizzes and engagement analytics. That is Sync's
category, they are ahead, and it pulls toward a different buyer.

**Watch:** whether Chromecast or AirPlay ship multi-screen; whether Sync or
ShowSlide add photo albums; what replaces Present Live for people who do not use
Teams.
