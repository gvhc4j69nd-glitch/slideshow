# Vinboo — Architecture Review for Scale

**Date:** 17 August 2026
**Scope:** the deployed relay architecture, evaluated against the adoption curve
in the five-year business plan.
**Reviewed against:** `lib/broadcast.js`, `server.js`, `lib/db.js`,
`migrations/0001_init.sql`, and §7 of the business plan.

---

## 1. Summary

The current build is a correct, well-tested single-node system, and that was the
right thing to build first. It is not yet a system that survives its own business
plan.

One Node process holds every broadcast in resident memory. `Sessions` in
`lib/broadcast.js` is a plain `Map`, and the database schema contains only
`users`, `app_settings` and `feedback` — **no show state is persisted anywhere.**
That single fact drives most of what follows: it caps the service at one
instance, at 200 concurrent shows, and at the lifetime of a single container
process.

None of the remedies are expensive. The fix is routing and a small amount of
persistence, not a rewrite, and it is cheap precisely because the state model is
clean and the code is small — 2,243 lines across the server and its libraries.

### Findings at a glance

| # | Finding | Severity | Effort to fix |
|---|---|---|---|
| 1 | Cannot run more than one instance | Blocking | Days |
| 2 | 200-session cap breached by Year 3 model | Blocking | Hours, after 1 |
| 3 | Every deploy destroys every running show | Blocking | Days |
| 4 | Conversion tier would stall the relay | Standing constraint; tier no longer planned | Design decision |
| 5 | Socket volume and denial-of-service surface | Serious | Days |
| 6 | Per-session cache budget is 64 MB | Moderate | Hours |

**One open question, in §6:** the routing this depends on needs a platform that
can send a named request to a named instance. A load balancer spreading requests
across identical replicas — the usual meaning of scaling a service — would break
the design rather than implement it. Worth confirming before the work is planned
rather than after.

---

## 2. What the architecture is

A viewer asks for a slide. Rather than answering, the server parks that request,
hands the job to the presenter's browser on its long-poll, and fans the single
reply out to everyone waiting on the same slide. Bytes exist in server memory
only while in flight.

This is an elegant design and it is the source of the product's commercial
advantage. It is also, as built, inseparable from a single process: the parked
request and the presenter's poll must meet **inside the same instance's memory.**

---

## 3. Blocking issues

### Finding 1 — The service cannot run more than one instance

This is the ceiling on everything else.

Put a second container behind an ordinary load balancer and roughly half of all
requests land on an instance that has never heard of the show. There is no shared
state, no pub/sub, and no request affinity. This is not a scaling problem to be
addressed later; it is a scaling impossibility until routing changes.

Every other capacity number in this review is therefore a **per-service** limit,
not a per-instance one.

### Finding 2 — The 200-session cap is breached by the plan's own Year 3 figures

`MAX_SESSIONS = 200` in `lib/broadcast.js` throws a 503 — "Too many live
slideshows right now" — globally across the service.

The business plan projects **500,000 shows per month** at Year 3. Assuming a
30-minute average show [assumed]:

| Step | Value |
|---|---|
| Shows per month | 500,000 |
| Show-hours per month at 30 min | 250,000 |
| Hours in a month | 730 |
| **Mean concurrent sessions** | **342** |

That exceeds the cap at the *mean*, before any allowance for peaking. Consumer
traffic concentrates in evenings and at weekends; a 5× peak-to-mean ratio
[assumed] puts the busy hour near 1,700.

**Hand-off makes this substantially worse, from a feature that is idle.** A
hand-off session occupies a slot for its *time-to-live*, not its runtime — up to
48 hours. If 5% of shows are hand-off at an average 24-hour TTL [assumed]:

| Step | Value |
|---|---|
| Hand-off shows per month | 25,000 |
| Slot-hours at 24 h each | 600,000 |
| **Mean concurrent sessions from hand-off alone** | **822** |

Four times the cap, held by shows that are not playing. Combined mean occupancy
is roughly 1,164 sessions against a ceiling of 200 — a shortfall of about 6× at
the mean and 20–30× at peak. Users would meet the 503 while the service is
substantially idle.

### Finding 3 — Every deploy destroys every running show

