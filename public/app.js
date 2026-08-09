'use strict';

/* ── State ────────────────────────────────────────────────────────────────── */

const state = {
  user: null,
  signupCodeRequired: false,
  broadcast: null,   // {code, password, folderId, photos, expiresAt} while sharing
  localRoot: null,   // tree of folders picked off this device — never uploaded
  localPath: [],     // where we are in that tree
  source: 'local',   // everything plays from this device now
  folder: null,      // label of the folder being played
  photos: [],        // [{name, file}] — the show currently loaded
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
  library: $('library'), player: $('player'), notice: $('notice'),
  stage: $('stage'), slideA: $('slideA'), slideB: $('slideB'), stageMsg: $('stageMsg'),
  progressBar: $('progressBar'),
  playBtn: $('playBtn'), prevBtn: $('prevBtn'), nextBtn: $('nextBtn'),
  restartBtn: $('restartBtn'), stopBtn: $('stopBtn'), fullscreenBtn: $('fullscreenBtn'),
  shuffleBtn: $('shuffleBtn'), loopBtn: $('loopBtn'), speedSelect: $('speedSelect'),
  folderLabel: $('folderLabel'), counter: $('counter'), sourceTag: $('sourceTag'),
  gate: $('gate'), gateForm: $('gateForm'), gateUser: $('gateUser'), gatePass: $('gatePass'),
  gateSignupCode: $('gateSignupCode'), signupCodeRow: $('signupCodeRow'), gateHelp: $('gateHelp'),
  gateError: $('gateError'), gateSubmit: $('gateSubmit'),
  tabSignIn: $('tabSignIn'), tabRegister: $('tabRegister'),
  whoami: $('whoami'), signOutBtn: $('signOutBtn'),
  broadcastBar: $('broadcastBar'), bcTitle: $('bcTitle'), bcCode: $('bcCode'), bcPass: $('bcPass'),
  bcViewers: $('bcViewers'), bcShowBtn: $('bcShowBtn'), bcStopBtn: $('bcStopBtn'), bcWarn: $('bcWarn'),
  shareDialog: $('shareDialog'), shareCode: $('shareCode'), sharePass: $('sharePass'),
  shareUrl: $('shareUrl'), shareExpiry: $('shareExpiry'),
  shareCopyBtn: $('shareCopyBtn'), shareDoneBtn: $('shareDoneBtn'),
  localPanel: $('localPanel'), localGrid: $('localGrid'), localDrop: $('localDrop'),
  localStatus: $('localStatus'), localHelp: $('localHelp'), localCrumbs: $('localCrumbs'),
  chooseLocalBtn: $('chooseLocalBtn'), choosePhotosBtn: $('choosePhotosBtn'),
  chooseDeckBtn: $('chooseDeckBtn'), clearLocalBtn: $('clearLocalBtn'),
  localDirInput: $('localDirInput'), photoInput: $('photoInput'), deckInput: $('deckInput'),
  shareNowBtn: $('shareNowBtn'), castBtn: $('castBtn'),
  howToBtn: $('howToBtn'), howToMenu: $('howToMenu'), howToSteps: $('howToSteps'),
  libraryHowto: $('libraryHowto'),
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

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg|heic|heif|tiff?)$/i;

/** Some image types (HEIC especially) come through with an empty MIME type. */
const isImageFile = (file) => file.type.startsWith('image/') || IMAGE_EXT.test(file.name);

const DECK_EXT = /\.pptx$/i;
const isDeckFile = (file) => DECK_EXT.test(file.name);

/* ── Object URLs for local files ──────────────────────────────────────────── */

/**
 * Photos are played straight off the device via object URLs. Minting one per
 * photo up front would pin the whole folder, so they're created on demand and
 * the oldest are revoked once we're well past them.
 */
const liveUrls = [];
const MAX_LIVE_URLS = 8;

function photoUrl(photo) {
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

/** Card markup for a folder, a whole branch, or a presentation. */
function folderCard({ label, count, coverUrl, badge, badgeClass, onPlay, onOpen, icon, countLabel }) {
  const root = document.createElement('div');
  root.className = 'folder-card';

  const cover = document.createElement('button');
  cover.type = 'button';
  cover.className = 'folder-cover';
  cover.title = onOpen ? `Open ${label}` : (count ? `Play ${label}` : 'This folder has no photos yet');
  if (coverUrl) cover.style.backgroundImage = `url("${coverUrl}")`;
  else cover.textContent = icon || '🗂';
  cover.disabled = !onOpen && count === 0;
  // Clicking a folder's cover browses into it; a show's cover plays it.
  cover.addEventListener('click', onOpen || onPlay);

  const body = document.createElement('div');
  body.className = 'folder-body';

  const name = document.createElement('div');
  name.className = 'folder-name';
  name.textContent = label;
  name.title = label;

  const sub = document.createElement('div');
  sub.className = 'folder-sub';
  sub.textContent = countLabel || (count === 1 ? '1 photo' : `${count} photos`);

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
    tag.className = badgeClass ? `badge ${badgeClass}` : 'badge';
    tag.textContent = badge;
    body.append(tag);
  }
  body.append(buttons);
  root.append(cover, body);

  return { root, body, buttons };
}

