# Vinboo

**vinboo.com** — a web app for playing photo slideshows, with pause, start over,
and stop-and-pick-another-folder — plus the ability to share a slideshow live to
other browsers with a code and a temporary password.

You need an account to present. **Viewers don't** — a share code and temporary
password are all they need.

Everything plays from **your own device** — there is no server-side library and
nothing is ever uploaded.

- **A folder** on your drive, subfolders and all.
- **Your phone's camera roll**, on iOS or Android.
- **A PowerPoint** `.pptx`, rendered into slides in the browser.

The front end is plain HTML/CSS/JS with no build step and no framework. The
server has one dependency, `pg`, for Postgres.

## Run it locally

You need Postgres. On a Mac:

```bash
brew install postgresql@17 && brew services start postgresql@17
```

Create a database and point the app at it:

```bash
createdb vinboo
npm install
DATABASE_URL=postgres://localhost/vinboo npm start
```

Then open <http://localhost:4321>. The schema is created on first boot.

## Accounts and the database

Accounts live in Postgres. On Railway, adding a Postgres service injects
`DATABASE_URL` and the app picks it up with no further configuration.

Passwords are hashed with scrypt. The key used to sign session cookies is
generated once and kept in the database rather than on disk, so cookies survive
a redeploy with no volume attached, and every instance signs identically.

Set `SIGNUP_CODE` to stop strangers registering on a public instance. When it's
set, the sign-up form asks for it. (The old `ACCESS_CODE` variable still works
as the sign-up code.)

### Schema changes

Migrations are numbered SQL files in `migrations/`, applied in filename order
and recorded in `schema_migrations` so each runs exactly once. To change the
schema, add a file — never edit one that has already been applied:

```
migrations/0002_add_albums.sql
```

They run automatically when the server starts, so a deploy migrates itself. To
run them by hand:

```bash
npm run migrate
```

Because Railway can start several containers during a deploy, the whole run is
wrapped in a Postgres advisory lock: the first instance migrates, the others
wait and then find nothing to do.

### Coming from the old JSON file

Earlier versions kept accounts in `DATA_ROOT/users.json`. On first boot against
an empty `users` table, any accounts in that file are imported automatically,
password hashes intact, and the file is then left alone. Nothing is imported
once the table has rows, so it can't duplicate or clobber live data.

## Sharing a slideshow to other browsers

Pick a folder from your device, then hit **Share…**. You get a six-character
share code and a temporary password:

```
Share code:          RJ33DT
Temporary password:  WUE8-75HE-GDUH
```

On any other browser — a TV, a laptop, a phone — open `/watch`, type both in,
and that screen mirrors whatever slide you're on. Viewers need no account. Your
controls drive every screen: pause, next, start over, shuffle.

**Your browser is the source.** The photos are streamed live from the tab you're
presenting from and are never uploaded or written to the server's disk. The
server only relays bytes: a viewer asks for slide 4, the relay hands that
request to your tab, your tab sends the bytes, and they stream on to whoever
was waiting. They sit in server memory only while in flight, plus a small
bounded cache so ten viewers on the same slide cost you one upload rather than
ten.

The trade-off of that privacy is a hard requirement: **the presenting tab has to
stay open and awake.** If it closes, sleeps, or loses its connection, viewers
stop getting slides, and the broadcast is torn down after a minute of silence.
Codes also expire six hours after they're created, and stop working the moment
you press **Stop sharing**.

Both credentials are needed, wrong guesses are rate-limited to 10 per IP per 15
minutes, and the failure message is identical for a bad code and a bad
password, so neither can be probed independently.

## Casting to a television

The player has a **Cast** button. It sends the *viewer page* to the television
rather than the pictures, so the TV becomes an ordinary viewer pulling each
slide through the relay and following along as you present.

That indirection is the whole trick. Google's default media receiver loads media
by URL, and these photos are `blob:` URLs that exist only inside the presenting
tab — a Cast device can never fetch them. Handing it `/watch` sidesteps the
problem entirely and costs nothing: no receiver app to register, no media to
upload.

The URL carries a **single-use ticket** instead of the password. It is good for
three minutes, dies the moment it is redeemed, and is stripped from the address
bar afterwards, so nothing reusable is left sitting in a television's history.

Support depends on the browser, so the button adapts:

- **Chrome and Edge on desktop** get the Presentation API and a device picker.
- **Everywhere else** — Safari, Firefox, phones — the button copies the one-time
  link instead. Open it on the TV's own browser, or send it to whoever is next
  to the screen. It works on anything that can open a URL.