With no persistence, a container restart ends all live broadcasts and all
handed-off shows. That includes routine deploys, out-of-memory kills, and
platform events outside the company's control.

Hand-off is sold to users on a one-to-48-hour promise. That promise currently
survives only as long as the operating system process does. The second-order
consequence matters more than the first: **there is no way to ship a fix without
breaking the feature**, which discourages exactly the frequent, small deploys a
young product needs.

### Finding 4 — Server-side conversion must not run on the relay process

**Superseded in practice, kept as a standing constraint.** When this was written,
server-side conversion was the item the funding was sought for. It is no longer
planned: the browser renderer now draws 98% of slides across 32 real corporate
decks, so the fidelity that justified a converter is reached without one. See
`rendering-gap.md`.

The constraint below still binds the day anything CPU-bound is added — PDF input
being the most likely candidate — so it stays on the list rather than being
deleted.

This was pre-emptive rather than a defect in the current build.

LibreOffice conversion costs seconds of CPU per deck. Node is single-threaded,
and the relay is thousands of parked connections on one event loop. A single
synchronous conversion stalls **every** long-poll on that instance for its
duration.

If conversion is added in-process, it will take down the product it was meant to
unblock. It requires a separate worker tier with its own queue and its own
scaling behaviour, and that should be settled as a design decision before any of
it is written.

### Finding 5 — Socket volume and the denial-of-service surface

At Year 3 mean concurrency, roughly 1,164 sessions at four screens each is about
4,700 permanently open long-polls; a busy hour exceeds 20,000. Each re-polls
every 25 seconds, so sustained request rates reach several hundred per second
purely to keep connections parked.

Node itself is well suited to this — the workload is I/O-bound, which is why the
plan holds compute flat at $200/month. The limits that bind first are elsewhere:
file-descriptor ceilings, and the platform proxy in front of the application.

Two settings compound the exposure. `server.requestTimeout = 0` disables request
timeouts — necessary for long-polling, but it means a stalled request is never
reclaimed. The rate limiter is in-memory, so it resets on every restart and would
not span instances once Finding 1 is addressed.

### Finding 6 — The per-session cache budget is 64 MB

`MAX_CACHE_BYTES` is applied per session rather than globally. At the 200-session
cap the theoretical worst case is 12.8 GB resident.

In practice the six-frame limit binds first: six frames at roughly 1.5 MB of
normalised wire image is about 9 MB per session, or 1.8 GB at full occupancy.
That is still material on a modest container, and it is worth noting that the
frame count is what protects the process, not the byte budget.

---

## 4. What is well built

An even-handed review should record these, because three of them are better than
is typical at this stage.

**The hot path never touches Postgres.** Relay traffic is pure memory. The
database — normally the first component to fall over under load — will not be the
bottleneck at any volume contemplated in the plan. The pool maximum of 10 is
appropriate.

**Authentication is stateless.** HMAC-signed session cookies carry no server-side
state, so sign-in scales horizontally for free the moment routing is fixed.

**Fan-out gives sublinear egress.** Ten screens on one slide cost one upload.
Bandwidth grows with *shows*, not with *audience*, which is the inverse of every
store-and-distribute competitor. This is a durable architectural advantage rather
than a cost trick, and it is what makes unlimited-screens pricing defensible
against per-screen competitors.

**Migrations are correctly serialised** under a Postgres advisory lock, so
concurrent instances cannot race them — a discipline that will matter as soon as
there is more than one instance.

---

## 5. Remediation

### Persist the session record, not the bytes — first

**Everything else depends on this one.** It is the only step that costs users
a running show, and until it is done every later deploy costs them one too.

Screens hold their own copies and can seed one another, so durability is only
needed for the show's metadata: code, mode, expiry, owner, slide count. Writing
that to Postgres converts hand-off from a promise the platform cannot keep into
one it can, and it decouples deployment from user-visible breakage.

The photo bytes should remain ephemeral. That is the product's central claim and
it should not be traded away for operational convenience.

### Shard by show code at the edge

The six-character show code is a natural partition key, and the routing that
follows from it is why this is a change of plumbing rather than a rewrite. The
code sits at a fixed position in the URL path on every request that touches an
existing show:

