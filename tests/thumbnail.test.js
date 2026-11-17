import test from "node:test";
import assert from "node:assert/strict";
import { createThumbnail, THUMBNAIL_TIMEOUT_MS } from "../extension/thumbnail.js";

function fixture(target = "https://youtu.be/aqz-KE-bpKQ") {
  const requests = [];
  class ImageElement extends EventTarget {
    hidden = true;
    naturalWidth = 320;
    set src(value) { requests.push(value); }
    removeAttribute() {}
    cloneNode() { return new ImageElement(); }
    replaceWith(next) { image = next; }
  }
  let image = new ImageElement();
  const timers = new Map();
  let timerId = 0;
  const setTimer = (callback, delay) => { assert.equal(delay, THUMBNAIL_TIMEOUT_MS); timers.set(++timerId, callback); return timerId; };
  const clearTimer = id => timers.delete(id);
  const classes = new Set();
  const figure = { hidden: true }, note = { textContent: "" }, retryButton = { hidden: true };
  const card = { classList: { add: c => classes.add(c), remove: c => classes.delete(c) } };
  let state = "hidden";
  const controller = createThumbnail({ target, image, figure, card, note, retryButton, visibility: () => state,
    setTimer, clearTimer, now: () => 12345 });
  return { controller, requests, get image() { return image; }, figure, note, classes, retryButton, timers,
    timeout: () => [...timers.values()][0]?.(), visible: () => state = "visible", hidden: () => state = "hidden" };
}

test("background tabs and disabled previews never start an image request", () => {
  const f = fixture();
  f.controller.update(true);
  assert.equal(f.requests.length, 0);
  f.visible(); f.controller.update(false);
  assert.equal(f.requests.length, 0);
  f.controller.update(true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.image.crossOrigin, "anonymous");
  assert.equal(f.image.referrerPolicy, "no-referrer");
  f.controller.update(true);
  assert.equal(f.requests.length, 1, "focus events must not reload the image");
  f.image.dispatchEvent(new Event("load"));
  assert.equal(f.image.hidden, false);
  f.controller.update(false);
  assert.equal(f.figure.hidden, true);
  assert.equal(f.image.hidden, true);
  assert.equal(f.classes.size, 0);
});

test("both failed image variants preserve the video controls without a focus retry loop", () => {
  for (const event of ["error", "load"]) {
    const f = fixture(); f.visible(); f.controller.update(true);
    f.image.naturalWidth = 120;
    f.image.dispatchEvent(new Event(event));
    assert.equal(f.requests.length, 2, 'one fallback image is attempted');
    f.image.naturalWidth = 120;
    f.image.dispatchEvent(new Event(event));
    assert.equal(f.figure.hidden, true);
    assert.equal(f.retryButton.hidden, false);
    assert.match(f.note.textContent, /Thumbnail unavailable/);
    f.controller.update(true);
    assert.equal(f.requests.length, 2, "do not retry repeatedly on visibility events");
  }
});

test('a failed first format can recover through the same-host fallback', () => {
  const f = fixture(); f.visible(); f.controller.update(true);
  f.image.dispatchEvent(new Event('error'));
  assert.deepEqual(f.requests, [
    'https://i.ytimg.com/vi/aqz-KE-bpKQ/mqdefault.jpg',
    'https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg'
  ]);
  f.image.dispatchEvent(new Event('load'));
  assert.equal(f.image.hidden, false);
  assert.equal(f.figure.hidden, false);
  assert.equal(f.retryButton.hidden, true);
  f.controller.update(true);
  assert.equal(f.requests.length, 2);
});

test('a fallback waits for a visible tab and respects opt-out', () => {
  const f = fixture(); f.visible(); f.controller.update(true); f.hidden();
  f.image.dispatchEvent(new Event('error'));
  assert.equal(f.requests.length, 1);
  f.controller.update(true);
  assert.equal(f.requests.length, 1);
  f.visible(); f.controller.update(true);
  assert.equal(f.requests.length, 2);
  f.controller.update(false);
  f.image.dispatchEvent(new Event('error'));
  assert.equal(f.requests.length, 2);
  assert.equal(f.retryButton.hidden, true);
});

test('only an explicit visible retry restarts an exhausted preview', () => {
  const f = fixture(); f.visible(); f.controller.update(true);
  assert.equal(f.controller.retry(), false, 'no concurrent retries');
  f.image.dispatchEvent(new Event('error')); f.image.dispatchEvent(new Event('error'));
  f.hidden(); assert.equal(f.controller.retry(), false);
  f.visible(); assert.equal(f.controller.retry(), true);
  assert.equal(f.requests.length, 3);
  assert.equal(f.retryButton.hidden, true);
  f.image.dispatchEvent(new Event('load'));
  assert.equal(f.image.hidden, false);
  assert.equal(f.controller.retry(), false);
  f.controller.update(false);
  assert.equal(f.controller.retry(), false);
});

test("playlist-only and forged targets cannot cause third-party requests", () => {
  for (const target of ["https://youtube.com/playlist?list=PLtest", "https://evil.example/watch?v=aqz-KE-bpKQ", null]) {
    const f = fixture(target); f.visible(); f.controller.update(true);
    assert.deepEqual(f.requests, []);
    assert.equal(f.figure.hidden, true);
  }
});


test('stalled images time out, fall back once and leave an explicit retry', () => {
  const f = fixture(); f.visible(); f.controller.update(true);
  assert.equal(f.timers.size, 1);
  f.timeout();
  assert.equal(f.requests.length, 2);
  assert.equal(f.timers.size, 1);
  f.timeout();
  assert.equal(f.timers.size, 0);
  assert.equal(f.retryButton.hidden, false);
  assert.equal(f.figure.hidden, true);
  f.controller.update(true);
  assert.equal(f.requests.length, 2);
});

test('an explicit retry bypasses cached failures and uses fresh image elements', () => {
  const f = fixture(); f.visible(); f.controller.update(true);
  const first = f.image;
  first.dispatchEvent(new Event('error'));
  const fallback = f.image;
  assert.notEqual(fallback, first);
  fallback.dispatchEvent(new Event('error'));
  assert.equal(f.controller.retry(), true);
  assert.equal(f.requests.at(-1), 'https://i.ytimg.com/vi/aqz-KE-bpKQ/mqdefault.jpg?parker_retry=12345-1');
  first.dispatchEvent(new Event('load'));
  fallback.dispatchEvent(new Event('error'));
  assert.equal(f.requests.length, 3);
  assert.equal(f.image.hidden, true);
  f.image.dispatchEvent(new Event('load'));
  assert.equal(f.image.hidden, false);
  assert.equal(f.timers.size, 0);
});

test('opt-out cancels the timer and late events cannot fail a re-enabled preview', () => {
  const f = fixture(); f.visible(); f.controller.update(true);
  const oldImage = f.image;
  const oldTimeout = [...f.timers.values()][0];
  f.controller.update(false);
  assert.equal(f.timers.size, 0);
  f.controller.update(true);
  assert.notEqual(f.image, oldImage);
  oldTimeout();
  oldImage.dispatchEvent(new Event('error'));
  oldImage.dispatchEvent(new Event('load'));
  assert.equal(f.requests.length, 2);
  assert.equal(f.image.hidden, true);
  assert.equal(f.retryButton.hidden, true);
  f.image.dispatchEvent(new Event('load'));
  assert.equal(f.image.hidden, false);
});
