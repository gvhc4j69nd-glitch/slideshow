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
  inFlight: new Map(),

  // Hand-off: this screen keeps its own copy and runs the show unaided.
  mode: 'live',
  startedAt: 0,
  interval: 5000,
  skew: 0,            // serverNow - Date.now(), so screens agree on the time
  held: 0,            // slides copied so far
  store: null,        // the Cache API bucket holding them
  clockTimer: null,
};

const MAX_CACHED = 6;

/* ── Keeping a copy, for hand-off ─────────────────────────────────────────── */

const storeName = () => `vinboo-${state.code}-${state.gen ?? 0}`;

/** Ask not to be evicted mid-evening. Best effort; refusal is not fatal. */
async function openStore() {
  if (!('caches' in window)) return null;
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
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
  let held = 0;
  for (let i = 0; i < state.photoCount && state.running; i += 1) {
    try {
      await fetchSlide(i);
      held += 1;
      if (held !== state.held) {
        state.held = held;
        if (held % 5 === 0 || held === state.photoCount) await reportHeld();
      }
    } catch {
      // A slide that will not come now may come later; keep going.
    }
  }
  state.held = held;
  await reportHeld();
}

/* ── Running the show without a presenter ─────────────────────────────────── */

const serverNow = () => Date.now() + state.skew;

/**
 * Every screen derives the slide from the same arithmetic, so they stay in step
 * with each other and need nobody to tell them what to show.
 */
function clockIndex() {
  if (!state.photoCount || !state.interval) return 0;
  const elapsed = Math.max(0, serverNow() - state.startedAt);
  return Math.floor(elapsed / state.interval) % state.photoCount;
}

function startClockPlayback() {
  if (state.clockTimer) return;
  const tick = () => {
    if (!state.running) return;
    const wanted = clockIndex();
    if (wanted !== state.index) {
      state.index = wanted;
      showSlide(wanted);
    }
  };
  tick();
  state.clockTimer = setInterval(tick, 400);
}

function stopClockPlayback() {
  clearInterval(state.clockTimer);
  state.clockTimer = null;
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

el.joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  el.joinError.hidden = true;
  el.joinSubmit.disabled = true;
  try {
    const code = el.joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const info = await api('/api/watch/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, password: el.joinPass.value }),
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
  applyState(info);
  markActive();
  pollState();

  // A handed-off show is this screen's responsibility from here: take a copy
  // while the presenter is still around to give one.
  if (state.mode === 'handoff') {
    startClockPlayback();
    precacheAll();
  }
}

/* ── Following the presenter ──────────────────────────────────────────────── */

function dropCache() {
  for (const url of state.cache.values()) URL.revokeObjectURL(url);
  state.cache.clear();
}

function applyState(info) {
  el.viewTitle.textContent = info.title || 'Slideshow';
  el.viewHost.textContent = info.host ? `Presented by ${info.host}` : '';
  state.photoCount = info.photoCount || 0;

  if (info.mode) state.mode = info.mode;
  if (Number.isFinite(info.now)) state.skew = info.now - Date.now();
  if (Number.isFinite(info.startedAt)) state.startedAt = info.startedAt;
  if (Number.isFinite(info.interval)) state.interval = info.interval;

  if (info.ended) {
    setStatus('Ended', 'bad');
    el.stageMsg.textContent = info.reason === 'expired'
      ? 'This slideshow has reached its end time and been taken down.'
      : info.reason === 'host-disconnected'
        ? 'The presenter disconnected.'
        : 'The presenter ended the slideshow.';
    el.stageMsg.hidden = false;
    state.running = false;
    stopClockPlayback();
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
    startClockPlayback();       // the clock decides, not the presenter
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

/* ── Pulling slides through the relay ─────────────────────────────────────── */

async function fetchSlide(index) {
  if (state.cache.has(index)) return state.cache.get(index);
  if (state.inFlight.has(index)) return state.inFlight.get(index);

  const pending = (async () => {
    const stored = await readStored(index);
    if (stored) {
      const fromDisk = URL.createObjectURL(stored);
      state.cache.set(index, fromDisk);
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
    state.cache.set(index, url);

    // Live shows can be long, so only a few object URLs are kept alive. A
    // handed-off show is capped at 50 slides, so it keeps all of them.
    while (state.mode !== 'handoff' && state.cache.size > MAX_CACHED) {
      const oldest = state.cache.keys().next().value;
      if (oldest === state.index) break;
      URL.revokeObjectURL(state.cache.get(oldest));
      state.cache.delete(oldest);
    }
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
  incoming.onerror = () => {
    el.stageMsg.textContent = 'That photo could not be displayed.';
    el.stageMsg.hidden = false;
  };
  incoming.src = url;

  // Warm the next slide so the presenter's advance looks instant here too.
  if (state.photoCount > 1) fetchSlide((index + 1) % state.photoCount).catch(() => {});
}

/* ── Controls ─────────────────────────────────────────────────────────────── */

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
  stopClockPlayback();
  for (const url of state.cache.values()) URL.revokeObjectURL(url);
  state.cache.clear();
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
