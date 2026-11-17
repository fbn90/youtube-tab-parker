// Keep these RE2-compatible patterns aligned with rules/fail-closed.json.
// No responseHeaders: the gate must run BEFORE a request is sent.
export const VIDEO_PATTERNS = [
  "^https?://([a-z0-9-]+\\.)*youtube\\.com/(watch([/?#].*)?|playlist([/?#].*)?|(shorts|live|embed|v)(/.*)?)$",
  "^https?://youtu\\.be/[^?#]+.*$"
];

export const DEFAULT_SETTINGS = Object.freeze({ loadOnSelect: true, showThumbnails: true });
export const MENU_ID = "park-youtube-link";
export const YOUTUBE_SOURCES = ["*://*.youtube.com/*"];

export function isYoutubePage(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      (url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com"));
  } catch { return false; }
}

export function videoKey(value) {
  const safe = videoUrl(value);
  if (!safe) return "";
  const url = new URL(safe);
  const parts = url.pathname.split("/").filter(Boolean);
  const videoId = url.hostname === "youtu.be" ? parts[0] : url.searchParams.get("v") ||
    (["shorts", "live", "embed", "v"].includes(parts[0]) ? parts[1] : "");
  if (videoId) return `video:${videoId}`;
  return parts[0] === "playlist" && url.searchParams.get("list") ? `playlist:${url.searchParams.get("list")}` : url.href;
}

export function cleanTitle(value) {
  if (typeof value !== "string") return "";
  return Array.from(value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, 200).join("");
}

export function thumbnailUrl(value) {
  const key = videoKey(value);
  const id = key.startsWith("video:") ? key.slice(6) : "";
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null;
}

export function videoUrl(value) {
  if (typeof value !== "string" || value.length > 16000) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.port) return null;
    if (!VIDEO_PATTERNS.some(pattern => new RegExp(pattern, "i").test(url.href))) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function parkedUrl(baseUrl, target, title = "", channel = "") {
  const safe = videoUrl(target);
  if (!safe) throw new Error("Unsupported YouTube video link.");
  // The fragment never goes to a server. Do not decode it: %26, %23 and
  // nested URLs in the original query must survive the round trip unchanged.
  const cleaned = cleanTitle(title);
  const fields = new URLSearchParams();
  if (cleaned) fields.set("title", cleaned);
  const creator = cleanTitle(channel);
  if (creator && !/^(unbekannt|unknown|youtube)$/i.test(creator)) fields.set("channel", creator);
  const query = fields.size ? `?${fields}` : "";
  return `${baseUrl}parked.html${query}#${safe}`;
}

export function targetFromParked(baseUrl, value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (`${url.protocol}//${url.host}${url.pathname}` !== `${baseUrl}parked.html`) return null;
    return videoUrl(url.hash.slice(1));
  } catch { return null; }
}

export function sameRules(left, right) {
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  return JSON.stringify(stable([...left].sort((a, b) => a.id - b.id))) ===
    JSON.stringify(stable([...right].sort((a, b) => a.id - b.id)));
}

export function labelFor(target) {
  return new URL(target).pathname === "/playlist" ? "YouTube playlist parked" : "YouTube video parked";
}

export function redirectRules(baseUrl) {
  return VIDEO_PATTERNS.map((regexFilter, index) => ({
    id: index + 1,
    priority: 10,
    action: { type: "redirect", redirect: { regexSubstitution: `${baseUrl}parked.html#\\0` } },
    condition: { regexFilter, resourceTypes: ["main_frame"] }
  }));
}

export function allowRule(tabId) {
  if (!Number.isInteger(tabId) || tabId < 1) throw new Error("Invalid tab.");
  return {
    id: tabId,
    priority: 100,
    action: { type: "allow" },
    condition: { tabIds: [tabId], requestDomains: ["youtube.com", "youtu.be"], resourceTypes: ["main_frame"] }
  };
}

export function readSettings(data) {
  return {
    loadOnSelect: typeof data?.loadOnSelect === "boolean" ? data.loadOnSelect : DEFAULT_SETTINGS.loadOnSelect,
    showThumbnails: typeof data?.showThumbnails === "boolean" ? data.showThumbnails : DEFAULT_SETTINGS.showThumbnails
  };
}
