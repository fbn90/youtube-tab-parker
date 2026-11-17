import { allowRule, cleanTitle, DEFAULT_SETTINGS, isYoutubePage, MENU_ID, parkedUrl, readSettings, redirectRules, sameRules, targetFromParked, videoKey, videoUrl, YOUTUBE_SOURCES } from "./core.js";

const BASE = chrome.runtime.getURL("");
let initialization;
const releasing = new Set(); // Only a duplicate-click lock; never used as durable state.
const metadataLookups = new Map(), metadataResults = new Map();
let backgroundTitleLookups = 0;
const releaseRuleIds = new Set();
let releaseRuleLoad;
function loadReleaseRuleIds() {
  return releaseRuleLoad ??= chrome.declarativeNetRequest.getSessionRules().then(rules => {
    for (const rule of rules) releaseRuleIds.add(rule.id);
  }).catch(error => { releaseRuleLoad = undefined; throw error; });
}
const sourceBootstraps = new Map(); // Coalesce concurrent title requests, not a persistent cache.

function ensureSourceScript(tabId) {
  if (!Number.isInteger(tabId)) return Promise.resolve(false);
  if (sourceBootstraps.has(tabId)) return sourceBootstraps.get(tabId);
  const operation = (async () => {
    const tab = await chrome.tabs.get(tabId);
    if (tab.discarded || !isYoutubePage(tab.url)) return false;
    try {
      const response = await deadline(chrome.tabs.sendMessage(tabId, { type: "parker-ping" }, { frameId: 0 }),1000,null);
      if (response?.version === chrome.runtime.getManifest().version) return true;
    } catch { /* Open before install/update, or the extension was re-enabled. */ }
    // Manifest scripts do not run retroactively. Inject only our bundled file,
    // only into an already loaded YouTube document; never reload the source.
    await deadline(chrome.scripting.executeScript({ target: { tabId }, files: ["links.js"], world: "ISOLATED" }),1000,null);
    const response = await deadline(chrome.tabs.sendMessage(tabId, { type: "parker-ping" }, { frameId: 0 }),1000,null);
    return response?.version === chrome.runtime.getManifest().version;
  })().catch(() => false).finally(() => sourceBootstraps.delete(tabId));
  sourceBootstraps.set(tabId, operation);
  return operation;
}

async function bootstrapOpenSources() {
  const tabs = await chrome.tabs.query({ url: YOUTUBE_SOURCES });
  const loaded = tabs.filter(tab => !tab.discarded);
  let cursor=0;const results=[];
  await Promise.all(Array.from({length:Math.min(4,loaded.length)},async()=>{
    while(cursor<loaded.length){const tab=loaded[cursor++];results.push({status:"fulfilled",value:await ensureSourceScript(tab.id)})}
  }));
  return { loaded: loaded.length, ready: results.filter(result => result.status === "fulfilled" && result.value).length };
}

function initialize() {
  initialization ??= (async () => {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    const settings = await chrome.storage.local.get("loadOnSelect");
    if (typeof settings.loadOnSelect !== "boolean") await chrome.storage.local.set(DEFAULT_SETTINGS);
    const expected = redirectRules(BASE);
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    if (!sameRules(existing, expected)) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existing.map(rule => rule.id), addRules: expected
      });
    }
    // A closed tab must not leave a reusable permission behind.
    const [, tabs] = await Promise.all([loadReleaseRuleIds(), chrome.tabs.query({})]);
    const live = new Map(tabs.map(tab => [tab.id, tab]));
    const stale = [...releaseRuleIds].filter(id => {
      const tab = live.get(id);
      return !tab || !keepsRelease(tab.pendingUrl || tab.url);
    });
    if (stale.length) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: stale });
      for(const id of stale)releaseRuleIds.delete(id);
    }
  })().catch(error => {
    initialization = undefined;
    console.error("Tab Parker: Initialisierung fehlgeschlagen", error);
    throw error;
  });
  return initialization;
}

function isParkedSender(sender) {
  return sender.id === chrome.runtime.id && sender.frameId === 0 &&
    Number.isInteger(sender.tab?.id) && Boolean(targetFromParked(BASE, sender.url));
}