/* ── On-device sources: folders, phone photo libraries, PowerPoint ─────────── */

const MAX_LOCAL_FILES = 20000;
const MAX_LOCAL_DEPTH = 6;
let localCoverUrls = [];

/** Measure text with a real canvas so deck text wraps where PowerPoint wraps it. */
const measureCanvas = document.createElement('canvas').getContext('2d');
function measureText(text, style) {
  measureCanvas.font = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}`
    + `${style.size}px ${style.font || 'Helvetica'}`;
  return measureCanvas.measureText(text).width;
}

function setLocalStatus(message, isError) {
  el.localStatus.textContent = message || '';
  el.localStatus.classList.toggle('err', Boolean(isError));
  el.localStatus.hidden = !message;
}

/* ── The tree ─────────────────────────────────────────────────────────────── */

function newNode(name) {
  // Month folders must sort chronologically, not alphabetically, or a phone's
  // photo library lists August before July.
  const month = MONTHS.indexOf(name);
  return {
    name,
    sortKey: month >= 0 ? String(month).padStart(2, '0') : name,
    folders: new Map(),
    photos: [],
    decks: [],
    coverUrl: null,
  };
}

/** Child folder names in display order. */
const sortedFolders = (node) => [...node.folders.values()]
  .sort((a, b) => collator.compare(a.sortKey, b.sortKey))
  .map((child) => child.name);

/** Every photo at or below a node, parents before children, each folder sorted. */
function deepPhotos(node, out = []) {
  for (const photo of node.photos) out.push(photo);
  for (const name of sortedFolders(node)) deepPhotos(node.folders.get(name), out);
  return out;
}

function deepCounts(node) {
  let photos = node.photos.length;
  let decks = node.decks.length;
  for (const child of node.folders.values()) {
    const sub = deepCounts(child);
    photos += sub.photos;
    decks += sub.decks;
  }
  return { photos, decks };
}

function coverFor(node) {
  if (node.coverUrl) return node.coverUrl;
  const first = deepPhotos(node)[0];
  if (!first) return null;
  node.coverUrl = URL.createObjectURL(first.file);
  localCoverUrls.push(node.coverUrl);
  return node.coverUrl;
}

/** Walk to the node the breadcrumb currently points at. */
function nodeAtPath(path) {
  let node = state.localRoot;
  for (const name of path) {
    if (!node) return null;
    node = node.folders.get(name);
  }
  return node || null;
}

/**
 * Build the tree from scanned items.
 * `items` is [{dir, name, file, kind}] with `dir` relative to the chosen root.
 */
function buildLocalTree(items, rootName) {
  const root = newNode(rootName);
  let deckSeq = 0;

  for (const item of items) {
    let node = root;
    for (const segment of item.dir.split('/').filter(Boolean)) {
      if (!node.folders.has(segment)) node.folders.set(segment, newNode(segment));
      node = node.folders.get(segment);
    }
    if (item.kind === 'deck') {
      node.decks.push({ id: `deck-${(deckSeq += 1)}`, name: item.name, file: item.file, slides: null });
    } else {
      node.photos.push({ name: item.name, file: item.file });
    }
  }

  const sortNode = (node) => {
    node.photos.sort((a, b) => collator.compare(a.name, b.name));
    node.decks.sort((a, b) => collator.compare(a.name, b.name));
    for (const child of node.folders.values()) sortNode(child);
  };
  sortNode(root);

  // Collapse chains of single folders that hold nothing themselves, so a pick
  // of "Pictures" doesn't open onto one lone "DCIM" the user must click through.
  let node = root;
  while (!node.photos.length && !node.decks.length && node.folders.size === 1) {
    const only = node.folders.values().next().value;
    only.name = `${node.name}/${only.name}`;
    node = only;
  }
  return node;
}

/** Drop the current on-device selection and free its thumbnails. */
function clearLocalFolders() {
  for (const url of localCoverUrls) URL.revokeObjectURL(url);
  localCoverUrls = [];
  state.localRoot = null;
  state.localPath = [];
  renderLocalBrowser();
  setLocalStatus('');
}

function adoptLocalFolders(items, rootName) {
  const photos = items.filter((i) => i.kind !== 'deck').length;
  const decks = items.length - photos;
  if (!items.length) {
    setLocalStatus(`No photos or presentations found in “${rootName}”.`, true);
    return;
  }

  clearLocalFolders();
  state.localRoot = buildLocalTree(items, rootName);
  state.localPath = [];
  renderLocalBrowser();

  const parts = [];
  if (photos) parts.push(`${photos} photo${photos === 1 ? '' : 's'}`);
  if (decks) parts.push(`${decks} presentation${decks === 1 ? '' : 's'}`);
  setLocalStatus(`Ready: ${parts.join(' and ')}. These stay on your device — nothing was uploaded.`);

  warnIfUndecodable(items);
}

/**
 * iPhones shoot HEIC. Safari can display it; most other browsers cannot, and
 * they fail silently per image. Probe one and say so up front instead.
 */
async function warnIfUndecodable(items) {
  const heic = items.filter((i) => /\.hei[cf]$/i.test(i.name));
  if (!heic.length) return;

  const url = URL.createObjectURL(heic[0].file);
  const decodes = await new Promise((resolve) => {
    const probe = new Image();
    probe.onload = () => resolve(probe.naturalWidth > 0);
    probe.onerror = () => resolve(false);
    probe.src = url;
  });
  URL.revokeObjectURL(url);

  if (!decodes) {
    setLocalStatus(
      `${heic.length} of these are HEIC photos, which this browser can't display. `
      + 'Safari shows them, or set your iPhone to transfer as JPEG '
      + '(Settings › Photos › Transfer to Mac or PC › Automatic).',
      true,
    );
  }
}

