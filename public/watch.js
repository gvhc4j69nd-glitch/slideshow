'use strict';

/**
 * Viewer for a shared slideshow.
 *
 * The presenter's browser holds the photos; this page mirrors whatever slide
 * they're on. It long-polls for state and pulls each photo through the relay,
 * which streams it from the presenter without ever storing it.
 */

const $ = (id) => document.getElementById(id);

const el = {
  join: $('join'), joinForm: $('joinForm'), joinCode: $('joinCode'), joinPass: $('joinPass'),
  joinError: $('joinError'), joinSubmit: $('joinSubmit'),
  viewer: $('viewer'), stage: $('stage'), slideA: $('slideA'), slideB: $('slideB'),
  stageMsg: $('stageMsg'), viewTitle: $('viewTitle'), viewCounter: $('viewCounter'),
  viewStatus: $('viewStatus'), viewHost: $('viewHost'), leaveBtn: $('leaveBtn'),
  viewFullscreenBtn: $('viewFullscreenBtn'),
  viewControls: $('viewControls'), viewPlayBtn: $('viewPlayBtn'),
  viewPrevBtn: $('viewPrevBtn'), viewNextBtn: $('viewNextBtn'),
  viewRestartBtn: $('viewRestartBtn'), viewSpeed: $('viewSpeed'),
};

const state = {
  code: null,
  version: null,
  index: -1,
  gen: null,
  photoCount: 0,
  frontIsA: true,
  running: false,
  cache: new Map(),   // index -> object URL of an already-fetched slide
  blobs: new Map(),   // index -> the bytes behind it, for the data: URL retry
  inFlight: new Map(),

  // Hand-off: this screen keeps its own copy and runs the show unaided.
  mode: 'live',
  startedAt: 0,
  interval: 5000,
  skew: 0,            // serverNow - Date.now(), so screens agree on the time
  held: 0,            // slides copied so far
  store: null,        // the Cache API bucket holding them
  cacheBytes: 0,      // decoded bytes held by state.cache, against the budget
  clockTimer: null,
  seeding: false,     // this screen is answering other screens' requests
  playing: true,      // hand-off only: this screen drives its own playback
  ownSpeed: false,    // the viewer picked a speed, so stop taking the show's
};

/*
 * Decoded slides are kept to a budget in bytes rather than a count.
 *
 * A count cannot be right for both cases: six slides is a few megabytes of
 * holiday photos and a rounding error of screenshots, and either way a show that
 * loops past six re-fetches every photo through the relay for the rest of the
 * evening. That is the dominant running cost of the whole service.
 *
 * A budget fixes that without the obvious alternative — keeping everything —
 * which would put a two-thousand-photo folder into a television's memory and
 * cause exactly the decode failures the wire format was reshaped to avoid.
 */
const CACHE_BUDGET_BYTES = 100 * 1024 * 1024;
const CACHE_MIN_SLIDES = 3;      // the one showing, the one coming, and one back
const PRECACHE_ATTEMPTS = 4;      // sweeps over the slides that didn't arrive
const PRECACHE_RETRY_MS = 1500;   // multiplied by the attempt, so it backs off
const SEED_RETRY_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── Keeping a copy, for hand-off ─────────────────────────────────────────── */

const storeName = () => `vinboo-${state.code}-${state.gen ?? 0}`;

/** Ask not to be evicted mid-evening. Best effort; refusal is not fatal. */
async function openStore() {
  if (!('caches' in window)) return null;
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
    // A screen keeps one show at a time. Anything left over from a slideshow
    // this screen watched last week is somebody's photos, so it goes now.
    await dropOtherStores();
    return await caches.open(storeName());
  } catch {
    return null;
  }
}

const slideKey = (index) => `/__vinboo/${state.code}/${state.gen ?? 0}/${index}`;

async function readStored(index) {
  if (!state.store) return null;
  try {
    const hit = await state.store.match(slideKey(index));
    return hit ? await hit.blob() : null;
  } catch {
    return null;
  }
}

