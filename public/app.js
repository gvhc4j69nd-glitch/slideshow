'use strict';

/* ── State ────────────────────────────────────────────────────────────────── */

const state = {
  folders: [],       // folders on the server
  localFolders: [],  // folders picked off this device — never uploaded
  source: 'server',  // where the folder currently playing came from
  folder: null,      // label of the folder being played
  photos: [],        // [{name, url}] for server photos, [{name, file}] for local ones
  index: 0,
  playing: false,
  shuffle: false,
  loop: true,
  interval: 5000,
  timer: null,
  tickStart: 0,
  frontIsA: true,
  rafId: null,
};

const $ = (id) => document.getElementById(id);

const el = {
  library: $('library'), player: $('player'),
  libRoot: $('libRoot'), notice: $('notice'),
  folderGrid: $('folderGrid'), emptyState: $('emptyState'),
  newFolderBtn: $('newFolderBtn'), refreshBtn: $('refreshBtn'),
  stage: $('stage'), slideA: $('slideA'), slideB: $('slideB'), stageMsg: $('stageMsg'),
  progressBar: $('progressBar'),
  playBtn: $('playBtn'), prevBtn: $('prevBtn'), nextBtn: $('nextBtn'),
  restartBtn: $('restartBtn'), stopBtn: $('stopBtn'), fullscreenBtn: $('fullscreenBtn'),
  shuffleBtn: $('shuffleBtn'), loopBtn: $('loopBtn'), speedSelect: $('speedSelect'),
  folderLabel: $('folderLabel'), counter: $('counter'), sourceTag: $('sourceTag'),
  folderDialog: $('folderDialog'), folderForm: $('folderForm'),
  folderNameInput: $('folderNameInput'), folderError: $('folderError'),
  folderCancel: $('folderCancel'), fileInput: $('fileInput'),
  gate: $('gate'), gateForm: $('gateForm'), gateInput: $('gateInput'),
  gateError: $('gateError'), gateSubmit: $('gateSubmit'),
  localPanel: $('localPanel'), localGrid: $('localGrid'), localDrop: $('localDrop'),
  localStatus: $('localStatus'), localHelp: $('localHelp'),
  chooseLocalBtn: $('chooseLocalBtn'), clearLocalBtn: $('clearLocalBtn'),
  localDirInput: $('localDirInput'), serverTitle: $('serverTitle'),
};

/* ── Helpers ──────────────────────────────────────────────────────────────── */

async function api(url, options) {
  const res = await fetch(url, options);
  const type = res.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await res.json() : null;
  if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
  return body;
}

function showNotice(message, kind) {
  el.notice.textContent = message;
  el.notice.className = kind === 'ok' ? 'notice ok' : 'notice';
  el.notice.hidden = false;
  if (kind === 'ok') setTimeout(() => { el.notice.hidden = true; }, 4000);
}

const mediaUrl = (relPath) => '/media/' + relPath.split('/').map(encodeURIComponent).join('/');

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg|heic|heif|tiff?)$/i;

/** Some image types (HEIC especially) come through with an empty MIME type. */
const isImageFile = (file) => file.type.startsWith('image/') || IMAGE_EXT.test(file.name);

/* ── Object URLs for local files ──────────────────────────────────────────── */

/**
 * Local photos are played straight off disk via object URLs. Minting one per
 * photo up front would pin the whole folder, so they're created on demand and
 * the oldest are revoked once we're well past them.
 */
const liveUrls = [];
const MAX_LIVE_URLS = 8;

function photoUrl(photo) {
  if (photo.url) return photo.url;
  if (!photo.objectUrl) {
    photo.objectUrl = URL.createObjectURL(photo.file);
    liveUrls.push(photo);
    while (liveUrls.length > MAX_LIVE_URLS) {
      const stale = liveUrls.shift();
      if (stale !== photo && stale.objectUrl) {
        URL.revokeObjectURL(stale.objectUrl);
        stale.objectUrl = null;
      }
    }
  }
  return photo.objectUrl;
}

function releasePlaylistUrls() {
  for (const photo of liveUrls) {
    if (photo.objectUrl) {
      URL.revokeObjectURL(photo.objectUrl);
      photo.objectUrl = null;
    }
  }
  liveUrls.length = 0;
}