/* ── Browsing the hierarchy ───────────────────────────────────────────────── */

function renderLocalBrowser() {
  el.localGrid.replaceChildren();
  el.localCrumbs.replaceChildren();
  const root = state.localRoot;
  el.clearLocalBtn.hidden = !root;
  el.localCrumbs.hidden = !root;
  if (el.libraryHowto) el.libraryHowto.hidden = Boolean(root);

  if (!root) return;

  const node = nodeAtPath(state.localPath) || root;

  // Breadcrumb: root, then one entry per level, each clickable.
  const trail = [{ name: root.name, depth: 0 }].concat(
    state.localPath.map((name, i) => ({ name, depth: i + 1 })),
  );
  trail.forEach((entry, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      el.localCrumbs.append(sep);
    }
    const crumb = document.createElement('button');
    crumb.type = 'button';
    crumb.className = 'crumb';
    crumb.textContent = entry.name;
    crumb.disabled = i === trail.length - 1;
    crumb.addEventListener('click', () => {
      state.localPath = state.localPath.slice(0, entry.depth);
      renderLocalBrowser();
    });
    el.localCrumbs.append(crumb);
  });

  const totals = deepCounts(node);

  // Playing the folder you're standing in, including everything beneath it.
  if (totals.photos > 0) {
    const label = state.localPath.length ? state.localPath[state.localPath.length - 1] : root.name;
    const card = folderCard({
      label: `All of “${label}”`,
      count: totals.photos,
      coverUrl: coverFor(node),
      badge: node.folders.size ? 'Includes subfolders' : 'On this device',
      onPlay: () => playLocalFolder(node),
    });
    card.buttons.append(shareButton(() => playLocalFolder(node)));
    el.localGrid.append(card.root);
  }

  for (const name of sortedFolders(node)) {
    const child = node.folders.get(name);
    const counts = deepCounts(child);
    const card = folderCard({
      label: name,
      count: counts.photos,
      coverUrl: coverFor(child),
      badge: counts.decks ? `${counts.decks} presentation${counts.decks === 1 ? '' : 's'}` : null,
      badgeClass: counts.decks ? 'badge-deck' : null,
      onPlay: () => playLocalFolder(child),
      onOpen: () => {
        state.localPath = state.localPath.concat(name);
        renderLocalBrowser();
      },
    });

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn';
    openBtn.textContent = 'Open';
    openBtn.addEventListener('click', () => {
      state.localPath = state.localPath.concat(name);
      renderLocalBrowser();
    });
    card.buttons.append(openBtn);
    el.localGrid.append(card.root);
  }

  for (const deck of node.decks) {
    const card = folderCard({
      label: deck.name,
      count: deck.slides ? deck.slides.length : 1,
      coverUrl: null,
      icon: '📊',
      countLabel: deck.slides ? `${deck.slides.length} slides` : 'PowerPoint',
      badge: 'Presentation',
      badgeClass: 'badge-deck',
      onPlay: () => playDeck(deck),
    });
    card.buttons.append(shareButton(() => playDeck(deck)));
    el.localGrid.append(card.root);
  }

  if (!el.localGrid.children.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Nothing to play in this folder.';
    el.localGrid.append(empty);
  }
}

