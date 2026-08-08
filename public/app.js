'use strict';

/* ── State ────────────────────────────────────────────────────────────────── */

const state = {
  folders: [],
  folder: null,      // relative path of the folder being played
  photos: [],        // [{name, url, …}] in play order
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
  folderLabel: $('folderLabel'), counter: $('counter'),
  folderDialog: $('folderDialog'), folderForm: $('folderForm'),
  folderNameInput: $('folderNameInput'), folderError: $('folderError'),
  folderCancel: $('folderCancel'), fileInput: $('fileInput'),
  gate: $('gate'), gateForm: $('gateForm'), gateInput: $('gateInput'),
  gateError: $('gateError'), gateSubmit: $('gateSubmit'),
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

/* ── Library ──────────────────────────────────────────────────────────────── */

async function loadFolders() {
  el.refreshBtn.disabled = true;
  try {
    const data = await api('/api/folders');
    state.folders = data.folders;
    el.libRoot.textContent = data.root;
    el.notice.hidden = true;
    renderFolders();
  } catch (err) {
    showNotice(`Could not load folders: ${err.message}`);
  } finally {
    el.refreshBtn.disabled = false;
  }
}

function renderFolders() {
  el.folderGrid.replaceChildren();
  el.emptyState.hidden = state.folders.length > 0;

  for (const folder of state.folders) {
    const card = document.createElement('div');
    card.className = 'folder-card';

    const cover = document.createElement('button');
    cover.type = 'button';
    cover.className = 'folder-cover';
    cover.title = folder.count ? `Play ${folder.name}` : 'This folder has no photos yet';
    if (folder.cover) cover.style.backgroundImage = `url("${mediaUrl(folder.cover)}")`;
    else cover.textContent = '🗂';
    cover.disabled = folder.count === 0;
    cover.addEventListener('click', () => startSlideshow(folder.path));

    const body = document.createElement('div');
    body.className = 'folder-body';

    const name = document.createElement('div');
    name.className = 'folder-name';
    name.textContent = folder.path;
    name.title = folder.path;

    const sub = document.createElement('div');
    sub.className = 'folder-sub';
    sub.textContent = folder.count === 1 ? '1 photo' : `${folder.count} photos`;

    const buttons = document.createElement('div');
    buttons.className = 'folder-buttons';

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'btn btn-primary';
    playBtn.textContent = 'Play';
    playBtn.disabled = folder.count === 0;
    playBtn.addEventListener('click', () => startSlideshow(folder.path));

    const uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.className = 'btn';
    uploadBtn.textContent = 'Add photos';
    uploadBtn.addEventListener('click', () => pickFiles(folder.path, status));

    const status = document.createElement('div');
    status.className = 'upload-status';

    // Drag a batch of photos straight onto the card to upload them.
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
      if (files.length) uploadFiles(folder.path, files, status);
    });

    buttons.append(playBtn, uploadBtn);
    body.append(name, sub, buttons, status);
    card.append(cover, body);
    el.folderGrid.append(card);
  }
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

/* ── Slideshow ────────────────────────────────────────────────────────────── */

async function startSlideshow(folderPath) {
  try {
    const data = await api(`/api/photos?folder=${encodeURIComponent(folderPath)}`);
    if (!data.photos.length) {
      showNotice('That folder has no photos in it.');
      await loadFolders();
      return;
    }
    state.folder = data.folder;
    state.photos = data.photos;
    state.index = 0;
    if (state.shuffle) shufflePhotos();

    el.folderLabel.textContent = data.folder;
    el.library.hidden = true;
    el.player.hidden = false;
    el.stageMsg.hidden = true;
    el.slideA.classList.remove('visible');
    el.slideB.classList.remove('visible');
    state.frontIsA = false;

    showPhoto(0);
    play();
  } catch (err) {
    showNotice(`Could not start the slideshow: ${err.message}`);
  }
}

function stopSlideshow() {
  pause();
  state.folder = null;
  state.photos = [];
  state.index = 0;
  el.slideA.removeAttribute('src');
  el.slideB.removeAttribute('src');
  el.player.hidden = true;
  el.library.hidden = false;
  el.player.classList.remove('idle');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  loadFolders();
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
  incoming.src = photo.url;

  // Warm the next image so the transition is instant.
  if (state.photos.length > 1) {
    const next = state.photos[(state.index + 1) % state.photos.length];
    new Image().src = next.url;
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