/* ── Library ──────────────────────────────────────────────────────────────── */

async function loadFolders() {
  el.refreshBtn.disabled = true;
  try {
    const data = await api('/api/folders');
    state.folders = data.folders;
    el.libRoot.textContent = data.root;
    el.notice.hidden = true;
    renderLibrary();
  } catch (err) {
    showNotice(`Could not load folders: ${err.message}`);
  } finally {
    el.refreshBtn.disabled = false;
  }
}

function renderLibrary() {
  renderServerFolders();
  renderLocalFolders();
}

function renderServerFolders() {
  el.folderGrid.replaceChildren();
  el.emptyState.hidden = state.folders.length > 0;

  for (const folder of state.folders) {
    const card = folderCard({
      label: folder.path,
      count: folder.count,
      coverUrl: folder.cover ? mediaUrl(folder.cover) : null,
      onPlay: () => startServerSlideshow(folder.path),
    });

    const status = document.createElement('div');
    status.className = 'upload-status';

    const uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.className = 'btn';
    uploadBtn.textContent = 'Add photos';
    uploadBtn.addEventListener('click', () => pickFiles(folder.path, status));

    card.buttons.append(uploadBtn);
    card.body.append(status);

    // Drag a batch of photos straight onto the card to upload them.
    card.root.addEventListener('dragover', (e) => {
      e.preventDefault();
      card.root.classList.add('drag-over');
    });
    card.root.addEventListener('dragleave', () => card.root.classList.remove('drag-over'));
    card.root.addEventListener('drop', (e) => {
      e.preventDefault();
      card.root.classList.remove('drag-over');
      const files = [...e.dataTransfer.files].filter(isImageFile);
      if (files.length) uploadFiles(folder.path, files, status);
    });

    el.folderGrid.append(card.root);
  }
}

function renderLocalFolders() {
  el.localGrid.replaceChildren();
  el.clearLocalBtn.hidden = state.localFolders.length === 0;

  for (const folder of state.localFolders) {
    const card = folderCard({
      label: folder.label,
      count: folder.photos.length,
      coverUrl: folder.coverUrl,
      badge: 'On this device',
      onPlay: () => startLocalSlideshow(folder.id),
    });
    el.localGrid.append(card.root);
  }
}

/** Shared card markup for both server-side and on-device folders. */
function folderCard({ label, count, coverUrl, badge, onPlay }) {
  const root = document.createElement('div');
  root.className = 'folder-card';

  const cover = document.createElement('button');
  cover.type = 'button';
  cover.className = 'folder-cover';
  cover.title = count ? `Play ${label}` : 'This folder has no photos yet';
  if (coverUrl) cover.style.backgroundImage = `url("${coverUrl}")`;
  else cover.textContent = '🗂';
  cover.disabled = count === 0;
  cover.addEventListener('click', onPlay);

  const body = document.createElement('div');
  body.className = 'folder-body';

  const name = document.createElement('div');
  name.className = 'folder-name';
  name.textContent = label;
  name.title = label;

  const sub = document.createElement('div');
  sub.className = 'folder-sub';
  sub.textContent = count === 1 ? '1 photo' : `${count} photos`;

  const buttons = document.createElement('div');
  buttons.className = 'folder-buttons';

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'btn btn-primary';
  playBtn.textContent = 'Play';
  playBtn.disabled = count === 0;
  playBtn.addEventListener('click', onPlay);
  buttons.append(playBtn);

  body.append(name, sub);
  if (badge) {
    const tag = document.createElement('div');
    tag.className = 'badge';
    tag.textContent = badge;
    body.append(tag);
  }
  body.append(buttons);
  root.append(cover, body);

  return { root, body, buttons };
}

function pickFiles(folderPath, status) {
  el.fileInput.value = '';
  el.fileInput.onchange = () => {
    const files = [...el.fileInput.files];
    if (files.length) uploadFiles(folderPath, files, status);
  };
  el.fileInput.click();
}