/** A Share button that starts the show, then puts it live. */
function shareButton(startShow) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn';
  button.textContent = 'Share…';
  button.title = 'Stream this to other browsers with a code and temporary password';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await startShow();
      await shareCurrentShow();
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

/* ── Playing local shows ──────────────────────────────────────────────────── */

function playLocalFolder(node) {
  const photos = deepPhotos(node);
  if (!photos.length) {
    setLocalStatus('That folder has no photos in it.', true);
    return;
  }
  const label = [state.localRoot.name, ...state.localPath].join('/');
  beginPlayback(node === state.localRoot ? label : `${label}/${node.name}`.replace(/\/+/g, '/'),
    photos.map((p) => ({ ...p })));
}

/** Convert a .pptx to slides the first time it's played, then cache them. */
async function loadDeck(deck) {
  if (deck.slides) return deck.slides;
  setLocalStatus(`Opening “${deck.name}”…`);
  const buffer = await deck.file.arrayBuffer();
  const rendered = await Pptx.render(buffer, { measureText });

  // Each slide becomes an SVG blob, so decks flow through the player and the
  // live relay as ordinary images.
  deck.slides = rendered.slides.map((slide, i) => ({
    name: slide.title ? `${i + 1}. ${slide.title}` : `Slide ${i + 1}`,
    file: new Blob([slide.svg], { type: 'image/svg+xml' }),
  }));
  setLocalStatus(`“${deck.name}” — ${deck.slides.length} slides, converted in your browser.`);
  return deck.slides;
}

async function playDeck(deck) {
  try {
    const slides = await loadDeck(deck);
    renderLocalBrowser();
    beginPlayback(deck.name, slides.map((s) => ({ ...s })));
  } catch (err) {
    setLocalStatus(`Could not open “${deck.name}”: ${err.message}`, true);
  }
}

/* ── Picking sources ──────────────────────────────────────────────────────── */

const classify = (file) => (isDeckFile(file) ? 'deck' : isImageFile(file) ? 'photo' : null);

/* Source 1: File System Access API directory picker (Chrome, Edge). */
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
        const kind = classify(file);
        if (kind) items.push({ dir: relDir, name: handle.name, file, kind });
      } else if (handle.kind === 'directory' && depth < MAX_LOCAL_DEPTH) {
        await walk(handle, relDir ? `${relDir}/${handle.name}` : handle.name, depth + 1);
      }
    }
  };

  await walk(rootHandle, '', 0);
  adoptLocalFolders(items, rootHandle.name);
  if (truncated) setLocalStatus(`Stopped at ${MAX_LOCAL_FILES} files — that folder is very large.`, true);
}

