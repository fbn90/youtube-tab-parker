import { thumbnailUrl } from "./core.js";

export const THUMBNAIL_TIMEOUT_MS = 8000;

// Image-only requests: no cookies, referrer, player, API key or arbitrary URLs.
export function createThumbnail({ target, image, figure, card, note, retryButton, visibility,
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
  const source = thumbnailUrl(target);
  const sources = source ? [source, source.replace('/mqdefault.jpg', '/hqdefault.jpg')] : [];
  let enabled = false;
  let state = 'idle';
  let candidate = 0;
  let request;
  let retryCount = 0;
  let retryToken = '';

  const hide = () => {
    figure.hidden = true;
    card.classList.remove("has-thumbnail");
  };
  function showRetry(show) {
    if (retryButton) retryButton.hidden = !show;
  }
  function clearRequest() {
    if (!request) return;
    clearTimer(request.timer);
    request.image.removeEventListener('load', request.load);
    request.image.removeEventListener('error', request.error);
    request = undefined;
  }
  function start() {
    if (!enabled || visibility() !== 'visible') return;
    clearRequest();
    // A separate element per attempt prevents a queued event from an aborted
    // request from completing or failing the next attempt.
    const nextImage = image.cloneNode(false);
    nextImage.removeAttribute('src');
    nextImage.crossOrigin = "anonymous";
    nextImage.referrerPolicy = "no-referrer";
    nextImage.decoding = "async";
    nextImage.hidden = true;
    image.replaceWith(nextImage);
    image = nextImage;
    state = 'loading';
    showRetry(false);
    figure.hidden = false;
    card.classList.add('has-thumbnail');
    note.textContent = 'Loading thumbnail …';
    const attempt = { image };
    const current = () => request === attempt && enabled && state === 'loading';
    attempt.load = () => {
      if (!current()) return;
      if (image.naturalWidth < 160) return fail();
      clearRequest();
      state = 'loaded';
      image.hidden = false;
      note.textContent = "Thumbnail from YouTube · The player stays off.";
    };
    attempt.error = () => { if (current()) fail(); };
    request = attempt;
    image.addEventListener('load', attempt.load);
    image.addEventListener('error', attempt.error);
    attempt.timer = setTimer(attempt.error, THUMBNAIL_TIMEOUT_MS);
    image.src = sources[candidate] + (retryToken ? `?parker_retry=${retryToken}` : '');
  }
  function fail() {
    clearRequest();
    image.removeAttribute('src');
    image.hidden = true;
    candidate++;
    hide();
    if (candidate < sources.length) {
      state = 'waiting';
      start();
      return;
    }
    state = 'failed';
    showRetry(true);
    note.textContent = "Thumbnail unavailable. Check your connection or try again.";
  }

  return {
    update(value) {
      enabled = Boolean(value && source);
      if (!enabled) {
        clearRequest();
        state = 'idle';
        candidate = 0;
        image.removeAttribute("src");
        image.hidden = true;
        hide();
        showRetry(false);
        note.textContent = source ? "Thumbnails off · The player stays off." : "The YouTube player stays off while this tab is parked.";
        return;
      }
      if (state === 'idle' || state === 'waiting') start();
    },
    retry() {
      if (!enabled || state !== 'failed' || visibility() !== 'visible') return false;
      candidate = 0;
      // Only an explicit retry bypasses a cached failed image response.
      retryToken = `${now()}-${++retryCount}`;
      start();
      return true;
    }
  };
}
