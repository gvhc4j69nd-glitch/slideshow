# slideshow

A small web app for playing photo slideshows, with pause, start over, and
stop-and-pick-another-folder — plus the ability to share a slideshow live to
other browsers with a code and a temporary password.

You need an account to present. **Viewers don't** — a share code and temporary
password are all they need.

There are two ways to get photos into it:

- **From this device** — pick a folder on your own drive and play it
  immediately. Nothing is uploaded and nothing is stored; the selection lives
  only in that browser tab.
- **From the server library** — photos placed in subfolders of the photo
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

Click **Choose folder…** in the “Play from this device” panel and pick any
folder on your drive, or drag a folder onto the drop zone. Subfolders each
become their own playable card, so a folder of folders works fine.

The files are read directly by the browser and played from in-memory object
URLs. They are never sent to the server — you can confirm this in the network
panel, where playback makes no requests at all. The trade-off is that the
selection is per-tab and per-session: reloading clears it, because browsers
don't let a page silently re-open a local folder later.

Which mechanism the browser uses depends on support:

- Chrome and Edge use the File System Access API directory picker.
- Safari and Firefox fall back to a directory `<input>`, which works the same
  way from your side.
- Drag-and-drop of a folder works in all of them.

Presenting requires a signed-in account, so this panel sits behind the sign-in
screen even though local playback itself needs nothing from the server. Watching
a shared slideshow is the one flow that needs no account.

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

Supported formats: JPEG, PNG, GIF, WebP, AVIF, BMP, SVG, TIFF, HEIC/HEIF.
(HEIC and TIFF only render in browsers that support them — Safari does, most
others don't.)

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

An end-to-end suite covers accounts, the relay, and the sharing lifecycle. Start
the server on port 4399 with a throwaway data directory, then run it:

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

## License

MIT
