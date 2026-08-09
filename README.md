# Vinboo

**vinboo.com** — a web app for playing photo slideshows, with pause, start over,
and stop-and-pick-another-folder — plus the ability to share a slideshow live to
other browsers with a code and a temporary password.

You need an account to present. **Viewers don't** — a share code and temporary
password are all they need.

It plays photos and PowerPoint decks, from a computer, a phone, or the server.

- **From this device** — pick a folder on your own drive and play it
  immediately. Nothing is uploaded and nothing is stored; the selection lives
  only in that browser tab.
- **From a phone** — pick straight from the iOS or Android photo library.
- **PowerPoint** — a `.pptx` is rendered into slides in the browser and plays
  like any other show.
- **From the server library** — files placed in subfolders of the photo
  library, either dropped in with Finder or uploaded through the web UI. These
  persist and are visible to anyone else signed in to the same instance.

No dependencies. It's plain Node plus static HTML/CSS/JS, so there's nothing to
install.

## Run it locally

```bash
npm start
```

Then open <http://localhost:4321>.

## Accounts

The first thing you'll see is a sign-in screen. Create an account, and you're
in. Passwords are hashed with scrypt and stored in `DATA_ROOT/users.json`
alongside a generated signing key — neither belongs in git, and `.gitignore`
keeps them out.

Set `SIGNUP_CODE` to stop strangers registering on a public instance. When it's
set, the sign-up form asks for it. (The old `ACCESS_CODE` variable now serves as
the sign-up code, so existing deployments keep working.)

Sessions are cookies signed with the key in `DATA_ROOT`, so they survive
restarts and redeploys as long as that directory persists.

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

## The server photo library

Photos live in `./photos`. Any subfolder there shows up in the web UI:

```
photos/
  vacation-2026/     → "vacation-2026" in the picker
  wedding/
  family/reunion/    → nested folders work too
```

You can drop folders in with Finder and hit **Refresh**, or create folders and
upload photos from the web UI itself (drag a batch of images onto any folder
card).

Supported formats: JPEG, PNG, GIF, WebP, AVIF, BMP, SVG, TIFF, HEIC/HEIF, and
`.pptx` presentations. (HEIC and TIFF only render in browsers that support them
— Safari does, most others don't.)

Presentations in the library appear as their own card next to their folder, and
are converted in the browser when played.

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

Two suites. The deck tests (ZIP reader, XML parser, PowerPoint rendering) need
nothing running — the fixture presentation is built in memory:

```bash
npm run test:deck
```

The full run adds the end-to-end suite for accounts, the relay and the sharing
lifecycle, which needs a server on port 4399 with a throwaway data directory:

```bash
PORT=4399 DATA_ROOT=/tmp/slideshow-test node server.js & sleep 1 && npm test
```

## Configuration

All optional, all via environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4321` | Port to listen on |
| `HOST` | `0.0.0.0` | Bind address |
| `PHOTOS_ROOT` | `./photos` | Where the server photo library lives |
| `DATA_ROOT` | `./data` | Accounts and the signing key |
| `SIGNUP_CODE` | *(unset)* | If set, required to create an account |
| `SESSION_SECRET` | *(unset)* | Overrides the generated signing key |
| `MAX_UPLOAD_BYTES` | `104857600` | Per-file upload cap (100 MB) |
| `MAX_FRAME_BYTES` | `26214400` | Largest photo that can be streamed live (25 MB) |

## Deploying to Railway

1. Create a Railway project from this GitHub repo. Nixpacks detects Node and
   runs `npm start`; `railway.json` sets the health check to `/healthz`.
2. **Attach a volume** and point both roots at it — e.g. mount at `/data`, then
   set `PHOTOS_ROOT=/data/photos` and `DATA_ROOT=/data/state`. Railway
   containers have an ephemeral filesystem, so without a volume every uploaded
   photo *and every account* disappears on the next deploy.
3. **Set `SIGNUP_CODE`** to something only your people know, or anyone who finds
   the URL can register.
4. Don't set `PORT` — Railway injects it.

Live sharing holds requests open for up to 30 seconds at a time, which Railway's
proxy handles fine. Broadcast state is kept in memory, so a redeploy ends any
slideshow in progress — presenters just hit Share again for a fresh code.

Uploading a large photo library through the browser over the network is slow;
for anything big, consider syncing files onto the volume directly instead.

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

- Every client-supplied path is resolved and checked against the library root,
  so `../` traversal can't reach outside it.
- Only image extensions are served or accepted for upload.
- Uploads write to a temp file and rename on success, and never overwrite an
  existing photo — a name collision becomes `photo (2).jpg`.
- Sign-ins, sign-ups, and share-code attempts are each rate-limited per IP.
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