```
/api/watch/{CODE}/state          /api/broadcast/{CODE}/extend
/api/watch/{CODE}/photo/:i       /api/broadcast/{CODE}/progress
/api/watch/{CODE}/requests       /api/broadcast/{CODE}/join-code
/api/watch/{CODE}/frame/:id
```

That is the whole hot path — every long-poll and every slide byte. A router can
choose an instance by reading one path segment, with no body parsing and no
state of its own. `MAX_SESSIONS` then becomes a per-instance figure rather than
a global one, and the ceiling multiplies by the size of the fleet.

The alternative — moving session state into Redis with pub/sub — is the
conventional answer and is the wrong one here. It adds a network hop to the byte
path and discards the property that makes the relay fast. Route the traffic
instead of centralising the state.

#### Record the owner; do not hash it

**This corrects the first version of this document, which said to consistent-hash
the code.** Write `code → instance` to Postgres when the show is created and have
the router read that table instead.

The difference shows up the moment capacity changes. Hashing reshuffles some
proportion of keys whenever the fleet grows or shrinks, and a reshuffled key is a
*live show* whose state is in another process's memory. A recorded owner never
moves an existing show: adding an instance affects only shows created afterwards.
Codes are immutable and short-lived, so the router can cache the table hard.

#### Three requests that do not carry the code in the path

Each needs its own answer and each is easy to miss.

**`POST /api/watch/join`** takes the code in the JSON **body**
(`server.js`, `handleWatchJoin`), so a path-based router cannot see it. Move it
to `/api/watch/{CODE}/join` — a small change on both sides — or accept the join
anywhere and redirect.

**`POST /api/broadcast`** creates a show, so there is no code yet; the server
generates one. Whichever instance serves that request has to end up owning it,
which a recorded owner handles naturally: the instance writes itself into the
table as it generates the code.

**`GET /api/broadcast/mine`** calls `listForUser`, which scans `this.sessions` in
**one process** (`lib/broadcast.js`). Once a user's shows can live on different
instances this silently returns a partial list — their own shows begin
disappearing from their library, with no error anywhere. Persisting the session
record fixes it for free, which is another reason persistence comes first.

### Is any of this seamless for users?

**In the steady state, yes — invisibly so.** Same URLs, same protocol, same
behaviour; a show lives entirely on one instance exactly as it does today.

**Getting there is not, and the order decides how much anyone notices.** The
reason is Finding 3: with no persistence, the deploy that introduces any of this
destroys every live and handed-off show. Hand-off TTLs run to 48 hours, so there
is no quiet window to wait for — the system is never empty.

What makes the rest of it painless is a property the protocol already has:
**long-polling is self-healing.** A viewer whose connection is cut re-polls
within 25 to 30 seconds and cannot distinguish a dropped connection from a slow
one. Once session records survive a restart, a restart stops being a failure and
becomes a pause of at most one poll interval. Parked requests and the frame cache
are lost with the process, and should be — they are ephemeral by design.

| Step | What users see |
|---|---|
| 1. Persist the session record | Every running show ends — **the last time this happens** |
| 2. Move `join` into the path, record ownership | Nothing |
| 3. Router in front of a *single* instance | A stall of up to one poll interval |
| 4. Add instances | Nothing — recorded ownership leaves existing shows alone |
| Steady state | Nothing; one instance restarting stalls 1/N of shows for one poll |

Step 3 is deliberately a deploy that changes no behaviour: it proves the routing
path with only one place for traffic to go.

#### Where seamless genuinely stops

Two limits worth stating rather than discovering.

**An instance dying takes its shows with it** until something reassigns them. The
records survive in Postgres, but a new owner has to claim them and the router has
to learn the change. Viewers stall rather than lose the show — but the length of
that stall is however long health-checking and reassignment take, and that is
real work rather than a free consequence of sharding.

**A show cannot move while it is running.** The presenter's parked long-poll is
in one process's memory. An instance can be drained by refusing new shows and
waiting for the existing ones to expire, but with 48-hour hand-off TTLs that is
measured in days.

### Separate any conversion tier before building it

No longer on the roadmap — the browser renderer removed the need — but if PDF
input or anything else CPU-bound arrives, it needs a queue and a distinct worker
service, sized independently of the relay.

