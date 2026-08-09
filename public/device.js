/**
 * What kind of thing are we running on?
 *
 * Loaded synchronously in <head> so the classes are on <html> before first
 * paint and nothing flashes the wrong layout.
 *
 * This asks about *capabilities* rather than sniffing a browser name: whether
 * the pointer is a finger, whether hover exists, how big the screen is. A
 * laptop with a touchscreen and a phone in a desktop-sized window are both
 * real, and capability questions answer them correctly where a user-agent
 * string does not.
 *
 * The one exception is iOS, which needs naming: Safari there exposes the
 * `webkitdirectory` property on file inputs but ignores it, so the folder
 * picker cannot be feature-detected and has to be recognised.
 */
(function () {
  'use strict';

  const root = document.documentElement;
  const ua = navigator.userAgent || '';

  const query = (q) => window.matchMedia(q);
  const coarse = query('(pointer: coarse)');
  const canHover = query('(hover: hover)');

  // iPadOS reports itself as a Mac; the touch points give it away.
  const isIOS = /iPad|iPhone|iPod/.test(ua)
    || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);

  const state = {
    get touch() { return coarse.matches || navigator.maxTouchPoints > 0; },
    get hover() { return canHover.matches; },
    ios: isIOS,
    android: isAndroid,
    /** Installed to the home screen, so there's no browser chrome to allow for. */
    standalone: query('(display-mode: standalone)').matches || navigator.standalone === true,
    /** Picking a whole folder works on desktop and Android, but not on iOS. */
    get canPickFolders() { return !isIOS; },
  };

  function apply() {
    root.classList.toggle('is-touch', state.touch);
    root.classList.toggle('is-pointer', !state.touch);
    root.classList.toggle('no-hover', !state.hover);
    root.classList.toggle('is-ios', state.ios);
    root.classList.toggle('is-android', state.android);
    root.classList.toggle('is-standalone', state.standalone);
  }

  apply();

  // A tablet gaining a trackpad, or a window moving to another display, can
  // flip these mid-session.
  for (const mq of [coarse, canHover]) {
    if (mq.addEventListener) mq.addEventListener('change', apply);
    else if (mq.addListener) mq.addListener(apply);
  }

  window.Device = state;
})();