async function release(message, sender) {
  if (!isParkedSender(sender)) throw new Error("This request did not come from a parked tab.");
  const tabId = sender.tab.id;
  if (releasing.has(tabId)) return { ok: true, released: false };
  releasing.add(tabId);
  let ruleAttempted = false, navigated = false;
  try {
    await initialize();
    const tab = await chrome.tabs.get(tabId);
    const target = targetFromParked(BASE, tab.url);
    if (!target || target !== targetFromParked(BASE, sender.url) || (tab.pendingUrl && tab.pendingUrl !== tab.url)) {
      throw new Error("The tab has changed.");
    }
    const window = await chrome.windows.get(tab.windowId);
    // A message already in flight must not release a tab switched away from.
    if (!tab.active || !window.focused) return { ok: true, released: false };
    if (message.type === "release-on-select") {
      const settings = readSettings(await chrome.storage.local.get("loadOnSelect"));
      if (!settings.loadOnSelect) return { ok: true, released: false };
    }
    const rule = allowRule(tabId);
    // Await the browser's acknowledgement BEFORE initiating navigation.
    ruleAttempted = true;
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [rule.id], addRules: [rule] });
    releaseRuleIds.add(tabId);
    const current = await chrome.tabs.get(tabId);
    const currentWindow = await chrome.windows.get(current.windowId);
    const settings = readSettings(await chrome.storage.local.get("loadOnSelect"));
    if (!current.active || !currentWindow.focused || targetFromParked(BASE, current.url) !== target ||
        (current.pendingUrl && current.pendingUrl !== current.url) ||
        (message.type === "release-on-select" && !settings.loadOnSelect)) {
      return { ok: true, released: false };
    }
    await chrome.tabs.update(tabId, { url: target });
    navigated = true;
    return { ok: true, released: true };
  } finally {
    try {
      if (ruleAttempted && !navigated) await removeReleaseRule(tabId);
    } finally {
      releasing.delete(tabId);
    }
  }
}

async function status() {
  await initialize();
  let timer;
  const titleSources = await Promise.race([
    bootstrapOpenSources(),
    new Promise(resolve => { timer = setTimeout(() => resolve({ ready: 0, pending: true }), 1500); })
  ]).finally(() => clearTimeout(timer));
  const [rules, enabled, permissions] = await Promise.all([
    chrome.declarativeNetRequest.getDynamicRules(),
    chrome.declarativeNetRequest.getEnabledRulesets(),
    chrome.permissions.contains({ origins: ["*://*.youtube.com/*", "*://youtu.be/*"] })
  ]);
  return { ok: true, version: chrome.runtime.getManifest().version, titleSources,
    protected: permissions && enabled.includes("fail_closed") &&
    sameRules(rules, redirectRules(BASE)) };
}

async function createParkedTab(target, tab, title = "", channel = "") {
  const supplied={title:cleanTitle(title),channel:cleanTitle(channel)};
  const found=supplied.title&&supplied.channel?{}:await findSourceMetadata(tab?.id,target);
  const properties = { url: parkedUrl(BASE, target, supplied.title||found.title, supplied.channel||found.channel), active: false };
  if (Number.isInteger(tab?.id)) {
    properties.openerTabId = tab.id;
    properties.windowId = tab.windowId;
    properties.index = tab.index + 1;
  }
  await chrome.tabs.create(properties);
  return { ok: true };
}