/* Source 2: <input webkitdirectory> fallback (Firefox, and Android file manager). */
function pickLocalViaInput() {
  el.localDirInput.value = '';
  el.localDirInput.onchange = () => {
    const files = [...el.localDirInput.files];
    if (!files.length) return;

    const rootName = (files[0].webkitRelativePath || '').split('/')[0] || 'Selected folder';
    const items = [];
    for (const file of files) {
      if (items.length >= MAX_LOCAL_FILES) break;
      const kind = classify(file);
      if (!kind) continue;
      const parts = (file.webkitRelativePath || file.name).split('/');
      items.push({ dir: parts.slice(1, -1).join('/'), name: parts[parts.length - 1], file, kind });
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

/*
 * Source 3: the phone photo library.
 *
 * iOS and Android expose photos through the system picker, not as a folder
 * tree — there is no web API for albums. So the hierarchy is rebuilt from each
 * photo's own date, giving a Year › Month structure to browse.
 */
function pickPhotoLibrary() {
  el.photoInput.value = '';
  el.photoInput.onchange = () => {
    const files = [...el.photoInput.files];
    if (!files.length) return;

    const items = [];
    for (const file of files) {
      const kind = classify(file);
      if (!kind) continue;
      // Android's picker can supply a relative path; iOS never does.
      const relative = file.webkitRelativePath || '';
      const dir = relative.includes('/')
        ? relative.split('/').slice(0, -1).join('/')
        : dateFolder(file);
      items.push({ dir, name: file.name, file, kind });
    }
    adoptLocalFolders(items, 'Photo library');
  };
  el.photoInput.click();
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function dateFolder(file) {
  const stamp = Number(file.lastModified);
  if (!Number.isFinite(stamp) || stamp <= 0) return 'Undated';
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return 'Undated';
  return `${date.getFullYear()}/${MONTHS[date.getMonth()]}`;
}

/* Source 4: a single PowerPoint file. */
function pickDeck() {
  el.deckInput.value = '';
  el.deckInput.onchange = () => {
    const files = [...el.deckInput.files].filter(isDeckFile);
    if (!files.length) {
      const picked = el.deckInput.files[0];
      setLocalStatus(picked && /\.ppt$/i.test(picked.name)
        ? 'That is an older .ppt file. Save it as .pptx in PowerPoint and try again.'
        : 'Pick a .pptx PowerPoint file.', true);
      return;
    }
    adoptLocalFolders(
      files.map((file) => ({ dir: '', name: file.name, file, kind: 'deck' })),
      files.length === 1 ? files[0].name.replace(/\.pptx$/i, '') : 'Presentations',
    );
  };
  el.deckInput.click();
}

/* Source 5: dragging a folder onto the drop zone. */
function readEntryBatch(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walkDroppedEntry(entry, relDir, items, depth) {
  if (items.length >= MAX_LOCAL_FILES) return;
  if (entry.name.startsWith('.')) return;

  if (entry.isFile) {
    const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
    const kind = file && classify(file);
    if (kind) items.push({ dir: relDir, name: entry.name, file, kind });
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

  // A plain batch of files, no folder involved.
  if (!roots.length || roots.every((entry) => entry.isFile)) {
    const files = [...dataTransfer.files].filter((f) => classify(f));
    if (!files.length) {
      setLocalStatus('No photos or presentations in what you dropped.', true);
      return;
    }
    adoptLocalFolders(
      files.map((file) => ({ dir: '', name: file.name, file, kind: classify(file) })),
      'Dropped files',
    );
    return;
  }

  setLocalStatus('Reading dropped folder…');
  const items = [];
  let rootName = 'Dropped files';
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
el.choosePhotosBtn.addEventListener('click', pickPhotoLibrary);
el.chooseDeckBtn.addEventListener('click', pickDeck);
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

/* ── Sharing: stream this device's slideshow to other browsers ────────────── */

/**
 * While a broadcast is live this tab is the source of the photos. It parks a
 * long-poll waiting for viewers to ask for a slide, reads that file off disk,
 * and PUTs the bytes back for the relay to hand on. Nothing is stored server
 * side, which is exactly why this tab has to stay open.
 */
const isShareable = () => state.photos.length > 0 && state.photos.every((photo) => photo.file);

async function shareCurrentShow() {
  // Whatever is playing is what gets shared — a folder, a subtree, or a deck.
  if (!isShareable()) {
    showNotice('Start playing something from this device first, then share it.');
    return;
  }
  if (state.broadcast) await stopBroadcast({ silent: true });

  try {
    const info = await api('/api/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: state.folder, photoCount: state.photos.length }),
    });

    state.broadcast = {
      code: info.code,
      password: info.password,
      title: state.folder,
      photos: state.photos,     // the live playlist, so a reshuffle stays in step
      gen: 0,
      expiresAt: info.expiresAt,
      viewers: 0,
      running: true,
    };

    refreshShareUi();
    showShareDialog(info);
    serveRequests();            // background loop, deliberately not awaited
    pushBroadcastState();
  } catch (err) {
    showNotice(`Could not start sharing: ${err.message}`);
  }
}

/** Starting or stopping a share changes the folder cards too. */
function refreshShareUi() {
  renderBroadcastBar();
  renderLocalBrowser();
}

function renderBroadcastBar() {
  const bc = state.broadcast;
  el.broadcastBar.hidden = !bc;
  el.bcWarn.hidden = !bc;
  el.shareNowBtn.textContent = bc ? 'Stop sharing' : 'Share…';
  if (!bc) return;
  el.bcTitle.textContent = `Broadcasting “${bc.title || 'slideshow'}”`;
  el.bcCode.textContent = bc.code;
  el.bcPass.textContent = bc.password;
  el.bcViewers.textContent = bc.viewers === 1 ? '1 viewer' : `${bc.viewers} viewers`;
}

function showShareDialog(info) {
  el.shareCode.textContent = info.code;
  el.sharePass.textContent = info.password;
  el.shareUrl.textContent = `${location.host}/watch`;
  const expires = new Date(info.expiresAt);
  el.shareExpiry.textContent = `The code stops working when you stop sharing, or at ${expires.toLocaleTimeString()} at the latest.`;
  el.shareDialog.showModal();
}

el.bcShowBtn.addEventListener('click', () => {
  if (state.broadcast) showShareDialog(state.broadcast);
});
el.shareDoneBtn.addEventListener('click', () => el.shareDialog.close());
el.bcStopBtn.addEventListener('click', () => stopBroadcast({}));

el.shareCopyBtn.addEventListener('click', async () => {
  const bc = state.broadcast;
  if (!bc) return;
  const text = `Watch my slideshow at ${location.origin}/watch\nCode: ${bc.code}\nPassword: ${bc.password}`;
  try {
    await navigator.clipboard.writeText(text);
    el.shareCopyBtn.textContent = 'Copied';
    setTimeout(() => { el.shareCopyBtn.textContent = 'Copy both'; }, 2000);
  } catch {
    el.shareCopyBtn.textContent = 'Copy failed';
    setTimeout(() => { el.shareCopyBtn.textContent = 'Copy both'; }, 2000);
  }
});

async function stopBroadcast({ silent } = {}) {
  const bc = state.broadcast;
  if (!bc) return;
  bc.running = false;
  state.broadcast = null;
  refreshShareUi();
  try {
    await api(`/api/broadcast/${bc.code}`, { method: 'DELETE' });
  } catch {
    // The session may already have expired server side; nothing to undo.
  }
  if (!silent) showNotice('Stopped sharing. That code and password no longer work.', 'ok');
}

/** Long-poll for viewer requests and answer them with file bytes. */
async function serveRequests() {
  const bc = state.broadcast;
  while (bc && bc.running && state.broadcast === bc) {
    try {
      const batch = await api(`/api/broadcast/${bc.code}/requests`);
      if (!bc.running) return;

      if (bc.viewers !== batch.viewers) {
        bc.viewers = batch.viewers;
        renderBroadcastBar();
      }
      for (const job of batch.requests) sendFrame(bc, job);
    } catch (err) {
      if (!bc.running) return;
      if (err.status === 404 || err.status === 403) {
        // Server no longer knows about this broadcast — stop cleanly.
        state.broadcast = null;
        refreshShareUi();
        showNotice('Sharing ended.', 'ok');
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function sendFrame(bc, job) {
  const photo = bc.photos[job.index];
  if (!photo) return;
  try {
    await fetch(`/api/broadcast/${bc.code}/frame/${encodeURIComponent(job.reqId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': photo.file.type || 'application/octet-stream' },
      body: photo.file,
    });
  } catch {
    fetch(`/api/broadcast/${bc.code}/frame/${encodeURIComponent(job.reqId)}/error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'The presenter could not read that photo.' }),
    }).catch(() => {});
  }
}

/** Tell viewers which slide to show. */
function pushBroadcastState() {
  const bc = state.broadcast;
  if (!bc || !bc.running) return;
  api(`/api/broadcast/${bc.code}/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      index: state.index,
      playing: state.playing,
      photoCount: state.photos.length,
      gen: bc.gen || 0,
    }),
  }).catch(() => {});
}

// A closing tab should take its broadcast down with it rather than leaving the
// code alive until the host timeout notices.
window.addEventListener('pagehide', () => {
  const bc = state.broadcast;
  if (bc && navigator.sendBeacon) navigator.sendBeacon(`/api/broadcast/${bc.code}/end`, new Blob([], { type: 'text/plain' }));
});

/* ── Casting to a television ──────────────────────────────────────────────── */

/**
 * Cast by sending the *viewer page* to the television, not the pictures.
 *
 * The obvious route — Google's default media receiver — can't work here: it
 * fetches media by URL, and these photos are blob: URLs that exist only inside
 * this tab. Handing the TV /watch instead makes it an ordinary viewer, pulling
 * each slide through the same relay as everyone else, and it keeps following
 * along when you press next.
 *
 * The URL carries a one-time ticket rather than the password, so nothing
 * reusable ends up in a television's address bar or history.
 */
const canCast = typeof window.PresentationRequest === 'function';

async function castTicketUrl() {
  if (!state.broadcast) {
    await shareCurrentShow();
    if (!state.broadcast) return null;
  }
  const { url } = await api(`/api/broadcast/${state.broadcast.code}/cast-ticket`, { method: 'POST' });
  return url;
}

async function castToTelevision() {
  el.castBtn.disabled = true;
  try {
    const url = await castTicketUrl();
    if (!url) return;

    if (!canCast) {
      // No Presentation API here (Safari, Firefox, most phones). The link still
      // works on anything with a browser, so hand it over instead of failing.
      await offerCastLink(url);
      return;
    }

    const request = new PresentationRequest([url]);
    const connection = await request.start();   // opens Chrome's device picker
    connection.onclose = () => showNotice('The TV stopped showing the slideshow.', 'ok');
    showNotice('Sent to your TV. It will follow along as you present.', 'ok');
  } catch (err) {
    // Dismissing the device picker is a choice, not a failure.
    if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return;
    if (err && err.name === 'NotFoundError') {
      showNotice('No cast devices found on this network. Check the TV is on the same Wi-Fi.');
      return;
    }
    showNotice(`Could not cast: ${err.message}`);
  } finally {
    el.castBtn.disabled = false;
  }
}

/** Fallback: give the user a one-time link to open on the TV however they like. */
async function offerCastLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    showNotice('One-time TV link copied. Open it on the television — it works once, '
      + 'and only for the next few minutes.', 'ok');
  } catch {
    window.prompt('Open this on your TV. It works once, for the next few minutes:', url);
  }
}

el.castBtn.addEventListener('click', castToTelevision);

/* ── Slideshow ────────────────────────────────────────────────────────────── */

function beginPlayback(label, photos) {
  releasePlaylistUrls();
  state.folder = label;
  state.photos = photos;
  state.index = 0;
  if (state.shuffle) shufflePhotos();

  el.folderLabel.textContent = label;
  el.sourceTag.textContent = 'On this device';
  el.sourceTag.hidden = false;
  el.shareNowBtn.hidden = !isShareable();
  el.shareNowBtn.textContent = state.broadcast ? 'Stop sharing' : 'Share…';
  el.castBtn.hidden = !isShareable();
  el.castBtn.title = canCast
    ? 'Send this slideshow to a TV'
    : 'Copy a one-time link to open on a TV';
  el.library.hidden = true;
  el.player.hidden = false;
  el.stageMsg.hidden = true;
  el.slideA.classList.remove('visible');
  el.slideB.classList.remove('visible');
  state.frontIsA = false;

  // Point the broadcast at the exact array the player walks, so a later
  // shuffle keeps host and viewers referring to the same photo per index.
  if (state.broadcast && isShareable()) {
    state.broadcast.photos = state.photos;
    state.broadcast.gen = (state.broadcast.gen || 0) + 1;
  }

  showPhoto(0);
  play();
}

function stopSlideshow() {
  pause();
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
  pushBroadcastState();
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
  pushBroadcastState();
}

function pause() {
  state.playing = false;
  el.playBtn.textContent = '▶';
  el.playBtn.title = 'Play (Space)';
  clearTimeout(state.timer);
  state.timer = null;
  cancelAnimationFrame(state.rafId);
  pushBroadcastState();
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
  // Reordering changes what each index means, so viewers must drop their cache.
  // The swap above is in place, which keeps the broadcast's view of the
  // playlist pointing at the same array the player is using.
  if (state.broadcast) state.broadcast.gen = (state.broadcast.gen || 0) + 1;
}

/* ── Player controls ──────────────────────────────────────────────────────── */

el.playBtn.addEventListener('click', togglePlay);
el.nextBtn.addEventListener('click', () => next(false));
el.prevBtn.addEventListener('click', prev);
el.restartBtn.addEventListener('click', restart);
el.stopBtn.addEventListener('click', stopSlideshow);

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

el.shareNowBtn.addEventListener('click', () => {
  if (state.broadcast) stopBroadcast({});
  else shareCurrentShow();
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

// Don't burn through slides in a hidden tab — unless we're presenting, in
// which case pausing here would freeze every viewer's screen.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.playing && !state.broadcast) pause();
});

/* ── How-to content, shown on the landing page and in the header menu ─────── */

function mountHowTo() {
  const template = $('howToSteps');
  if (!template) return;
  for (const id of ['howToLanding', 'howToMenuBody', 'howToLibrary']) {
    const host = $(id);
    if (host && !host.childElementCount) host.append(template.content.cloneNode(true));
  }
}

function closeHowToMenu() {
  el.howToMenu.hidden = true;
  el.howToBtn.setAttribute('aria-expanded', 'false');
}

el.howToBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  const opening = el.howToMenu.hidden;
  el.howToMenu.hidden = !opening;
  el.howToBtn.setAttribute('aria-expanded', String(opening));
});

// Clicking anywhere else, or pressing Escape, closes it.
document.addEventListener('click', (event) => {
  if (!el.howToMenu.hidden && !event.target.closest('.menu')) closeHowToMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el.howToMenu.hidden) {
    closeHowToMenu();
    el.howToBtn.focus();
  }
});

/* ── Landing animation: one device, then many, faster and faster ──────────── */

/**
 * Screens join one at a time with the gap shrinking each time, so the sequence
 * reads as "and another, and another" rather than a steady drip. Driven from
 * script rather than CSS delays because the whole run has to reset and repeat
 * as a group, and it should stop when nobody is looking at it.
 */
let broadcastAnimationReady = false;

function startBroadcastAnimation() {
  const svg = $('bcast');
  const counter = $('bcastCount');
  // Safe to call again after signing out; the observer handles visibility.
  if (!svg || broadcastAnimationReady) return;
  broadcastAnimationReady = true;

  const devices = [...svg.querySelectorAll('.dev')].map((node) => node.dataset.dev);
  const setOn = (id, on) => {
    for (const node of svg.querySelectorAll(`[data-dev="${id}"]`)) node.classList.toggle('on', on);
  };
  const say = (n) => {
    if (counter) counter.textContent = n === 1 ? '1 screen' : `${n} screens`;
  };

  // Someone who prefers less motion gets the finished picture, held still.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    devices.forEach((id) => setOn(id, true));
    say(devices.length + 1);
    return;
  }

  let timer = null;
  let photoTimer = null;
  let photo = 0;

  const clear = () => {
    clearTimeout(timer);
    timer = null;
  };

  function run() {
    devices.forEach((id) => setOn(id, false));
    say(1);

    let index = 0;
    let gap = 900;                       // first screen joins after a beat…
    const step = () => {
      setOn(devices[index], true);
      index += 1;
      say(index + 1);

      if (index < devices.length) {
        gap = Math.max(190, gap * 0.78); // …each one after that lands sooner
        timer = setTimeout(step, gap);
      } else {
        timer = setTimeout(run, 3200);   // hold the full room, then start over
      }
    };
    timer = setTimeout(step, 700);
  }

  const start = () => {
    if (timer) return;
    run();
    photoTimer = setInterval(() => {
      photo = (photo + 1) % 3;
      svg.dataset.photo = String(photo);
    }, 2400);
  };

  const stop = () => {
    clear();
    clearInterval(photoTimer);
    photoTimer = null;
  };

  /*
   * Run by default and only pause on a signal we actually receive: scrolled
   * out of view, or a real tab-visibility change. Waiting for permission to
   * start would leave the graphic frozen on its first frame anywhere those
   * signals don't arrive — embedded webviews and prerendered pages among them —
   * and a stalled hero image reads as a broken page.
   */
  let onScreen = true;
  let tabHidden = false;
  const sync = () => (onScreen && !tabHidden ? start() : stop());

  new IntersectionObserver((entries) => {
    for (const entry of entries) onScreen = entry.isIntersecting;
    sync();
  }, { threshold: 0.15 }).observe(svg);

  document.addEventListener('visibilitychange', () => {
    tabHidden = document.hidden;
    sync();
  });

  sync();
}

/* ── Accounts ─────────────────────────────────────────────────────────────── */

let authMode = 'login';   // or 'register'

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === 'register';
  el.tabSignIn.classList.toggle('is-active', !registering);
  el.tabRegister.classList.toggle('is-active', registering);
  el.tabSignIn.setAttribute('aria-selected', String(!registering));
  el.tabRegister.setAttribute('aria-selected', String(registering));
  el.gateSubmit.textContent = registering ? 'Create account' : 'Sign in';
  el.gateHelp.textContent = registering
    ? 'Pick a username and a password of at least 8 characters.'
    : 'Sign in to your account to continue.';
  el.gatePass.autocomplete = registering ? 'new-password' : 'current-password';
  el.signupCodeRow.hidden = !(registering && state.signupCodeRequired);
  el.gateError.hidden = true;
}

el.tabSignIn.addEventListener('click', () => setAuthMode('login'));
el.tabRegister.addEventListener('click', () => setAuthMode('register'));

el.gateForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  el.gateError.hidden = true;
  el.gateSubmit.disabled = true;
  try {
    const payload = { username: el.gateUser.value.trim(), password: el.gatePass.value };
    if (authMode === 'register' && state.signupCodeRequired) payload.signupCode = el.gateSignupCode.value;

    const result = await api(authMode === 'register' ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    el.gatePass.value = '';
    el.gateSignupCode.value = '';
    enterApp(result.user);
  } catch (err) {
    el.gateError.textContent = err.message;
    el.gateError.hidden = false;
  } finally {
    el.gateSubmit.disabled = false;
  }
});

el.signOutBtn.addEventListener('click', async () => {
  await stopBroadcast({ silent: true });
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    // Signing out locally matters more than the round trip succeeding.
  }
  clearLocalFolders();
  state.user = null;
  el.library.hidden = true;
  el.gate.hidden = false;
  setAuthMode('login');
  startBroadcastAnimation();
  window.scrollTo({ top: 0 });
});

function enterApp(user) {
  closeHowToMenu();
  state.user = user;
  el.whoami.textContent = user ? `Signed in as ${user.username}` : '';
  el.gate.hidden = true;
  el.library.hidden = false;
  renderLocalBrowser();
}

/* ── Boot ─────────────────────────────────────────────────────────────────── */

state.interval = Number(el.speedSelect.value);

(async function boot() {
  let me = null;
  try {
    me = await api('/api/auth/me');
    state.signupCodeRequired = Boolean(me.signupCodeRequired);
  } catch {
    // Server unreachable; show the sign-in screen and let the attempt report it.
  }
  mountHowTo();
  setAuthMode('login');
  if (me && me.user) {
    enterApp(me.user);
  } else {
    el.gate.hidden = false;
    startBroadcastAnimation();
  }
})();