async function uploadFiles(folderPath, files, status) {
  let done = 0;
  let failed = 0;
  status.classList.remove('err');

  for (const file of files) {
    status.textContent = `Uploading ${done + failed + 1} of ${files.length}…`;
    try {
      await api(
        `/api/upload?folder=${encodeURIComponent(folderPath)}&name=${encodeURIComponent(file.name)}`,
        { method: 'PUT', body: file, headers: { 'Content-Type': 'application/octet-stream' } },
      );
      done += 1;
    } catch (err) {
      failed += 1;
      status.classList.add('err');
      status.textContent = `${file.name}: ${err.message}`;
    }
  }

  if (!failed) status.textContent = `Uploaded ${done} photo${done === 1 ? '' : 's'}.`;
  else status.textContent = `Uploaded ${done}, ${failed} failed.`;
  await loadFolders();
}

/* ── New folder dialog ────────────────────────────────────────────────────── */

el.newFolderBtn.addEventListener('click', () => {
  el.folderNameInput.value = '';
  el.folderError.hidden = true;
  el.folderDialog.showModal();
});
el.folderCancel.addEventListener('click', () => el.folderDialog.close());

el.folderForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = el.folderNameInput.value.trim();
  if (!name) return;
  try {
    await api('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    el.folderDialog.close();
    await loadFolders();
    showNotice(`Created “${name}”. Use “Add photos” to fill it.`, 'ok');
  } catch (err) {
    el.folderError.textContent = err.message;
    el.folderError.hidden = false;
  }
});

/* ── Local folders (played off this device, never uploaded) ───────────────── */

const MAX_LOCAL_FILES = 20000;
const MAX_LOCAL_DEPTH = 6;
let localFolderSeq = 0;
let localCoverUrls = [];

function setLocalStatus(message, isError) {
  el.localStatus.textContent = message || '';
  el.localStatus.classList.toggle('err', Boolean(isError));
  el.localStatus.hidden = !message;
}

/** Drop the current on-device selection and free its cover thumbnails. */
function clearLocalFolders() {
  for (const url of localCoverUrls) URL.revokeObjectURL(url);
  localCoverUrls = [];
  state.localFolders = [];
  renderLocalFolders();
  setLocalStatus('');
}

/**
 * Group scanned files into one card per directory.
 * `items` is [{ dir, name, file }] with `dir` relative to the chosen folder.
 */
function buildLocalFolders(items, rootName) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.dir)) groups.set(item.dir, []);
    groups.get(item.dir).push({ name: item.name, file: item.file });
  }

  const folders = [];
  for (const [dir, photos] of groups) {
    photos.sort((a, b) => collator.compare(a.name, b.name));
    const coverUrl = URL.createObjectURL(photos[0].file);
    localCoverUrls.push(coverUrl);
    folders.push({
      id: `local-${(localFolderSeq += 1)}`,
      label: dir ? `${rootName}/${dir}` : rootName,
      photos,
      coverUrl,
    });
  }
  folders.sort((a, b) => collator.compare(a.label, b.label));
  return folders;
}

function adoptLocalFolders(items, rootName) {
  if (!items.length) {
    setLocalStatus(`No photos found in “${rootName}”.`, true);
    return;
  }
  clearLocalFolders();
  state.localFolders = buildLocalFolders(items, rootName);
  renderLocalFolders();

  const total = items.length;
  const folderCount = state.localFolders.length;
  setLocalStatus(
    `Ready: ${total} photo${total === 1 ? '' : 's'} in ${folderCount} folder${folderCount === 1 ? '' : 's'}. ` +
    'These stay on your device — nothing was uploaded.',
  );
}

/* Source 1: File System Access API (Chrome, Edge). */
async function pickLocalViaHandle() {
  const rootHandle = await window.showDirectoryPicker({ mode: 'read', id: 'slideshow-local' });
  setLocalStatus(`Scanning “${rootHandle.name}”…`);

  const items = [];
  let truncated = false;

  const walk = async (dirHandle, relDir, depth) => {
    for await (const handle of dirHandle.values()) {
      if (items.length >= MAX_LOCAL_FILES) { truncated = true; return; }
      if (handle.name.startsWith('.')) continue;
      if (handle.kind === 'file') {
        let file;
        try {
          file = await handle.getFile();
        } catch {
          continue;
        }
        if (isImageFile(file)) items.push({ dir: relDir, name: handle.name, file });
      } else if (handle.kind === 'directory' && depth < MAX_LOCAL_DEPTH) {
        await walk(handle, relDir ? `${relDir}/${handle.name}` : handle.name, depth + 1);
      }
    }
  };

  await walk(rootHandle, '', 0);
  adoptLocalFolders(items, rootHandle.name);
  if (truncated) setLocalStatus(`Stopped at ${MAX_LOCAL_FILES} photos — that folder is very large.`, true);
}