const parkingRequests = new Map();
let nextReceiptCleanup = 0;
function parkClick(message, tab, target) {
  const park = () => createParkedTab(target, tab, cleanTitle(message.title), cleanTitle(message.channel));
  if (typeof message.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(message.requestId)) return park();
  const key = `parkerClick:${tab.id}:${message.requestId}`;
  if (parkingRequests.has(key)) return parkingRequests.get(key);
  const operation = (async () => {
    const session = chrome.storage.session;
    if (!session) return park();
    if (Date.now() >= nextReceiptCleanup) {
      nextReceiptCleanup = Date.now() + 60_000;
      const recent = await session.get(null);
      const expired = Object.keys(recent).filter(name => name.startsWith("parkerClick:") && Date.now() - recent[name]?.at > 120_000);
      if (expired.length) await session.remove(expired);
    }
    const receipt = (await session.get(key))[key];
    if (receipt?.target !== undefined && receipt.target !== target) throw Error("The video link has changed.");
    if (receipt?.done) return {ok:true};
    const matching = async () => (await chrome.tabs.query({windowId:tab.windowId}))
      .filter(item => item.openerTabId===tab.id && targetFromParked(BASE,item.pendingUrl||item.url)===target)
      .map(item => item.id);
    const existing = await matching();
    if (receipt && existing.some(id => !receipt.before.includes(id))) {
      await session.set({[key]:{...receipt,done:true}});
      return {ok:true};
    }
    const pending = {target,before:existing,at:Date.now()};
    await session.set({[key]:pending});
    const result = await park();
    await session.set({[key]:{...pending,done:true}});
    return result;
  })().finally(() => parkingRequests.delete(key));
  parkingRequests.set(key,operation);
  return operation;
}

async function findSourceMetadata(tabId, target) {
  if (!Number.isInteger(tabId)) return {};
  try {
    if (!await ensureSourceScript(tabId)) return {};
    // Ask the already loaded source document. Never fetch YouTube/oEmbed.
    const result = await deadline(chrome.tabs.sendMessage(tabId, { type: "find-video-title", url: target }, { frameId: 0 }),1000,{});
    return {title:cleanTitle(result?.title),channel:cleanTitle(result?.channel)};
  } catch { return {}; }
}

async function findLocalMetadata(target, openerTabId, parkedTabId, incognito) {
  const key=`${incognito?'private':'normal'}:${videoKey(target)}`;
  const previous=metadataResults.get(key);
  if(previous&&Date.now()-previous.time<(previous.value.channel?300000:15000))return previous.value;
  if(metadataLookups.has(key))return metadataLookups.get(key);
  const operation=(async()=>{
    const sources=(await chrome.tabs.query({url:YOUTUBE_SOURCES}))
      .filter(tab=>tab.id!==parkedTabId&&!tab.discarded&&Boolean(tab.incognito)===Boolean(incognito)&&isYoutubePage(tab.url))
      .sort((a,b)=>Number(b.id===openerTabId)-Number(a.id===openerTabId)||Number(videoKey(b.url)===videoKey(target))-Number(videoKey(a.url)===videoKey(target))||Number(b.active)-Number(a.active));
    let found={title:"",channel:""};
    // Bounded source work: never walk every loaded tab for every placeholder.
    for(const source of sources.slice(0,4)) {
      const result=await deadline(findSourceMetadata(source.id,target),1500,{});
      if(result.title&&!found.title)found.title=result.title;
      if(result.channel&&!found.channel)found.channel=result.channel;
      if(found.title&&found.channel)break;
    }
    if(metadataResults.size>=256)metadataResults.delete(metadataResults.keys().next().value);
    metadataResults.set(key,{time:Date.now(),value:found});return found;
  })().finally(()=>metadataLookups.delete(key));
  metadataLookups.set(key,operation);return operation;
}

function deadline(promise,ms,fallback) {
  let timer;return Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(fallback),ms)})]).finally(()=>clearTimeout(timer));
}

async function resolveTitle(sender, openerOnly) {
  if (!isParkedSender(sender)) throw new Error("Invalid title request.");
  const tab = await chrome.tabs.get(sender.tab.id);
  const target = targetFromParked(BASE, tab.url);
  if (!target || target !== targetFromParked(BASE, sender.url)) throw new Error("The tab has changed.");
  let metadata;
  if (openerOnly) {
    if (!Number.isInteger(tab.openerTabId) || backgroundTitleLookups >= 4) return {ok:true};
    backgroundTitleLookups++;
    try {
      const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null);
      if (!opener || opener.discarded || Boolean(opener.incognito) !== Boolean(tab.incognito)) return {ok:true};
      metadata = await findSourceMetadata(opener.id, target);
    } finally {
      backgroundTitleLookups--;
    }
  } else metadata=await findLocalMetadata(target,tab.openerTabId,tab.id,tab.incognito);
  const current=await chrome.tabs.get(tab.id);
  if(targetFromParked(BASE,current.url)!==target||current.pendingUrl) return {ok:true,title:"",channel:""};
  return { ok: true, ...metadata };
}

