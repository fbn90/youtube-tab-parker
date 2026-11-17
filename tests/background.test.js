import test from "node:test";
import assert from "node:assert/strict";
import { parkedUrl, redirectRules } from "../extension/core.js";

const id = "abcdefghijklmnopabcdefghijklmnop";
const base = `chrome-extension://${id}/`;
const target = "https://www.youtube.com/watch?v=abc&t=30";
let counter = 0;
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });

async function setup(options = {}) {
  const url = parkedUrl(base, target);
  const state = {
    tab: { id: 17, windowId: 2, active: true, url }, focused: true,
    settings: { loadOnSelect: true }, dynamic: redirectRules(base), session: [], trace: [],
    sources: [{ id: 8, windowId: 2, active: true, url: "https://www.youtube.com/source", discarded: false }], ...options
  };
  globalThis.chrome = {
    runtime: { id, getManifest: () => ({ version: "1.2.0" }), getURL: path => base + path, onMessage: event(), onMessageExternal: event(), onInstalled: event(), onStartup: event() },
    storage: { local: {
      async setAccessLevel() {}, async get() { return { ...state.settings }; },
      async set(value) { Object.assign(state.settings, value); }
    } },
    declarativeNetRequest: {
      async getDynamicRules() { return state.dynamic; },
      async updateDynamicRules(change) { state.dynamic = change.addRules; },
      async getSessionRules() { return [...state.session]; },
      async updateSessionRules(change) {
        if (state.ruleFailure && change.addRules) throw new Error("Browser denied rule update");
        state.trace.push("rules");
        state.session = state.session.filter(rule => !change.removeRuleIds?.includes(rule.id));
        state.session.push(...change.addRules || []);
        if (change.addRules && state.switchDuringRelease) state.tab.active = false;
        if (change.addRules && state.recoverDuringRelease) state.tab.url = parkedUrl(base, target, "Wiedergefundener Titel");
      },
      async getEnabledRulesets() { return ["fail_closed"]; }
    },
    tabs: {
      onRemoved: event(), onActivated: event(), onUpdated: event(),
      async get(tabId) { return { ...(tabId === state.tab.id ? state.tab : state.sources.find(tab => tab.id === tabId)) }; },
      async query(filter = {}) { return filter.url ? state.sources : [state.tab, ...state.sources]; },
      async update(tabId, properties) { state.trace.push("navigate"); state.navigation = { tabId, ...properties }; },
      async create(properties) { state.created = properties; },
      async sendMessage(tabId, message) {
        if (state.hungPings && message.type === "parker-ping") return new Promise(() => {});
        if (state.missingScript && !state.injected) throw new Error("No receiver");
        if (message.type === "parker-ping") return { version: "1.2.0" };
        state.titleRequest = { tabId, ...message };
        return { title: state.sourceTitle || "", channel: state.sourceChannel || "" };
      }
    },
    scripting: { async executeScript(injection) { state.injected = injection; } },
    windows: { onFocusChanged: event(), WINDOW_ID_NONE: -1, async get() { return { focused: state.focused }; } },
    permissions: { async contains() { return true; } },
    contextMenus: { onClicked: event(), removeAll(callback) { callback(); }, create() {} }
  };
  const api = globalThis.chrome;
  await import(`../extension/background.js?test=${counter++}`);
  const sender = { id, frameId: 0, url, tab: { id: 17 } };
  const send = (message, source = sender) => new Promise(resolve => {
    const keepOpen = api.runtime.onMessage.listeners[0](message, source, resolve);
    if (!keepOpen) resolve(undefined);
  });
  return { state, api, sender, send };
}

test("release acknowledges tab-scoped rules before navigating", async () => {
  const { state, send } = await setup();
  assert.deepEqual(await send({ type: "release-on-select" }), { ok: true, released: true });
  assert.deepEqual(state.trace, ["rules", "navigate"]);
  assert.equal(state.navigation.url, target);
  assert.deepEqual(state.session[0].condition.tabIds, [17]);
});

test("the protection status is bounded even when an existing source page never answers", async () => {
  const { send } = await setup({ hungPings: true });
  const response = await send({ type: "status" }, { id, frameId: 0, url: `${base}popup.html` });
  assert.equal(response.ok, true);
  assert.equal(response.protected, true);
  assert.equal(response.titleSources.pending, true);
});

test("background tabs and unfocused windows cannot be auto-released", async () => {
  for (const options of [{ tab: { id: 17, windowId: 2, active: false, url: parkedUrl(base, target) } }, { focused: false }]) {
    const { state, send } = await setup(options);
    assert.deepEqual(await send({ type: "release-on-select" }), { ok: true, released: false });
    assert.equal(state.navigation, undefined);
    assert.equal(state.session.length, 0);
  }
});

test("manual mode ignores tab selection but permits the load button", async () => {
  const { state, send } = await setup({ settings: { loadOnSelect: false } });
  assert.equal((await send({ type: "release-on-select" })).released, false);
  assert.equal(state.navigation, undefined);
  assert.equal((await send({ type: "release-manual" })).released, true);
});