async function writeStored(index, blob) {
  if (!state.store) return false;
  try {
    await state.store.put(slideKey(index), new Response(blob));
    return true;
  } catch {
    // Out of room. Whatever is already held still plays; the loop just gets
    // shorter, which beats failing outright on a television with little space.
    return false;
  }
}

/** Delete copies of every show but this one. */
async function dropOtherStores() {
  if (!('caches' in window)) return;
  const keep = storeName();
  try {
    for (const name of await caches.keys()) {
      if (name.startsWith('vinboo-') && name !== keep) await caches.delete(name);
    }
  } catch {
    // Nothing useful to do if the browser refuses.
  }
}

/** Delete this show's copy. Called when it ends, so nothing lingers. */
async function dropStore() {
  state.store = null;
  if (!('caches' in window)) return;
  try {
    for (const name of await caches.keys()) {
      if (name.startsWith(`vinboo-${state.code}-`)) await caches.delete(name);
    }
  } catch {
    // Nothing useful to do if the browser refuses.
  }
}

async function reportHeld() {
  try {
    await fetch(`/api/watch/${state.code}/cached`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ have: state.held }),
    });
  } catch {
    // The presenter's progress readout is a nicety, not a dependency.
  }
}

/**
 * Copy the whole show while the presenter is still here, so this screen can
 * carry on once they leave.
 */
async function precacheAll() {
  state.store = await openStore();

  /*
   * Slides can fail individually — the presenter's tab may be busy sending the
   * same photo to three other screens — so missing ones are swept up again
   * rather than left behind. A copy with a hole in it is not a copy, and this
   * screen cannot seed to anyone until it has the lot.
   */
  let missing = Array.from({ length: state.photoCount }, (unused, i) => i);
  for (let attempt = 0; attempt < PRECACHE_ATTEMPTS && missing.length && state.running; attempt += 1) {
    if (attempt) await sleep(PRECACHE_RETRY_MS * attempt);
    const failed = [];
    for (const index of missing) {
      if (!state.running) return;
      try {
        await fetchSlide(index);
      } catch {
        failed.push(index);
      }
    }
    const held = state.photoCount - failed.length;
    if (held !== state.held) {
      state.held = held;
      await reportHeld();
    }
    missing = failed;
  }

  state.held = state.photoCount - missing.length;
  await reportHeld();
  if (!missing.length) startSeeding();
}

/* ── Seeding: passing the show on to screens that arrive later ────────────── */

/**
 * Once this screen holds every slide it can answer requests itself, so a
 * television switched on an hour after the presenter left still gets the show.
 * The relay only routes work here when no presenting tab is listening.
 */
async function startSeeding() {
  if (state.seeding || state.mode !== 'handoff') return;
  state.seeding = true;

  while (state.running && state.mode === 'handoff') {
    try {
      const res = await fetch(`/api/watch/${state.code}/requests`);
      if (!res.ok) {
        if (res.status === 404) return;             // the show has ended
        await sleep(SEED_RETRY_MS);
        continue;
      }
      const { requests } = await res.json();
      for (const job of requests) await serveSlide(job);
    } catch {
      if (!state.running) return;
      await sleep(SEED_RETRY_MS);
    }
  }
  state.seeding = false;
}