Older Chromecasts run a limited receiver; a Chromecast with Google TV, or any
smart TV with a browser, handles the viewer page comfortably. If a device gives
trouble, the copied link opened in the TV's browser always works.

## Play from this device (no upload)

The “Play from this device” panel has three ways in:

| Button | What it opens | Where it works |
| --- | --- | --- |
| **Photos…** | the system photo picker | everywhere, including iPhone and Android |
| **Folder…** | a whole folder, subfolders and all | desktop and Android |
| **PowerPoint…** | one or more `.pptx` files | everywhere |

You can also drag a folder onto the drop zone.

The files are read directly by the browser and played from in-memory object
URLs. They are never sent to the server — you can confirm this in the network
panel, where playback makes no requests at all. The trade-off is that the
selection is per-tab and per-session: reloading clears it, because browsers
don't let a page silently re-open a local folder later.

Presenting requires a signed-in account, so this panel sits behind the sign-in
screen even though local playback itself needs nothing from the server. Watching
a shared slideshow is the one flow that needs no account.

### Browsing the hierarchy

Whatever you pick becomes a browsable tree. Each folder is a card: **Open**
walks into it, **Play** plays it *and everything beneath it*. A breadcrumb
across the top walks back out. The first card in any folder — “All of …” —
plays that whole branch, so you can show one holiday or the entire drive
without reorganising anything.

If a chosen folder just wraps a single subfolder, the two are collapsed into
one step, so picking `Pictures` doesn't strand you on a lone `DCIM` to click
through.

### Phones

iOS and Android don't expose photo albums to a web page — there is no browser
API for them, so no app can read your albums directly. What they do expose is
the system picker, which is what **Photos…** opens.

Since the picker hands over files with no folder structure, the hierarchy is
rebuilt from each photo's own date, giving a **Year › Month** tree to browse.
Android sometimes supplies a real path, and when it does that's used instead.

One caveat worth knowing: iPhones shoot **HEIC**, which only Safari can
display. Going through a file picker, iOS usually converts to JPEG on the way
out, so this rarely bites — but if you land on HEIC files in a browser that
can't decode them, the app probes one and tells you rather than showing a wall
of broken images. To force JPEG: *Settings › Photos › Transfer to Mac or PC ›
Automatic*.

## PowerPoint

Pick a `.pptx` with **PowerPoint…**, drop one in, or drop one into the server
library — either way it plays as a slideshow, and it can be shared live like
anything else.

The conversion happens **entirely in your browser**. A `.pptx` is a ZIP of XML,
which the browser can already unpack, so each slide is turned into a
self-contained SVG with its images inlined. Nothing is sent anywhere to be
converted, there's no LibreOffice on the server, and decks stream through the
sharing relay as ordinary images because that's what they've become.

What comes through: slide order and size, backgrounds, text with its font,
size, weight, colour, alignment, wrapping and bullets, pictures, shapes with
fills and outlines, connectors, grouped shapes, and tables.

What doesn't: animations and transitions, charts and SmartArt (drawn as a
labelled placeholder so the layout still reads), 3-D effects, and WordArt.
Gradients are approximated by their first colour stop.

Two things follow from rendering rather than screenshotting. Decks stay sharp
at any size and stream as a few KB per slide instead of a full-resolution
image. But the deck's fonts usually aren't installed on the machine showing it,
and substituted fonts measure differently — so text that fitted in PowerPoint
can wrap differently here. Text that would overflow its box is shrunk to fit,
the same thing PowerPoint does, rather than being allowed to overlap whatever
sits below it.

Only `.pptx` works. The older binary `.ppt` is a completely different format;
open it in PowerPoint and save it as `.pptx`.

## Playback controls

| Control | Keyboard | What it does |
| --- | --- | --- |
| Play / Pause | `Space` | Pause on the current photo, resume where you left off |
| Next / Previous | `→` / `←` | Step through by hand |
| Start over | `R` | Jump back to the first photo and play from the top |
| Stop | `Esc` | Leave the slideshow and go back to folder selection |
| Fullscreen | `F` | Fullscreen the player |
| Shuffle | `S` | Random order |
| Loop | `L` | Wrap around at the end, or stop on the last photo |

Speed is adjustable from 1 to 30 seconds per photo. Clicking the photo toggles
pause, and the controls fade out while playing until you move the mouse. The
controls behave identically whichever source the photos came from; a badge next
to the counter shows which one is playing.

## Tests

Three suites.

The deck tests (ZIP reader, XML parser, PowerPoint rendering) need nothing
running — the fixture presentation is built in memory:

