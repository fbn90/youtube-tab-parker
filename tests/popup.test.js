import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { readSettings } from "../extension/core.js";

async function fixture(loadOnSelect) {
  const controls = new Map();
  const radios = [];
  function control(selector, properties = {}) {
    const listeners = new Map();
    const element = { disabled: true, textContent: "", ...properties,
      classList: { toggle() {}, add() {} },
      addEventListener(type, listener) { listeners.set(type, listener); },
      dispatch(type, event = {}) { return listeners.get(type)?.(event); }
    };
    controls.set(selector, element);
    return element;
  }
  for (const value of ["select", "click"]) {
    const radio = control(`input[value="${value}"]`, { name: "load-mode", value });
    Object.defineProperty(radio, "checked", {
      get() { return this.isChecked || false; },
      set(value) { if (value) for (const other of radios) other.isChecked = false; this.isChecked = value; }
    });
    radios.push(radio);
  }
  for (const selector of ["#mode", "#saved", "#protection-label", "#show-thumbnails", "#version", "#protection", "#title-sources"]) control(selector);
  const stored = { loadOnSelect, showThumbnails: true };
  const state = { failure: false, pending: null };
  const source = (await fs.readFile(new URL("../extension/popup.js", import.meta.url), "utf8"))
    .replace(/^import .*;\n/m, "");
  await vm.runInNewContext(source, {
    readSettings,
    document: { querySelector: selector => {
      assert.ok(controls.has(selector), `Unknown selector ${selector}`);
      return controls.get(selector);
    } },
    chrome: {
      runtime: { getManifest: () => ({ version: "test" }), sendMessage: async () => ({ ok: true, protected: true }) },
      storage: { local: {
        get: async () => ({ ...stored }),
        async set(values) {
          if (state.pending) await state.pending;
          if (state.failure) throw new Error("Storage unavailable");
          Object.assign(stored, values);
        }
      } }
    }
  });
  return { controls, stored, state,
    async choose(value) {
      const radio = controls.get(`input[value="${value}"]`);
      radio.checked = true;
      await controls.get("#mode").dispatch("change", { target: radio });
    }
  };
}

test("failed mode saves restore the persisted selection in either direction", async () => {
  for (const loadOnSelect of [true, false]) {
    const f = await fixture(loadOnSelect);
    f.state.failure = true;
    await f.choose(loadOnSelect ? "click" : "select");
    assert.equal(f.stored.loadOnSelect, loadOnSelect);
    assert.equal(f.controls.get('input[value="select"]').checked, loadOnSelect);
    assert.equal(f.controls.get('input[value="click"]').checked, !loadOnSelect);
    assert.equal(f.controls.get("#mode").disabled, false);
    assert.match(f.controls.get("#saved").textContent, /Speichern fehlgeschlagen/);
  }
});

test("mode save disables controls until completion and later failures restore the last successful choice", async () => {
  const f = await fixture(true);
  let complete;
  f.state.pending = new Promise(resolve => { complete = resolve; });
  const saving = f.choose("click");
  assert.equal(f.controls.get("#mode").disabled, true);
  complete();
  await saving;
  assert.equal(f.controls.get("#mode").disabled, false);
  assert.equal(f.stored.loadOnSelect, false);
  assert.equal(f.controls.get("#saved").textContent, "Saved.");
  f.state.pending = null;
  f.state.failure = true;
  await f.choose("select");
  assert.equal(f.controls.get('input[value="click"]').checked, true);
  assert.equal(f.stored.loadOnSelect, false);
});