test("an intervening tab switch rolls back the permission", async () => {
  const { state, send } = await setup({ switchDuringRelease: true });
  assert.equal((await send({ type: "release-on-select" })).released, false);
  assert.equal(state.navigation, undefined);
  assert.equal(state.session.length, 0);
});

test("rejected browser permission updates fail closed", async () => {
  const { state, send } = await setup({ ruleFailure: true });
  assert.equal((await send({ type: "release-manual" })).ok, false);
  assert.equal(state.navigation, undefined);
});

test("forged, embedded and stale release messages cannot navigate a tab", async () => {
  const { state, send, sender } = await setup();
  assert.equal(await send({ type: "release-manual" }, { ...sender, id: "foreign" }), undefined);
  for (const source of [{ ...sender, frameId: 1 }, { ...sender, url: "https://www.youtube.com/watch?v=abc" },
    { ...sender, url: parkedUrl(base, "https://youtu.be/different") }]) {
    assert.equal((await send({ type: "release-manual" }, source)).ok, false);
  }
  assert.equal(state.navigation, undefined);
});

test("context-menu parking creates only a local URL and retains the full fragment", async () => {
  const { api, state } = await setup();
  const url = `${target}#t=45`;
  api.contextMenus.onClicked.listeners[0]({ menuItemId: "park-youtube-link", linkUrl: url }, { id: 8, windowId: 2, index: 3 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.created.url, parkedUrl(base, url));
  assert.equal(state.created.active, false);
  assert.equal(state.navigation, undefined);
});

test("closed-tab permission is cleaned up", async () => {
  const { api, state, send } = await setup();
  await send({ type: "release-manual" });
  api.tabs.onRemoved.listeners[0](17);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.session.length, 0);
});

