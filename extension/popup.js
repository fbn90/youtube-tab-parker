import { readSettings } from "./core.js";

const fieldset = document.querySelector("#mode");
const saved = document.querySelector("#saved");
const status = document.querySelector("#protection-label");
const thumbnailOption = document.querySelector("#show-thumbnails");
let savedLoadOnSelect;
document.querySelector("#version").textContent = `Version ${chrome.runtime.getManifest().version}`;

async function initialize() {
  try {
    const settings = readSettings(await chrome.storage.local.get(["loadOnSelect", "showThumbnails"]));
    savedLoadOnSelect = settings.loadOnSelect;
    document.querySelector(`input[value="${settings.loadOnSelect ? "select" : "click"}"]`).checked = true;
    fieldset.disabled = false;
    thumbnailOption.checked = settings.showThumbnails;
    thumbnailOption.disabled = false;
    const response = await chrome.runtime.sendMessage({ type: "status" });
    const active = response?.ok && response.protected;
    status.textContent = active ? "Protection active" : "Check protection. Reload the extension and allow access to YouTube.";
    document.querySelector("#protection").classList.toggle("warning", !active);
    const sources = response?.titleSources;
    document.querySelector("#title-sources").textContent = sources?.pending
      ? "Preparing title lookup. Tab protection is active independently."
      : sources?.ready
      ? `Title lookup is ready on ${sources.ready} open YouTube pages.`
      : "No loaded YouTube page is available for title lookup.";
  } catch {
    status.textContent = "Protection is unavailable. Reload the extension.";
    document.querySelector("#protection").classList.add("warning");
  }
}

fieldset.addEventListener("change", async event => {
  if (event.target.name !== "load-mode") return;
  const loadOnSelect = event.target.value === "select";
  fieldset.disabled = true;
  try {
    await chrome.storage.local.set({ loadOnSelect });
    savedLoadOnSelect = loadOnSelect;
    saved.textContent = "Saved.";
  } catch {
    document.querySelector(`input[value="${savedLoadOnSelect ? "select" : "click"}"]`).checked = true;
    saved.textContent = "Speichern fehlgeschlagen. Bitte erneut versuchen.";
  } finally {
    fieldset.disabled = false;
  }
});

thumbnailOption.addEventListener("change", async () => {
  const enabled = thumbnailOption.checked;
  thumbnailOption.disabled = true;
  try {
    await chrome.storage.local.set({ showThumbnails: enabled });
    saved.textContent = "Saved.";
  } catch {
    thumbnailOption.checked = !enabled;
    saved.textContent = "Speichern fehlgeschlagen. Bitte erneut versuchen.";
  } finally {
    thumbnailOption.disabled = false;
  }
});

initialize();
