/**
 * Fullscreen, on browsers that disagree about how to spell it.
 *
 * Safari and the WebKit forks inside most televisions carry only the prefixed
 * methods, and iOS has none at all for an ordinary element: asking there throws
 * a TypeError instead of returning a promise, so a `.catch()` never runs and
 * the button quietly does nothing.
 *
 * Worse, some browsers accept the request and then never finish it — the
 * promise stays pending for ever and no event arrives. So the promise is not
 * trusted on its own: after a moment, ask the document what actually happened.
 *
 * Where the API is missing or refused, fall back to hiding the page's own
 * chrome. That cannot remove the browser's toolbar, but it does give the photo
 * the whole window, which is most of the point on a screen nobody is sitting in
 * front of. The way back out is deliberately left on show.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Fullscreen = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WAIT_MS = 700;
  const CHANGE_EVENTS = ['fullscreenchange', 'webkitfullscreenchange',
    'mozfullscreenchange', 'MSFullscreenChange'];

  /** Whichever element is fullscreen, under whichever name this browser uses. */
  function active() {
    return document.fullscreenElement || document.webkitFullscreenElement
      || document.mozFullScreenElement || document.msFullscreenElement || null;
  }

  function request(node) {
    const ask = node.requestFullscreen || node.webkitRequestFullscreen
      || node.mozRequestFullScreen || node.msRequestFullscreen;
    if (!ask) return Promise.reject(new Error('no fullscreen here'));
    try {
      // Older WebKit returns undefined where the standard returns a promise.
      return Promise.resolve(ask.call(node));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function release() {
    const drop = document.exitFullscreen || document.webkitExitFullscreen
      || document.mozCancelFullScreen || document.msExitFullscreen;
    if (!drop) return Promise.resolve();
    try {
      return Promise.resolve(drop.call(document)).catch(function () {});
    } catch (err) {
      return Promise.resolve();
    }
  }

  /** Wire one button to one screen. Returns what the page needs to drive it. */
  function attach(options) {
    const screen = options.screen;
    const button = options.button;

    const inCinema = () => screen.classList.contains('cinema');

    function sync() {
      // If the real thing arrived late, the stand-in is no longer wanted.
      if (active()) screen.classList.remove('cinema');
      const on = Boolean(active()) || inCinema();
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
      button.title = on ? 'Leave fullscreen (F)' : 'Fullscreen (F)';
    }

    function setCinema(on) {
      if (on) screen.classList.add('cinema');
      else screen.classList.remove('cinema');
      sync();
    }

    function toggle() {
      if (active()) {
        release().then(sync);
        return;
      }
      if (inCinema()) {
        setCinema(false);
        return;
      }

      let decided = false;
      const decide = () => {
        if (decided) return;
        decided = true;
        if (active()) sync();
        else setCinema(true);
      };

      request(screen).then(decide, decide);
      setTimeout(decide, WAIT_MS);
    }

    /** On the way out of a show, leave it however it was entered. */
    function reset() {
      if (active()) release();
      setCinema(false);
    }

    button.addEventListener('click', toggle);

    /* The browser can leave fullscreen without asking: Escape, or a remote's
       back button. Keep the button's own state honest when that happens. */
    for (const type of CHANGE_EVENTS) document.addEventListener(type, sync);
    sync();

    return { toggle, sync, setCinema, inCinema, reset, active };
  }

  return { attach, active };
});