/* Source 2: <input webkitdirectory> fallback (Safari, Firefox). */
function pickLocalViaInput() {
  el.localDirInput.value = '';
  el.localDirInput.onchange = () => {
    const files = [...el.localDirInput.files];
    if (!files.length) return;

    const rootName = (files[0].webkitRelativePath || '').split('/')[0] || 'Selected folder';
    const items = [];
    for (const file of files) {
      if (items.length >= MAX_LOCAL_FILES) break;
      if (!isImageFile(file)) continue;
      const parts = (file.webkitRelativePath || file.name).split('/');
      items.push({ dir: parts.slice(1, -1).join('/'), name: parts[parts.length - 1], file });
    }
    adoptLocalFolders(items, rootName);
  };
  el.localDirInput.click();
}

async function chooseLocalFolder() {
  try {
    if (typeof window.showDirectoryPicker === 'function') await pickLocalViaHandle();
    else pickLocalViaInput();
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return; // user cancelled
    setLocalStatus(`Could not read that folder: ${err.message}`, true);
  }
}

/* Source 3: dragging a folder onto the drop zone. */
function readEntryBatch(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walkDroppedEntry(entry, relDir, items, depth) {
  if (items.length >= MAX_LOCAL_FILES) return;
  if (entry.name.startsWith('.')) return;

  if (entry.isFile) {
    const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
    if (file && isImageFile(file)) items.push({ dir: relDir, name: entry.name, file });
    return;
  }
  if (entry.isDirectory && depth < MAX_LOCAL_DEPTH) {
    const reader = entry.createReader();
    const nextDir = relDir ? `${relDir}/${entry.name}` : entry.name;
    // readEntries returns at most 100 entries per call, so keep asking.
    for (;;) {
      const batch = await readEntryBatch(reader);
      if (!batch.length) break;
      for (const child of batch) await walkDroppedEntry(child, nextDir, items, depth + 1);
    }
  }
}

async function handleLocalDrop(dataTransfer) {
  const roots = [...dataTransfer.items]
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);

  // A plain batch of image files, no folder involved.
  if (!roots.length || roots.every((entry) => entry.isFile)) {
    const files = [...dataTransfer.files].filter(isImageFile);
    if (!files.length) {
      setLocalStatus('No images in what you dropped.', true);
      return;
    }
    adoptLocalFolders(files.map((file) => ({ dir: '', name: file.name, file })), 'Dropped photos');
    return;
  }

  setLocalStatus('Reading dropped folder…');
  const items = [];
  let rootName = 'Dropped photos';
  for (const entry of roots) {
    if (entry.isDirectory) {
      rootName = entry.name;
      const reader = entry.createReader();
      for (;;) {
        const batch = await readEntryBatch(reader);
        if (!batch.length) break;
        for (const child of batch) await walkDroppedEntry(child, '', items, 1);
      }
    } else {
      await walkDroppedEntry(entry, '', items, 1);
    }
  }
  adoptLocalFolders(items, rootName);
}

el.chooseLocalBtn.addEventListener('click', chooseLocalFolder);
el.clearLocalBtn.addEventListener('click', clearLocalFolders);

// Without this the browser navigates away when a folder is dropped off-target.
for (const type of ['dragover', 'drop']) {
  document.addEventListener(type, (event) => {
    if (!event.target.closest('.dropzone, .folder-card')) event.preventDefault();
  });
}

el.localDrop.addEventListener('dragover', (event) => {
  event.preventDefault();
  el.localDrop.classList.add('drag-over');
});
el.localDrop.addEventListener('dragleave', () => el.localDrop.classList.remove('drag-over'));
el.localDrop.addEventListener('drop', (event) => {
  event.preventDefault();
  el.localDrop.classList.remove('drag-over');
  handleLocalDrop(event.dataTransfer).catch((err) => {
    setLocalStatus(`Could not read that folder: ${err.message}`, true);
  });
});