```bash
npm run test:deck
```

The database tests cover migrations, the account store, the signing key and
transactions. They truncate tables, so they refuse to run against a database
whose name doesn't end in `_test`:

```bash
createdb vinboo_test
DATABASE_URL=postgres://localhost/vinboo_test npm run test:db
```

The end-to-end suite covers accounts, the relay and the sharing lifecycle
against a running server:

```bash
DATABASE_URL=postgres://localhost/vinboo_test PORT=4399 node server.js &
sleep 2 && npm run test:e2e
```

`npm test` runs all three; it expects `DATABASE_URL` to point at a `_test`
database and a server already listening on 4399.

Both suites that touch data refuse to run against anything that isn't a `_test`
database — the end-to-end suite asks the server which database it is using via
`/healthz` and stops if the answer looks like a real one. That matters because a
stray server left holding port 4399 will happily answer, and it may be pointed
somewhere you did not intend. If a run reports the wrong database:

```bash
lsof -ti:4399 | xargs kill -9
```

## Configuration

All optional, all via environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | *(required)* | Postgres connection string; Railway injects it |
| `DATABASE_SSL` | *(auto)* | `require` or `disable` to override TLS detection |
| `DATABASE_POOL_MAX` | `10` | Maximum pooled connections |
| `PORT` | `4321` | Port to listen on |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_ROOT` | `./data` | Legacy accounts file, imported once on first boot |
| `SIGNUP_CODE` | *(unset)* | If set, required to create an account |
| `SESSION_SECRET` | *(unset)* | Overrides the signing key kept in the database |
| `MAX_FRAME_BYTES` | `26214400` | Largest photo that can be streamed live (25 MB) |

## Deploying to Railway

1. Create a Railway project from this GitHub repo. Nixpacks detects Node, runs
   `npm install` and then `npm start`; `railway.json` sets the health check to
   `/healthz`, which reports unhealthy if the database is unreachable.
2. **Add a Postgres service, then reference it from the app.** This is the step
   that catches people out: adding a database to the project does *not* share
   its variables with your app service. In the **app** service go to
   *Variables → New Variable* and add:

   | Name | Value |
   | --- | --- |
   | `DATABASE_URL` | `${{ Postgres.DATABASE_URL }}` |

   Use your database service's actual name in place of `Postgres`. Redeploy, and
   the schema is created on the first boot.

   **The name doesn't actually matter.** Any variable whose value starts with
   `postgres://` is used, whatever it's called, and the discrete
   `PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` set works too. `DATABASE_URL` is
   just the convention.

   If nothing is found the app exits immediately with instructions rather than
   starting up broken, and prints the names of the database-related variables it
   can actually see (names only — never values). Two failures look different:

   - *"none of them database related"* — the reference was never added, or was
     added to the database service instead of the app service.
   - *"unresolved Railway reference"* — the variable exists but still contains
     the literal `${{ … }}`, meaning the service name inside it doesn't match
     any service in the project. Copy the exact name from the database service's
     card; Railway autocompletes it once you type `${{`.
3. **No volume is needed.** Accounts live in Postgres and slideshows live on
   the presenter's device, so this process stores nothing on disk.
4. **Set `SIGNUP_CODE`** to something only your people know, or anyone who finds
   the URL can register.
5. Don't set `PORT` — Railway injects it.

The app connects over Railway's private network (`*.railway.internal`), which
doesn't use TLS; TLS is enabled automatically for any other host. Because the
container can start before the database is accepting connections, the first
connection retries with backoff instead of crash-looping the deploy.

Live sharing holds requests open for up to 30 seconds at a time, which Railway's
proxy handles fine. Broadcast state is kept in memory, so a redeploy ends any
slideshow in progress — presenters just hit Share again for a fresh code.

## Adapting to the device

The layout follows what the device can actually do rather than what its user
agent claims, using `pointer`, `hover` and size queries:

- **Touch**: 44px minimum targets, 16px form fields (anything smaller makes iOS
  zoom on focus), no hover effects — a hover lift sticks after a tap and reads
  as a stuck button — and the drag-and-drop zone is hidden, since there is
  nothing to drag with.
- **Phones in landscape**, which is how slideshows are actually watched: the
  controls stop taking layout space and float over the bottom of the photo, so
  the picture gets the full height instead of losing a third of it.
- **Viewport height** uses `dvh`, because `100vh` on a phone is measured against
  the browser chrome being hidden and pushes the controls below the fold. Safe
  area insets keep them clear of the home indicator and notch.