async function serveSlide(job) {
  const blob = await readStored(job.index).catch(() => null);
  const path = `/api/watch/${state.code}/frame/${encodeURIComponent(job.reqId)}`;
  if (!blob) {
    await fetch(`${path}/error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'That screen no longer holds this photo.' }),
    }).catch(() => {});
    return;
  }
  await fetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  }).catch(() => {});
}

/* ── Running the show without a presenter ─────────────────────────────────── */

const serverNow = () => Date.now() + state.skew;

/**
 * Every screen derives the slide from the same arithmetic, so they stay in step
 * with each other and need nobody to tell them what to show.
 */
/*
 * A handed-off screen runs the show itself. It starts at the first photo rather
 * than dropping the viewer into the middle of a loop, and it keeps its own
 * timer, so the controls below actually control something. Nothing here talks
 * to the presenter — by this point there may not be one.
 */
function startLocalPlayback() {
  stopLocalPlayback();
  state.index = -1;
  state.playing = true;
  showLocal(0);
  el.viewControls.hidden = false;
  syncPlayButton();
  el.viewSpeed.value = String(state.interval);
  state.clockTimer = setInterval(() => {
    if (!state.running || !state.playing) return;
    showLocal((state.index + 1) % Math.max(1, state.photoCount));
  }, state.interval);
}

function stopLocalPlayback() {
  clearInterval(state.clockTimer);
  state.clockTimer = null;
}

/** Move this screen to a slide, and restart the dwell so it gets a full turn. */
function showLocal(index) {
  if (!state.photoCount) return;
  const wanted = ((index % state.photoCount) + state.photoCount) % state.photoCount;
  state.index = wanted;
  showSlide(wanted);
}

function restartLocalTimer() {
  if (!state.clockTimer) return;
  clearInterval(state.clockTimer);
  state.clockTimer = setInterval(() => {
    if (!state.running || !state.playing) return;
    showLocal((state.index + 1) % Math.max(1, state.photoCount));
  }, state.interval);
}

function syncPlayButton() {
  el.viewPlayBtn.textContent = state.playing ? '❚❚' : '▶';
  el.viewPlayBtn.title = state.playing ? 'Pause (Space)' : 'Play (Space)';
  el.viewPlayBtn.setAttribute('aria-pressed', String(state.playing));
}

function stepLocal(by) {
  if (!state.photoCount) return;
  showLocal(state.index + by);
  restartLocalTimer();
  markActive();
}

async function api(url, options) {
  const res = await fetch(url, options);
  const type = res.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await res.json() : null;
  if (!res.ok) throw Object.assign(new Error((body && body.error) || `Request failed (${res.status})`), { status: res.status, body });
  return body;
}

function setStatus(text, kind) {
  el.viewStatus.textContent = text;
  el.viewStatus.className = kind === 'bad' ? 'badge badge-sm badge-bad' : 'badge badge-sm';
}

/* ── Joining ──────────────────────────────────────────────────────────────── */

/*
 * The temporary password is read aloud as three groups — "DKCA, DEDX, EFEX" —
 * so nobody should have to hunt for the hyphen key, least of all on a
 * television remote. The field types them in as you go, and takes them out of
 * anything pasted so a copied password lands correctly either way.
 */
const GROUP = 4;
const GROUPS = 3;

function groupPassword(raw) {
  const letters = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, GROUP * GROUPS);
  return letters.replace(/(.{4})(?=.)/g, '$1-');
}

/** Format as the user types, keeping the caret where they left it. */
function formatPasswordField() {
  const field = el.joinPass;
  const before = field.value.slice(0, field.selectionStart || 0);
  const typedBefore = before.replace(/[^A-Za-z0-9]/g, '').length;

  const formatted = groupPassword(field.value);
  if (formatted === field.value) return;
  field.value = formatted;

  // Walk forward until the same number of real characters is behind the caret,
  // so inserting a hyphen doesn't drag it backwards.
  let caret = 0;
  let seen = 0;
  while (caret < formatted.length && seen < typedBefore) {
    if (formatted[caret] !== '-') seen += 1;
    caret += 1;
  }
  while (caret < formatted.length && formatted[caret] === '-') caret += 1;
  field.setSelectionRange(caret, caret);
}

el.joinPass.addEventListener('input', formatPasswordField);

el.joinCode.addEventListener('input', () => {
  const field = el.joinCode;
  const caret = field.selectionStart;
  const tidy = field.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (tidy === field.value) return;
  field.value = tidy;
  field.setSelectionRange(Math.min(caret, tidy.length), Math.min(caret, tidy.length));
});

// Six characters is the whole code, so move on without waiting to be told.
el.joinCode.addEventListener('input', () => {
  if (el.joinCode.value.length === 6 && !el.joinPass.value) el.joinPass.focus();
});

el.joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  el.joinError.hidden = true;
  el.joinSubmit.disabled = true;
  try {
    const code = el.joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const info = await api('/api/watch/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, password: groupPassword(el.joinPass.value) }),
    });
    state.code = info.code;
    startViewing(info);
  } catch (err) {
    el.joinError.textContent = err.message;
    el.joinError.hidden = false;
  } finally {
    el.joinSubmit.disabled = false;
  }
});

function startViewing(info) {
  el.join.hidden = true;
  el.viewer.hidden = false;
  state.running = true;
  state.version = null;
  state.ownSpeed = false;
  applyState(info);
  markActive();
  pollState();

  // A handed-off show is this screen's responsibility from here: take a copy
  // while the presenter is still around to give one.
  if (state.mode === 'handoff') {
    startLocalPlayback();
    precacheAll();
  }
}

/* ── Following the presenter ──────────────────────────────────────────────── */

function dropCache() {
  releaseAll();
}

function applyState(info) {
  el.viewTitle.textContent = info.title || 'Slideshow';
  el.viewHost.textContent = info.host ? `Presented by ${info.host}` : '';
  state.photoCount = info.photoCount || 0;

  if (info.mode) state.mode = info.mode;
  if (Number.isFinite(info.now)) state.skew = info.now - Date.now();
  if (Number.isFinite(info.startedAt)) state.startedAt = info.startedAt;
  // The show's pace is the starting point, not a standing instruction: once
  // somebody at this screen has picked their own, polling must not undo it.
  if (Number.isFinite(info.interval) && !state.ownSpeed) state.interval = info.interval;

  if (info.ended) {
    setStatus('Ended', 'bad');
    el.stageMsg.textContent = info.reason === 'expired'
      ? 'This slideshow has reached its end time and been taken down.'
      : info.reason === 'host-disconnected'
        ? 'The presenter disconnected.'
        : 'The presenter ended the slideshow.';
    el.stageMsg.hidden = false;
    state.running = false;
    stopLocalPlayback();
    el.viewControls.hidden = true;
    // Nothing is meant to outlive the show, including this screen's copy.
    dropCache();
    dropStore();
    return;
  }

  // The presenter reshuffled, so a cached slide no longer matches its index.
  if (Number.isInteger(info.gen) && info.gen !== state.gen) {
    state.gen = info.gen;
    dropCache();
    state.index = -1;
  }

  if (state.mode === 'handoff') {
    const held = state.held;
    setStatus(held >= state.photoCount || !state.photoCount
      ? 'Running on this screen'
      : `Copying ${held}/${state.photoCount}`);
    el.viewCounter.textContent = `${state.index + 1} / ${state.photoCount}`;
    // This screen runs itself from here; startViewing kicked it off.
    return;
  }

  el.viewCounter.textContent = `${Math.min(info.index + 1, state.photoCount)} / ${state.photoCount}`;
  if (!info.hostLive) setStatus('Presenter away', 'bad');
  else setStatus(info.playing ? 'Live' : 'Paused');

  if (info.index !== state.index) {
    state.index = info.index;
    showSlide(info.index);
  }
}

async function pollState() {
  while (state.running) {
    try {
      const query = state.version === null ? '' : `?since=${state.version}`;
      const info = await api(`/api/watch/${state.code}/state${query}`);
      state.version = info.version;
      applyState(info);
    } catch (err) {
      if (err.status === 404) {
        applyState({ ...err.body, ended: true, title: el.viewTitle.textContent });
        return;
      }
      if (err.status === 401) {
        setStatus('Session expired', 'bad');
        el.stageMsg.textContent = 'Enter the code and password again.';
        el.stageMsg.hidden = false;
        state.running = false;
        el.viewer.hidden = true;
        el.join.hidden = false;
        return;
      }
      setStatus('Reconnecting…', 'bad');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

const asDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error || new Error('Could not read that photo.'));
  reader.readAsDataURL(blob);
});

/* ── Holding decoded slides ───────────────────────────────────────────────── */

/** Let a slide go: revoke its object URL and stop counting its bytes. */
function release(index) {
  const url = state.cache.get(index);
  if (url) URL.revokeObjectURL(url);
  const blob = state.blobs.get(index);
  if (blob) state.cacheBytes = Math.max(0, state.cacheBytes - blob.size);
  state.cache.delete(index);
  state.blobs.delete(index);
}

function releaseAll() {
  for (const index of [...state.cache.keys()]) release(index);
  state.cache.clear();
  state.blobs.clear();
  state.cacheBytes = 0;
}

/**
 * Keep a decoded slide, then trim the oldest until the budget is met.
 *
 * The slide on screen and the one being warmed for next are never dropped —
 * evicting either would re-fetch the very photo about to be shown. Anything
 * else goes oldest first, which for a slideshow is also furthest from being
 * needed again.
 */
function hold(index, url, blob) {
  state.cache.set(index, url);
  state.blobs.set(index, blob);
  state.cacheBytes += blob.size;

  const spare = state.photoCount ? (state.index + 1) % state.photoCount : -1;
  for (const candidate of [...state.cache.keys()]) {
    if (state.cacheBytes <= CACHE_BUDGET_BYTES) break;
    if (state.cache.size <= CACHE_MIN_SLIDES) break;
    if (candidate === state.index || candidate === spare || candidate === index) continue;
    release(candidate);
  }
}

/* ── Pulling slides through the relay ─────────────────────────────────────── */

async function fetchSlide(index) {
  if (state.cache.has(index)) return state.cache.get(index);
  if (state.inFlight.has(index)) return state.inFlight.get(index);

  const pending = (async () => {
    const stored = await readStored(index);
    if (stored) {
      const fromDisk = URL.createObjectURL(stored);
      hold(index, fromDisk, stored);
      return fromDisk;
    }

    const res = await fetch(`/api/watch/${state.code}/photo/${index}`);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error((body && body.error) || `Could not load photo ${index + 1}`);
    }
    const blob = await res.blob();
    if (state.mode === 'handoff') await writeStored(index, blob);
    const url = URL.createObjectURL(blob);
    hold(index, url, blob);
    return url;
  })();

  state.inFlight.set(index, pending);
  try {
    return await pending;
  } finally {
    state.inFlight.delete(index);
  }
}

async function showSlide(index) {
  if (index < 0 || index >= state.photoCount) return;
  el.viewCounter.textContent = `${index + 1} / ${state.photoCount}`;

  let url;
  try {
    url = await fetchSlide(index);
  } catch (err) {
    el.stageMsg.textContent = err.message;
    el.stageMsg.hidden = false;
    return;
  }
  // The presenter may have moved on while that was in flight.
  if (index !== state.index) return;

  const incoming = state.frontIsA ? el.slideB : el.slideA;
  const outgoing = state.frontIsA ? el.slideA : el.slideB;
  incoming.onload = () => {
    incoming.classList.add('visible');
    outgoing.classList.remove('visible');
    state.frontIsA = !state.frontIsA;
    el.stageMsg.hidden = true;
  };

  /*
   * Some television browsers will not load a blob: URL into an <img> even
   * though they fetched the bytes perfectly well. Rather than give up, the same
   * bytes are offered again inline. It costs a base64 copy, which is why it is
   * a fallback and not the normal path.
   */
  let retried = false;
  incoming.onerror = async () => {
    const blob = state.blobs.get(index);
    if (!retried && blob) {
      retried = true;
      try {
        incoming.src = await asDataUrl(blob);
        return;
      } catch {
        // fall through to the message
      }
    }
    el.stageMsg.textContent = blob && blob.type && !/^image\//.test(blob.type)
      ? `This screen could not display that photo (${blob.type}).`
      : 'That photo could not be displayed on this screen.';
    el.stageMsg.hidden = false;
  };
  incoming.src = url;

  // Warm the next slide so the presenter's advance looks instant here too.
  if (state.photoCount > 1) fetchSlide((index + 1) % state.photoCount).catch(() => {});
}

/* ── Controls ─────────────────────────────────────────────────────────────── */

el.viewPlayBtn.addEventListener('click', () => {
  state.playing = !state.playing;
  syncPlayButton();
  if (state.playing) restartLocalTimer();
  markActive();
});

el.viewNextBtn.addEventListener('click', () => stepLocal(1));
el.viewPrevBtn.addEventListener('click', () => stepLocal(-1));

el.viewRestartBtn.addEventListener('click', () => {
  showLocal(0);
  restartLocalTimer();
  markActive();
});

el.viewSpeed.addEventListener('change', () => {
  state.interval = Number(el.viewSpeed.value) || state.interval;
  state.ownSpeed = true;
  restartLocalTimer();
  markActive();
});

/*
 * A television is driven by a remote, and a remote sends arrow keys. These are
 * the same shortcuts the presenter's player uses, so the two behave alike.
 */
document.addEventListener('keydown', (event) => {
  if (el.viewer.hidden || state.mode !== 'handoff') return;
  if (event.target instanceof HTMLSelectElement) return;
  switch (event.key) {
    case ' ': case 'Enter': event.preventDefault(); el.viewPlayBtn.click(); break;
    case 'ArrowRight': event.preventDefault(); stepLocal(1); break;
    case 'ArrowLeft': event.preventDefault(); stepLocal(-1); break;
    case 'r': case 'R': el.viewRestartBtn.click(); break;
    case 'f': case 'F': el.viewFullscreenBtn.click(); break;
    default: break;
  }
});

el.viewFullscreenBtn.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else el.viewer.requestFullscreen().catch(() => {});
});

/*
 * A television or a spare laptop is left showing this for the whole party, so
 * the chrome gets out of the way once nothing has happened for a few seconds.
 * Any movement, tap or key brings it back.
 */
let idleTimer = null;
function markActive() {
  el.viewer.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (state.running && !el.viewer.hidden) el.viewer.classList.add('idle');
  }, 3500);
}
for (const type of ['mousemove', 'keydown', 'touchstart', 'click']) {
  el.viewer.addEventListener(type, markActive, { passive: true });
}

el.leaveBtn.addEventListener('click', () => {
  state.running = false;
  stopLocalPlayback();
  el.viewControls.hidden = true;
  releaseAll();
  el.slideA.removeAttribute('src');
  el.slideB.removeAttribute('src');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  el.viewer.hidden = true;
  el.join.hidden = false;
});

document.addEventListener('keydown', (event) => {
  if (el.viewer.hidden) return;
  if (event.key === 'f' || event.key === 'F') el.viewFullscreenBtn.click();
  if (event.key === 'Escape' && !document.fullscreenElement) el.leaveBtn.click();
});

/* ── Arriving by link ─────────────────────────────────────────────────────── */

const params = new URLSearchParams(location.search);

/**
 * A cast or shared link carries a one-time ticket instead of the password, so a
 * television can join without anyone typing on it. The ticket is spent here;
 * from then on this screen holds an ordinary viewer session.
 */
async function redeemTicket(ticket) {
  el.joinError.hidden = true;
  el.joinSubmit.disabled = true;
  try {
    const info = await api('/api/watch/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    state.code = info.code;
    // Don't leave a spent ticket sitting in the address bar or in history.
    history.replaceState(null, '', '/watch');
    startViewing(info);
  } catch (err) {
    el.joinError.textContent = err.message;
    el.joinError.hidden = false;
    history.replaceState(null, '', '/watch');
  } finally {
    el.joinSubmit.disabled = false;
  }
}

if (params.get('ticket')) {
  redeemTicket(params.get('ticket'));
} else {
  // /watch?code=ABC123 just prefills the code; the password is still needed.
  if (params.get('code')) el.joinCode.value = params.get('code').toUpperCase();
  el.joinCode.focus();
}
