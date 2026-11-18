import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';

// Tab Atelier pins this ID; the manifest key must keep every installation on it.
const STORE_ID = 'bhnabphdcdknjeebnmeikbdcncnfhdpf';

test('the manifest key yields the Chrome Web Store extension ID', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const hex = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  const id = [...hex].map(digit => String.fromCharCode(97 + parseInt(digit, 16))).join('');
  assert.equal(id, STORE_ID);
});