function isYoutubeSender(sender) {
  try {
    const url = new URL(sender.url);
    return Number.isInteger(sender.tab?.id) && ["http:", "https:"].includes(url.protocol) &&
      (url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com"));
  } catch { return false; }
}

// Register synchronously so a sleeping MV3 worker can receive every event.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  let operation;
  if (message?.type === "release-on-select" || message?.type === "release-manual") {
    operation = release(message, sender);
  } else if (message?.type === "resolve-title") {
    operation = resolveTitle(sender, message.openerOnly === true);
  } else if (message?.type === "status" && sender.url === `${BASE}popup.html`) {
    operation = status();
  } else if (message?.type === "park-link" && isYoutubeSender(sender) && videoUrl(message.url)) {
    operation = parkClick(message, sender.tab, videoUrl(message.url));
  } else return false;
  operation.then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function removeReleaseRule(tabId) {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] });
  releaseRuleIds.delete(tabId);
}
chrome.tabs.onRemoved.addListener(tabId => {
  removeReleaseRule(tabId).catch(error => console.warn("Tab Parker could not remove the temporary rule", error));
});
const keepsRelease = url => isYoutubePage(url) || Boolean(videoUrl(url));
chrome.tabs.onUpdated?.addListener((id, change, tab) => {
  if ((!change.url && change.status !== "complete") ||
      keepsRelease(tab?.pendingUrl || change.url || tab?.url) || releasing.has(id)) return;
  loadReleaseRuleIds().then(async () => {
    if (!releaseRuleIds.has(id) || releasing.has(id)) return;
    const live = await chrome.tabs.get(id);
    // Chrome may redact the URL when a tab leaves YouTube host access.
    if (!keepsRelease(live.pendingUrl || live.url)) await removeReleaseRule(id);
  }).catch(error => console.warn("Tab Parker could not remove the temporary rule", error));
});

async function releaseSelected(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!targetFromParked(BASE, tab.url)) return;
    await release({ type: "release-on-select" }, { id: chrome.runtime.id, frameId: 0, tab, url: tab.url });
  } catch (error) {
    // A tab can disappear while a focus event is queued. Keep it parked on
    // every other failure; the local page still offers the manual button.
    console.debug("Tab Parker skipped automatic release", error.message);
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  releaseSelected(tabId);
  ensureSourceScript(tabId);
});
chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs.query({ active: true, windowId }).then(tabs => {
    for (const tab of tabs) releaseSelected(tab.id);
  }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  initialize().catch(() => {});
  bootstrapOpenSources().catch(error => console.debug("Tab Parker could not initialize source pages", error.message));
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID, title: "Park YouTube link", contexts: ["link"],
      targetUrlPatterns: ["*://*.youtube.com/watch*", "*://*.youtube.com/playlist*", "*://*.youtube.com/shorts/*",
        "*://*.youtube.com/live/*", "*://*.youtube.com/embed/*", "*://*.youtube.com/v/*", "*://youtu.be/*"]
    }, () => { if (chrome.runtime.lastError) console.error(chrome.runtime.lastError.message); });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const target = videoUrl(info.linkUrl);
  if (info.menuItemId !== MENU_ID || !target) return;
  // Strict route: create ONLY a local URL. No YouTube navigation is started.
  createParkedTab(target, tab).catch(error => console.error("Tab Parker could not park the link", error));
});

chrome.runtime.onStartup.addListener(() => {
  initialize().catch(() => {});
  bootstrapOpenSources().catch(() => {});
});

// Discovery exposes only public build identity and performs no tab action.
chrome.runtime.onMessageExternal?.addListener((message, sender, respond) => {
  if (!/^[a-p]{32}$/.test(sender.id || '') || message?.type !== 'tab-parker-identify') return false;
  respond({app:'youtube-tab-parker',protocol:1,id:chrome.runtime.id,version:chrome.runtime.getManifest().version});
  return false;
});