/* ── Slideshow ────────────────────────────────────────────────────────────── */

async function startServerSlideshow(folderPath) {
  try {
    const data = await api(`/api/photos?folder=${encodeURIComponent(folderPath)}`);
    if (!data.photos.length) {
      showNotice('That folder has no photos in it.');
      await loadFolders();
      return;
    }
    beginPlayback(data.folder, data.photos, 'server');
  } catch (err) {
    showNotice(`Could not start the slideshow: ${err.message}`);
  }
}

function startLocalSlideshow(folderId) {
  const folder = state.localFolders.find((f) => f.id === folderId);
  if (!folder || !folder.photos.length) {
    setLocalStatus('That folder has no photos in it.', true);
    return;
  }
  // Copy the list so shuffling the playlist doesn't reorder the card's photos.
  beginPlayback(folder.label, folder.photos.map((p) => ({ ...p })), 'local');
}

function beginPlayback(label, photos, source) {
  releasePlaylistUrls();
  state.source = source;
  state.folder = label;
  state.photos = photos;
  state.index = 0;
  if (state.shuffle) shufflePhotos();

  el.folderLabel.textContent = label;
  el.sourceTag.textContent = source === 'local' ? 'On this device' : 'Server';
  el.sourceTag.hidden = false;
  el.library.hidden = true;
  el.player.hidden = false;
  el.stageMsg.hidden = true;
  el.slideA.classList.remove('visible');
  el.slideB.classList.remove('visible');
  state.frontIsA = false;

  showPhoto(0);
  play();
}

function stopSlideshow() {
  pause();
  const wasLocal = state.source === 'local';
  releasePlaylistUrls();
  state.folder = null;
  state.photos = [];
  state.index = 0;
  el.slideA.removeAttribute('src');
  el.slideB.removeAttribute('src');
  el.player.hidden = true;
  el.library.hidden = false;
  el.player.classList.remove('idle');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  // On-device folders live only in this tab, so there's nothing to re-fetch.
  if (!wasLocal) loadFolders();
}

/** Cross-fade between the two <img> layers so slides don't flash. */
function showPhoto(index) {
  if (!state.photos.length) return;
  state.index = (index + state.photos.length) % state.photos.length;
  const photo = state.photos[state.index];

  const incoming = state.frontIsA ? el.slideB : el.slideA;
  const outgoing = state.frontIsA ? el.slideA : el.slideB;

  incoming.onload = () => {
    incoming.classList.add('visible');
    outgoing.classList.remove('visible');
    state.frontIsA = !state.frontIsA;
    el.stageMsg.hidden = true;
  };
  incoming.onerror = () => {
    el.stageMsg.textContent = `Could not load ${photo.name}.`;
    el.stageMsg.hidden = false;
  };
  incoming.alt = photo.name;
  incoming.src = photoUrl(photo);

  // Warm the next image so the transition is instant.
  if (state.photos.length > 1) {
    const next = state.photos[(state.index + 1) % state.photos.length];
    new Image().src = photoUrl(next);
  }

  updateCounter();
  resetTick();
}

function updateCounter() {
  el.counter.textContent = `${state.index + 1} / ${state.photos.length}`;
}

function next(auto) {
  const atEnd = state.index === state.photos.length - 1;
  if (atEnd && !state.loop) {
    // Ran off the end with looping off — hold on the last slide.
    if (auto) pause();
    return;
  }
  if (atEnd && state.shuffle && auto) shufflePhotos();
  showPhoto(state.index + 1);
}

function prev() {
  showPhoto(state.index - 1);
}

function play() {
  if (!state.photos.length) return;
  state.playing = true;
  el.playBtn.textContent = '❚❚';
  el.playBtn.title = 'Pause (Space)';
  resetTick();
}

function pause() {
  state.playing = false;
  el.playBtn.textContent = '▶';
  el.playBtn.title = 'Play (Space)';
  clearTimeout(state.timer);
  state.timer = null;
  cancelAnimationFrame(state.rafId);
}

function togglePlay() {
  if (state.playing) pause();
  else play();
}