- **Televisions** (very wide viewports) scale the viewer's type and controls up,
  and the chrome fades out after a few seconds so a screen left running all
  evening shows only the photo.
- **iOS** is the one thing named rather than feature-detected: Safari exposes
  `webkitdirectory` on file inputs but ignores it, so whole-folder picking can't
  be detected and the Folder button is simply not offered there. Photos and
  PowerPoint still are.

## SEO and link previews

Both public pages carry a title, meta description, canonical URL, robots
directive, Open Graph and Twitter card tags, and the landing page adds
`WebApplication` JSON-LD. `public/robots.txt` and `public/sitemap.xml` are
served as static files.

The share card at `public/brand/og-image.png` (1200×630) is what appears when
someone pastes a link into a message or a post — which, for an app people invite
each other to, is a more common first impression than a search result.

All the absolute URLs point at `https://vinboo.com`. If the site ever moves,
those are the strings to change: the canonical and `og:url` tags in
`public/index.html` and `public/watch.html`, plus `robots.txt` and
`sitemap.xml`.

## Analytics

Both public pages carry the Google tag (`gtag.js`) for measurement ID
`G-XXF25X6BPJ`. The ID is written into `public/index.html` and
`public/watch.html` — those are the two places to change it.

Two things worth knowing about what it will and won't show:

- **One page view per visit.** The app moves between the landing page, the
  library and the player without navigating, so a whole session of presenting
  registers as a single view. If you want to see which parts get used, that
  needs explicit `gtag('event', …)` calls at those transitions.
- **Viewers are counted too**, since the tag is on `/watch` as well. That is
  probably what you want — it is the only way to see how many screens a
  slideshow actually reached — but it does mean people who never signed up are
  measured.

If the site takes visitors from the EU or UK, analytics cookies generally need
consent before they are set, which this does not currently ask for.

## Look and feel

The visual system comes from the logo, and the palette is sampled from the
artwork rather than eyeballed:

| Role | Colour | |
| --- | --- | --- |
| Coral | `#FF8382` | primary actions, live indicators |
| Cyan | `#51D1E3` | toggles, badges, focus rings |
| Amber | `#FDCA5C` | presentations, cautions |
| Paper | `#FFFAF5` | page |
| Ink | `#2A2440` | text |

The pastels are used at full strength as **fills, paired with deep ink text**
rather than white. That was a deliberate call: darkening the coral far enough to
carry white text at 4.5:1 turns it into a plain red and loses the brand. Ink on
brand coral measures 6.2:1, on cyan 8.1:1, and on amber 9.7:1 — so the exact
logo colours survive and the contrast is comfortably past AA. Deepened variants
(`#C8362F`, `#1F7884`, `#936A10`) carry links and small text on paper.

Everything is pill-shaped or generously rounded to echo the logo's letterforms,
with soft warm shadows instead of hard borders. On Apple devices the type uses
`ui-rounded` (SF Pro Rounded), which is close to the logo's face and costs no
web font download; elsewhere it falls back through Nunito to the system stack.

**The player stays dark.** Photos and slides read best against near-black, so
the stage keeps a `#12101C` chrome and takes the brand in as accents — the coral
play button, the cyan toggles, a coral-to-amber progress bar. Chrome is styling;
the viewing surface is function.

Brand assets live in `public/brand/` (wordmark, square mark, and favicons),
derived from the source logo.

## Notes on safety

- The server never reads or writes slideshow files, so there is no upload path
  and no file-serving path to get wrong.
- Sign-ins, sign-ups, and share-code attempts are each rate-limited per IP.
- Every query is parameterised, so account data can't be reached by injection,
  and username uniqueness is enforced by a database index rather than by a
  check-then-insert that two simultaneous sign-ups could slip through.
- On-device playback never transmits the files. Object URLs are minted lazily
  and revoked as playback moves on, so a large folder isn't held in memory all
  at once.
- Passwords are hashed with scrypt and compared in constant time. A sign-in
  attempt for an unknown username still does the hashing work, so a miss can't
  be spotted by how fast it fails.
- Share codes and temporary passwords are generated from `crypto.randomBytes`
  with unbiased character mapping, and only their hashes are kept in memory.
- Streamed photos are sent with `Cache-Control: no-store` so no proxy retains a
  copy, and a broadcast's memory cache is dropped the moment it ends.
- Only the account that started a broadcast can drive it or end it.
- Rendered slides are built as escaped SVG and shown through `<img>`, so a
  booby-trapped deck can't run script — in the presenter's browser or in a
  viewer's.

## License

MIT
