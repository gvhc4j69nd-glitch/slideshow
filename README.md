# slideshow

A small web app for playing photo slideshows. Put photos into subfolders of a
photo library, pick a folder in the browser, and play it — with pause, start
over, and stop-and-pick-another-folder.

No dependencies. It's plain Node plus static HTML/CSS/JS, so there's nothing to
install.

## Run it locally

```bash
npm start
```

Then open <http://localhost:4321>.

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
pause, and the controls fade out while playing until you move the mouse.

## Configuration

All optional, all via environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4321` | Port to listen on |
| `HOST` | `0.0.0.0` | Bind address |
| `PHOTOS_ROOT` | `./photos` | Where the photo library lives |
| `ACCESS_CODE` | *(unset)* | If set, visitors must enter this code first |
| `SESSION_SECRET` | *(unset)* | Extra entropy for the session cookie |
| `MAX_UPLOAD_BYTES` | `104857600` | Per-file upload cap (100 MB) |

## Deploying to Railway

1. Create a Railway project from this GitHub repo. Nixpacks detects Node and
   runs `npm start`; `railway.json` sets the health check to `/healthz`.
2. **Attach a volume**, and set `PHOTOS_ROOT` to its mount path (e.g. mount at
   `/data` and set `PHOTOS_ROOT=/data`). Railway containers have an ephemeral
   filesystem — without a volume, every uploaded photo disappears on the next
   deploy or restart.
3. **Set `ACCESS_CODE`** to something only you know. The upload endpoint is
   reachable by anyone who has the URL otherwise.
4. Don't set `PORT` — Railway injects it.

Uploading a large photo library through the browser over the network is slow;
for anything big, consider syncing files onto the volume directly instead.

## Notes on safety

- Every client-supplied path is resolved and checked against the library root,
  so `../` traversal can't reach outside it.
- Only image extensions are served or accepted for upload.
- Uploads write to a temp file and rename on success, and never overwrite an
  existing photo — a name collision becomes `photo (2).jpg`.
- The access code is compared in constant time and rate-limited to 10 attempts
  per IP per 15 minutes.

## License

MIT