function restart() {
  if (!state.photos.length) return;
  if (state.shuffle) shufflePhotos();
  showPhoto(0);
  play();
}

/** Restart the advance timer and drive the progress bar. */
function resetTick() {
  clearTimeout(state.timer);
  cancelAnimationFrame(state.rafId);
  el.progressBar.style.width = '0%';
  if (!state.playing) return;

  state.tickStart = performance.now();
  state.timer = setTimeout(() => next(true), state.interval);

  const step = () => {
    if (!state.playing) return;
    const pct = Math.min(100, ((performance.now() - state.tickStart) / state.interval) * 100);
    el.progressBar.style.width = `${pct}%`;
    if (pct < 100) state.rafId = requestAnimationFrame(step);
  };
  state.rafId = requestAnimationFrame(step);
}

function shufflePhotos() {
  for (let i = state.photos.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [state.photos[i], state.photos[j]] = [state.photos[j], state.photos[i]];
  }
}

/* ── Player controls ──────────────────────────────────────────────────────── */

el.playBtn.addEventListener('click', togglePlay);
el.nextBtn.addEventListener('click', () => next(false));
el.prevBtn.addEventListener('click', prev);
el.restartBtn.addEventListener('click', restart);
el.stopBtn.addEventListener('click', stopSlideshow);
el.refreshBtn.addEventListener('click', loadFolders);

el.speedSelect.addEventListener('change', () => {
  state.interval = Number(el.speedSelect.value);
  resetTick();
});

el.shuffleBtn.addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  el.shuffleBtn.setAttribute('aria-pressed', String(state.shuffle));
  if (state.shuffle && state.photos.length) {
    const current = state.photos[state.index];
    shufflePhotos();
    state.index = state.photos.indexOf(current);
    updateCounter();
  }
});

el.loopBtn.addEventListener('click', () => {
  state.loop = !state.loop;
  el.loopBtn.setAttribute('aria-pressed', String(state.loop));
});

el.fullscreenBtn.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else el.player.requestFullscreen().catch(() => {});
});

// Click the image area to pause/resume.
el.stage.addEventListener('click', togglePlay);

// Hide the chrome after a few idle seconds while playing.
let idleTimer = null;
function markActive() {
  el.player.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (state.playing && !el.player.hidden) el.player.classList.add('idle');
  }, 3000);
}
el.player.addEventListener('mousemove', markActive);
el.player.addEventListener('touchstart', markActive, { passive: true });

document.addEventListener('keydown', (event) => {
  if (el.player.hidden) return;
  if (event.target.matches('input, select, textarea')) return;
  markActive();

  switch (event.key) {
    case ' ': event.preventDefault(); togglePlay(); break;
    case 'ArrowRight': event.preventDefault(); next(false); break;
    case 'ArrowLeft': event.preventDefault(); prev(); break;
    case 'Escape': event.preventDefault(); stopSlideshow(); break;
    case 'r': case 'R': restart(); break;
    case 'f': case 'F': el.fullscreenBtn.click(); break;
    case 's': case 'S': el.shuffleBtn.click(); break;
    case 'l': case 'L': el.loopBtn.click(); break;
    default: break;
  }
});

// Don't burn through slides in a hidden tab.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.playing) pause();
});

/* ── Access gate ──────────────────────────────────────────────────────────── */

function enterApp() {
  el.gate.hidden = true;
  el.library.hidden = false;
  loadFolders();
}

el.gateForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  el.gateError.hidden = true;
  el.gateSubmit.disabled = true;
  try {
    await api('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: el.gateInput.value }),
    });
    el.gateInput.value = '';
    enterApp();
  } catch (err) {
    el.gateError.textContent = err.message;
    el.gateError.hidden = false;
  } finally {
    el.gateSubmit.disabled = false;
  }
});

/* ── Boot ─────────────────────────────────────────────────────────────────── */

state.interval = Number(el.speedSelect.value);

(async function boot() {
  try {
    const session = await api('/api/session');
    if (session.required && !session.authed) {
      el.gate.hidden = false;
      el.gateInput.focus();
      return;
    }
  } catch {
    // If the session probe fails, fall through and let the library show the error.
  }
  enterApp();
})();
