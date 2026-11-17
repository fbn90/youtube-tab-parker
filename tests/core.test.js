import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { VIDEO_PATTERNS, cleanTitle, labelFor, parkedUrl, targetFromParked, videoUrl, readSettings, thumbnailUrl } from "../extension/core.js";

const base = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";

test("only real YouTube video routes can become navigation targets", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=abc&t=123&list=PLabc",
    "https://m.youtube.com/shorts/abc?feature=share", "https://youtube.com/live/abc",
    "https://music.youtube.com/watch?v=abc", "https://youtu.be/abc?t=34",
    "http://youtube.com/embed/abc", "https://youtube.com/v/abc", "https://youtube.com/playlist?list=PLabc"
  ]) assert.equal(videoUrl(url), url);
  for (const url of [
    "javascript:alert(1)", "data:text/html,test", "file:///etc/passwd", "https://youtube.com.evil.com/watch?v=abc",
    "https://evilyoutube.com/watch?v=abc", "https://youtu.be.evil.com/abc", "https://youtube.com@evil.com/watch?v=abc",
    "https://user:password@youtube.com/watch?v=abc", "https://youtube.com:8123/watch?v=abc",
    "https://youtube.com/results?search_query=test", "https://youtube.com/", "https://youtube.com/watchdog",
    "https://youtu.be/", "https://evil.com/?url=https://youtube.com/watch?v=abc", null, {}, "not a URL"
  ]) assert.equal(videoUrl(url), null, String(url));
});

test("local parking preserves timestamps, playlist, escaping and fragments", () => {
  const target = "https://www.youtube.com/watch?v=abc&t=90&list=PLabc&x=a%26b%23c&next=https%3A%2F%2Fexample.com#t=120";
  const parked = parkedUrl(base, target, '<img src=x onerror="alert(1)"> & #');
  assert.equal(targetFromParked(base, parked), target);
  assert.equal(new URL(parked).searchParams.get("title"), '<img src=x onerror="alert(1)"> & #');
  assert.equal(targetFromParked(base, `https://evil.com/parked.html#${target}`), null);
  assert.equal(targetFromParked(base, `${base}popup.html#${target}`), null);
  assert.equal(targetFromParked(base, `${base}parked.html#javascript:alert(1)`), null);
  assert.equal(targetFromParked(base, `${base}parked.html#https://evil.com/`), null);
});

test("packaged fail-closed gates match the redirect scopes before any response", async () => {
  const rules = JSON.parse(await readFile(new URL("../extension/rules/fail-closed.json", import.meta.url)));
  assert.deepEqual(rules.map(rule => rule.condition.regexFilter), VIDEO_PATTERNS);
  assert.ok(rules.every(rule => rule.action.type === "block" && !rule.condition.responseHeaders));
});

test("settings fail to the documented default and keep explicit manual mode", () => {
  assert.deepEqual(readSettings(undefined), { loadOnSelect: true, showThumbnails: true });
  assert.deepEqual(readSettings({ loadOnSelect: false, showThumbnails: false }), { loadOnSelect: false, showThumbnails: false });
  assert.equal(readSettings({ showThumbnails: "false" }).showThumbnails, true);
});

test("thumbnail addresses are restricted to real video IDs and one HTTPS image host", () => {
  const id = "aqz-KE-bpKQ";
  for (const url of [`https://www.youtube.com/watch?v=${id}&list=PLtest&t=10`, `https://youtu.be/${id}`, `https://m.youtube.com/shorts/${id}`, `https://youtube.com/live/${id}`, `https://youtube.com/embed/${id}`, `https://youtube.com/v/${id}`]) {
    assert.equal(thumbnailUrl(url), `https://i.ytimg.com/vi/${id}/mqdefault.jpg`);
  }
  for (const url of [null, "https://example.com/watch?v=aqz-KE-bpKQ", "https://youtube.com/playlist?list=PLabc", "https://youtu.be/../../secret", "https://youtube.com/watch?v=short", "https://youtube.com/watch?v=aaaaaaaaaaa%2Fredirect", "https://youtube.com/watch?v=aaaaaaaaaaaa"]) assert.equal(thumbnailUrl(url), null);
});

test("titles remain readable and Unicode-safe without showing video IDs as the fallback", () => {
  const title = `  ${"x".repeat(199)}🎬\n `;
  assert.equal(cleanTitle("  Ein\n\tVideo  "), "Ein Video");
  assert.equal(new URL(parkedUrl(base, "https://youtu.be/abc", title)).searchParams.get("title"), cleanTitle(title));
  assert.equal(labelFor("https://youtu.be/abc"), "YouTube video parked");
});

test("manifest has no blanket host access, external code or broad tabs permission", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url)));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions, ["*://*.youtube.com/*", "*://youtu.be/*"]);
  assert.ok(!manifest.permissions.includes("tabs"));
  assert.ok(!manifest.permissions.includes("webRequest"));
  assert.ok(manifest.content_security_policy.extension_pages.includes("connect-src 'none'"));
  assert.deepEqual(manifest.web_accessible_resources[0].resources, ["parked.html"]);
});


test("thumbnail CSP allows exactly the bundled images and the YouTube image service", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url)));
  const directives = Object.fromEntries(manifest.content_security_policy.extension_pages.split(';').map(value=>value.trim().split(/\s+/)).filter(parts=>parts[0]).map(([key,...values])=>[key,values]));
  assert.deepEqual(directives['img-src'], ["'self'", "https://i.ytimg.com"]);
  assert.deepEqual(directives['script-src'], ["'self'"]);
  assert.deepEqual(directives['connect-src'], ["'none'"]);
  for (const page of ['parked.html','popup.html']) {
    const html = await readFile(new URL(`../extension/${page}`, import.meta.url), 'utf8');
    assert.ok(!/http-equiv=["']Content-Security-Policy/i.test(html), 'no conflicting legacy meta policy');
  }
});
