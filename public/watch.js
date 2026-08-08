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
};

const MAX_CACHED = 6;

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
  pollState();
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
  el.viewCounter.textContent = `${Math.min(info.index + 1, state.photoCount)} / ${state.photoCount}`;

  if (info.ended) {
    setStatus('Ended', 'bad');
    el.stageMsg.textContent = info.reason === 'host-disconnected'
      ? 'The presenter disconnected.'
      : 'The presenter ended the slideshow.';
    el.stageMsg.hidden = false;
    state.running = false;
    return;
  }

  if (!info.hostLive) setStatus('Presenter away', 'bad');
  else setStatus(info.playing ? 'Live' : 'Paused');

  // The presenter reshuffled, so a cached slide no longer matches its index.
  if (Number.isInteger(info.gen) && info.gen !== state.gen) {
    state.gen = info.gen;
    dropCache();
    state.index = -1;
  }

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
    const res = await fetch(`/api/watch/${state.code}/photo/${index}`);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error((body && body.error) || `Could not load photo ${index + 1}`);
    }
    const url = URL.createObjectURL(await res.blob());
    state.cache.set(index, url);

    // Keep only a few slides around so long shows don't grow without bound.
    while (state.cache.size > MAX_CACHED) {
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

el.leaveBtn.addEventListener('click', () => {
  state.running = false;
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

// Deep link: /watch?code=ABC123 prefills the code.
const params = new URLSearchParams(location.search);
if (params.get('code')) el.joinCode.value = params.get('code').toUpperCase();
el.joinCode.focus();