### Sequencing

| Order | Work | Why first |
|---|---|---|
| 1 | Persist session records | Unblocks safe deploys, fixes `mine` across instances, and is the only step users lose shows to |
| 2 | Move `join` into the path; record `code → instance` | No behaviour change; makes the code routable |
| 2b | Router in front of one instance, then add more | Removes the hard ceiling; invisible after the first stall |
| 3 | Per-IP connection limits, shared rate limiting | Only meaningful once multi-instance |
| 4 | ~~Conversion worker tier~~ | No longer planned — see Finding 4 |

Items 1 to 3 are prerequisites to the adoption curve the business plan projects,
not optimisations. They are days of work rather than months.

---

## 6. Can the platform host this?

The design above says how to shard. It says nothing about whether the place this
runs can do it, which is a gap worth closing before anyone commits to the plan.

### What is deployed today

One instance, one region. `railway.json` sets a Nixpacks build, `npm start`, and
a `/healthz` check; it carries no replica or region settings, so the service runs
at the platform default. Every response comes back from `jfk1` — US East.

Source of truth is GitHub; Railway builds from it on push and holds no code. What
is *only* on the platform is the Postgres data — accounts, the cookie-signing
key, feedback — plus environment variables and the domain binding. That is the
whole of the lock-in, and it is small.

### The requirement sharding actually imposes

A request for code `ABC123` has to reach **one particular instance**, chosen by
reading the path. Not "an instance": that one, because the parked request and the
presenter's poll have to meet in the same process's memory.

That is request-level affinity, and it is a stronger requirement than horizontal
scaling. A load balancer that spreads requests evenly across identical replicas —
which is what most platforms mean by scaling a service — **breaks this design
rather than implementing it**, because two requests for the same show land in
different memory.

> **To verify before committing:** whether Railway replicas can be addressed
> individually, or whether its balancer chooses for you. If it chooses, raising
> the replica count is not a smaller version of sharding; it is an outage.

### If replicas cannot be addressed

There is a way to stay put. Run **each shard as its own service** — `shard-1`,
`shard-2` — and put a small router service in front of them, proxying by code
across the platform's private network. More manual than a replica count, but
Postgres, the domain and the deploy flow all stay where they are, and the router
is the same component the design needs anyway.

### Platforms built for this pattern

Named for completeness, not as a recommendation:

**Fly.io** has a `fly-replay` header — a response that says "replay this request
on instance X". It exists for key-routed workloads and would carry this design
directly.

**Cloudflare Durable Objects** are closer still: a Durable Object is a named
single-threaded actor addressed by ID, which is very nearly a description of a
show session. The parked-request relay is the pattern they exist for. It is also
a rewrite onto a different runtime, not a migration.

### The recommendation is to stay, and to not decide yet

Sharding is triggered by volumes that do not exist. The step that matters —
persisting the session record — is entirely platform-independent and is worth
doing wherever this runs. Do that first and the platform question stays open
until something forces it.

Two constraints to hold in mind meanwhile.

**The edge is not fully under your control.** The platform's CDN rewrites
`Cache-Control` on static files from the `no-cache` this server sends to four
hours, which is why cache-busting had to be solved in the HTML rather than in a
header. Routing would be governed by the same layer.

**One region, US East.** For a product about screens in a room that is fine while
the audience is North American. It becomes a latency question well before it
becomes a sharding question, and the two are easy to confuse.

---

## 7. Assumptions register

Every capacity figure above rests on the following. They are estimates, not
measurements, and the arithmetic moves proportionally with them.

| Assumption | Value used | Confidence |
|---|---|---|
| Average show duration | 30 minutes | Low — no telemetry yet |
| Peak-to-mean traffic ratio | 5× | Medium — typical of consumer evening peaks |
| Proportion of shows using hand-off | 5% | Low — feature is new |
| Average hand-off TTL selected | 24 hours | Low |
| Screens per show | 4 | From the business plan's own model |
| Normalised wire image size | 1.5 MB | Measured — 2560 px cap at JPEG q0.9 |

The single most valuable instrumentation the product could add is measurement of
the first four. Concurrency, not total volume, is what this architecture is
sensitive to, and none of it is currently observed.
