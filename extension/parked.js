import { cleanTitle, labelFor, readSettings, targetFromParked } from "./core.js";
import { createThumbnail } from "./thumbnail.js";

const BASE = chrome.runtime.getURL("");
const button = document.querySelector("#load-video");
const message = document.querySelector("#message");
const retryThumbnail = document.querySelector('#retry-thumbnail');
let busy = false;
const target = targetFromParked(BASE, location.href);
const thumbnail = createThumbnail({ target,
  image: document.querySelector("#video-thumbnail"), figure: document.querySelector("#thumbnail-frame"),
  card: document.querySelector(".parking-card"), note: document.querySelector("#thumbnail-note"), retryButton: retryThumbnail,
  visibility: () => document.visibilityState
});
let modeRevision = 0;

function showMetadata(url) {
  const title = cleanTitle(url.searchParams.get('title'));
  const channel = cleanTitle(url.searchParams.get('channel'));
  document.title = title && channel ? `${channel} – ${title}` : title || labelFor(target);
  document.querySelector('#video-label').textContent = title || labelFor(target);
  const node = document.querySelector('#video-channel');
  node.textContent = channel;
  node.hidden = !channel;
}

let titleLookup;
function recoverTitle(openerOnly = false) {
  if (titleLookup) return titleLookup;
  titleLookup = resolveMetadata(openerOnly).finally(() => { titleLookup = undefined; });
  return titleLookup;
}

async function resolveMetadata(openerOnly) {
  const pageUrl = location.href;
  try {
    const response = await chrome.runtime.sendMessage({ type: "resolve-title", openerOnly });
    const title = response?.ok ? cleanTitle(response.title) : "";
    const channel=response?.ok?cleanTitle(response.channel):"";
    if ((!title&&!channel) || location.href !== pageUrl) return;
    const url = new URL(location.href);
    if(title)url.searchParams.set("title", title);
    if(channel)url.searchParams.set("channel",channel);
    // Preserve the recovered title through reloads, entirely locally.
    history.replaceState(null, "", url.href);
    showMetadata(url);
  } catch { /* No source title available. Keep the readable local fallback. */ }
}

async function release(manual = false) {
  if (busy || !target || document.visibilityState !== "visible" || window.top !== window) return;
  busy = true;
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: manual ? "release-manual" : "release-on-select" });
    if (!response?.ok) throw new Error(response?.error || "The extension is unavailable.");
    if (response.released) {
      message.textContent = "Loading YouTube …";
    } else {
      busy = false;
      button.disabled = false;
    }
  } catch (error) {
    busy = false;
    button.disabled = false;
    message.textContent = `${error.message} Bitte erneut versuchen.`;
  }
}

async function updateMode() {
  if (!target) return;
  const revision = ++modeRevision;
  try {
    const settings = readSettings(await chrome.storage.local.get(["loadOnSelect", "showThumbnails"]));
    if (revision !== modeRevision) return;
    message.textContent = settings.loadOnSelect ? "Loads when you select this tab." : "Loads when you click “Load video”.";
    // Auto-release needs no preview request on its way to the real video.
    thumbnail.update(!settings.loadOnSelect && settings.showThumbnails);
    if (settings.loadOnSelect) await release();
  } catch {
    message.textContent = "Settings are unavailable. You can still load the video manually.";
  }
}

if (target && window.top === window) {
  const url = new URL(location.href);
  showMetadata(url);
  if (!cleanTitle(url.searchParams.get('title')) || !cleanTitle(url.searchParams.get('channel'))) {
    if (document.visibilityState === 'visible') recoverTitle();
    else {
      // A redirected link has only a URL. Read its already loaded opener while
      // it still contains the link, and reserve the broader search for selection.
      if (!cleanTitle(url.searchParams.get('title'))) recoverTitle(true);
      const onVisible = async () => {
        if (document.visibilityState !== 'visible') return;
        document.removeEventListener('visibilitychange', onVisible);
        await titleLookup;
        const fields = new URL(location.href).searchParams;
        if (!cleanTitle(fields.get('title')) || !cleanTitle(fields.get('channel'))) recoverTitle();
      };
      document.addEventListener('visibilitychange', onVisible);
    }
  }
  document.querySelector("#video-url").textContent = target;
  button.disabled = false;
  button.addEventListener("click", event => { if (event.isTrusted) release(true); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") updateMode(); });
  window.addEventListener("focus", updateMode);
  // Never reuse an earlier validated target after a same-document hash change.
  window.addEventListener("hashchange", () => location.reload());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.loadOnSelect || changes.showThumbnails)) updateMode();
  });
  updateMode();
} else {
  message.textContent = "Invalid YouTube video link. Open a new video link in a tab.";
}

retryThumbnail.addEventListener('click', event => { if (event.isTrusted) thumbnail.retry(); });

document.querySelector("#settings").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
});