test("context menu reads the existing source title without navigating", async () => {
  const { api, state } = await setup({ sourceTitle: "  Ein\n Titel für später  " });
  api.contextMenus.onClicked.listeners[0]({ menuItemId: "park-youtube-link", linkUrl: target }, { id: 8, windowId: 2, index: 3 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(new URL(state.created.url).searchParams.get("title"), "Ein Titel für später");
  assert.equal(state.titleRequest.tabId, 8);
  assert.equal(state.titleRequest.url, target);
  assert.equal(state.navigation, undefined);
});

test("parked title recovery validates the video and rejects caller-supplied source IDs", async () => {
  const { send, state, sender } = await setup({
    tab: { id: 17, openerTabId: 8, windowId: 2, active: false, url: parkedUrl(base, target) },
    sourceTitle: "Titel aus der Quellseite"
  });
  assert.deepEqual(await send({ type: "resolve-title", tabId: 999, url: "https://youtu.be/other" }), {
    ok: true, title: "Titel aus der Quellseite", channel:""
  });
  assert.equal(state.titleRequest.tabId, 8);
  assert.equal(state.titleRequest.url, target);
  assert.equal((await send({ type: "resolve-title" }, { ...sender, frameId: 1 })).ok, false);
  assert.equal((await send({ type: "resolve-title" }, { ...sender, url: parkedUrl(base, "https://youtu.be/other") })).ok, false);
  assert.equal(state.navigation, undefined);
  assert.equal(state.session.length, 0);
});

test("background title recovery reads only the actual loaded opener in the same privacy context", async () => {
  const tab = { id: 17, openerTabId: 8, windowId: 2, active: false, url: parkedUrl(base, target) };
  const { send, state, api } = await setup({ tab, sourceTitle: "Titel im Hintergrund" });
  api.tabs.query = async () => { throw Error("Background recovery must not scan other tabs"); };
  assert.equal((await send({ type: "resolve-title", openerOnly: true })).title, "Titel im Hintergrund");
  assert.equal(state.titleRequest.tabId, 8);

  state.titleRequest = undefined;
  state.sources[0].discarded = true;
  assert.deepEqual(await send({ type: "resolve-title", openerOnly: true }), { ok: true });
  state.sources[0].discarded = false;
  state.sources[0].incognito = true;
  assert.deepEqual(await send({ type: "resolve-title", openerOnly: true }), { ok: true });
  assert.equal(state.titleRequest, undefined);
});

test("a source opened before installation is initialized without any navigation", async () => {
  const { state, send } = await setup({
    missingScript: true, sourceTitle: "Vorher schon geöffnete Seite",
    tab: { id: 17, openerTabId: 8, windowId: 2, active: false, url: parkedUrl(base, target) }
  });
  assert.equal((await send({ type: "resolve-title" })).title, "Vorher schon geöffnete Seite");
  assert.deepEqual(state.injected.target, { tabId: 8 });
  assert.deepEqual(state.injected.files, ["links.js"]);
  assert.equal(state.navigation, undefined);
});

test("a missing opener can be recovered from other already-loaded YouTube sources", async () => {
  const { state, send } = await setup({ sourceTitle: "Ohne Opener gefunden" });
  assert.equal((await send({ type: "resolve-title" })).title, "Ohne Opener gefunden");
  assert.equal(state.titleRequest.tabId, 8);
  assert.equal(state.navigation, undefined);
});

test("a clean source heading takes priority over a translated browser tab title", async () => {
  const { state, send } = await setup({
    sourceTitle: "This Is So Weird",
    sources: [{ id: 8, url: target, title: "This Is So WeirdDas ist so schräg - YouTube", discarded: false }]
  });
  assert.equal((await send({ type: "resolve-title" })).title, "This Is So Weird");
  assert.equal(state.titleRequest.tabId, 8);
  assert.equal(state.navigation, undefined);
});

test("discarded YouTube tabs are never resumed to recover titles", async () => {
  const { state, send } = await setup({
    sourceTitle: "Nicht lesen", sources: [{ id: 8, url: "https://www.youtube.com/source", discarded: true }]
  });
  assert.equal((await send({ type: "resolve-title" })).title, "");
  assert.equal(state.injected, undefined);
  assert.equal(state.titleRequest, undefined);
});

test("a locally recovered title cannot cancel automatic release of the same video", async () => {
  const { send, state } = await setup({ recoverDuringRelease: true });
  assert.equal((await send({ type: "release-on-select" })).released, true);
  assert.equal(state.navigation.url, target);
});


test('companion discovery returns public identity only and cannot release a tab',async()=>{
  const {api,state}=await setup();const handler=api.runtime.onMessageExternal.listeners[0];
  let response;const reply=value=>response=value;
  handler({type:'tab-parker-identify'},{id:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'},reply);
  assert.equal(response.app,'youtube-tab-parker');assert.equal(response.id,id);assert.equal(response.protocol,1);
  assert.deepEqual(Object.keys(response).sort(),['app','id','protocol','version']);
  response=undefined;
  handler({type:'release-manual'},{id:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'},reply);
  assert.equal(response,undefined);assert.equal(state.navigation,undefined);
});


test('source card channel is stored locally with title and never changes the original target',async()=>{
 const {api,state}=await setup({sourceTitle:'Michael Every & trade',sourceChannel:'Reinvent Money'});
 api.contextMenus.onClicked.listeners[0]({menuItemId:'park-youtube-link',linkUrl:target},{id:8,windowId:2,index:3});
 await new Promise(resolve=>setImmediate(resolve));
 const page=new URL(state.created.url);assert.equal(page.searchParams.get('channel'),'Reinvent Money');
 assert.equal(page.searchParams.get('title'),'Michael Every & trade');assert.equal(page.hash.slice(1),target);
 assert.equal(state.navigation,undefined);
});
test('parked metadata recovery does not read loaded sources in another privacy context',async()=>{
 const {state,send}=await setup({sourceTitle:'Private title',sourceChannel:'Private creator',sources:[{id:8,url:'https://youtube.com/source',discarded:false,incognito:true}]});
 const result=await send({type:'resolve-title'});assert.equal(result.title,'');assert.equal(result.channel,'');assert.equal(state.titleRequest,undefined);
});

test("a failed post-rule check rolls back the release permission", async () => {
  const { state, api, send } = await setup();
  const readWindow = api.windows.get;
  api.windows.get = async (...args) => {
    if (state.session.length) throw Error("Window changed during release");
    return readWindow(...args);
  };
  assert.equal((await send({type:"release-manual"})).ok,false);
  assert.equal(state.session.length,0);
  assert.equal(state.navigation,undefined);
});

test("a released tab loses its rule when leaving YouTube with a redacted URL", async () => {
  const { state, api, send } = await setup();
  assert.equal((await send({type:"release-manual"})).released,true);
  delete state.tab.url;
  api.tabs.onUpdated.listeners[0](17,{status:"complete"},{id:17});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(state.session.length,0);
});

test("retrying a click after a lost storage acknowledgement reuses the tab", async () => {
  const { state, api, send } = await setup();
  const saved={};
  let creates=0,failed=false;
  api.storage.session={
    get:async key=>key===null?{...saved}:{[key]:saved[key]},
    remove:async keys=>{for(const key of keys)delete saved[key]},
    set:async values=>{
      if(!failed&&Object.values(values).some(value=>value.done)){failed=true;throw Error("Receipt write failed")}
      Object.assign(saved,structuredClone(values));
    }
  };
  api.tabs.create=async properties=>{
    creates++;
    state.sources.push({...properties,id:19});
    return {id:19};
  };
  const source={id,url:"https://www.youtube.com/source",tab:{id:8,windowId:2,index:0}};
  const request={type:"park-link",url:target,title:"Video",channel:"Creator",requestId:"fc98d148-1840-443b-90d2-dead301afa88"};
  assert.equal((await send(request,source)).ok,false);
  assert.equal((await send(request,source)).ok,true);
  assert.equal(creates,1);
});
