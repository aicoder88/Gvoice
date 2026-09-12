import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROFILE_LIST, profileInstructions, createDestinationProfiles } from '../../src/destination-profiles.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gvoice-profiles-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'destination-profiles.json');
  return { file, store: createDestinationProfiles(file) };
}

const config = (overrides = {}) => ({ mode: 'manual', selectedProfile: 'plain', mappings: [], ...overrides });
const editor = { id: 'com.example.editor', name: 'Editor' };

test('new preferences preserve Plain dictation without guessing app presets', t => {
  const { store, file } = fixture(t);
  for (const app of [null, editor, { id: 'com.apple.mail', name: 'Mail' }]) {
    assert.equal(store.resolve(app).profile, 'plain');
    assert.equal(store.resolve(app).source, 'manual');
  }
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(PROFILE_LIST.map(item => item.id), ['plain', 'email', 'chat', 'coding']);
});

test('manual selection overrides mappings; per-app routes only exact stable identities', t => {
  const { store, file } = fixture(t);
  const mappings = [{ ...editor, profile: 'coding' }];
  store.save(config({ selectedProfile: 'email', mappings }));
  assert.equal(store.resolve(editor).profile, 'email');
  store.save(config({ mode: 'per-app', selectedProfile: 'chat', mappings }));
  assert.equal(store.resolve({ ...editor, name: 'Renamed Editor' }).profile, 'coding');
  assert.equal(store.resolve({ id: 'another.editor', name: editor.name }).profile, 'chat');
  assert.equal(store.resolve(null).source, 'fallback');
  assert.equal(store.resolve({ id: 'browser', name: 'Mail in Browser', url: 'https://mail.example' }).profile, 'chat');
  assert.deepEqual(createDestinationProfiles(file).view(), store.view());
});

test('utterance snapshots and settings views cannot change after later saves or caller mutations', t => {
  const { store } = fixture(t);
  const identity = { ...editor };
  const payload = config({ mode: 'per-app', mappings: [{ ...editor, profile: 'coding' }] });
  store.save(payload);
  const view = store.view();
  const snapshot = store.resolve(identity);
  payload.mappings[0].profile = 'email';
  identity.name = 'Changed';
  store.save(config({ selectedProfile: 'chat' }));
  assert.equal(snapshot.profile, 'coding');
  assert.equal(snapshot.app.name, 'Editor');
  assert.equal(view.mappings[0].profile, 'coding');
  assert.throws(() => { snapshot.app.name = 'Mutated'; }, TypeError);
  assert.throws(() => { view.mappings.push({}); }, TypeError);
});

test('invalid input and prototype keys never change memory or persisted settings', t => {
  const { store, file } = fixture(t);
  store.save(config({ selectedProfile: 'email' }));
  const before = fs.readFileSync(file, 'utf8');
  const invalid = [
    null, [], config({ mode: 'automatic' }), config({ selectedProfile: 'constructor' }),
    config({ version: 2 }), config({ mappings: Array(1) }),
    config({ mappings: Array(101).fill({ ...editor, profile: 'chat' }) }),
    config({ mappings: [{ ...editor, profile: 'chat' }, { ...editor, profile: 'coding' }] }),
    config({ mappings: [{ id: '__proto__', name: 'Pollution', profile: 'chat' }] }),
    config({ mappings: [{ id: 'constructor', name: 'Pollution', profile: 'chat' }] }),
    config({ mappings: [{ id: 'bad\napp', name: 'Bad', profile: 'chat' }] }),
    config({ mappings: [{ ...editor, name: 'x'.repeat(121), profile: 'chat' }] }),
    JSON.parse('{"mode":"manual","selectedProfile":"plain","mappings":[],"__proto__":{"polluted":true}}'),
    Object.assign(Object.create({ polluted: true }), config()),
  ];
  for (const value of invalid) assert.throws(() => store.save(value), TypeError);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(store.view().selectedProfile, 'email');
  assert.equal({}.polluted, undefined);
});

test('malformed, invalid and oversized persisted preferences fail closed without overwriting', t => {
  const { file } = fixture(t);
  for (const contents of ['{broken', JSON.stringify(config({ mode: 'wrong' })), ' '.repeat(128 * 1024 + 1)]) {
    fs.writeFileSync(file, contents);
    assert.equal(createDestinationProfiles(file).resolve(editor).profile, 'plain');
    assert.equal(fs.readFileSync(file, 'utf8'), contents);
  }
});

test('failed atomic replacement preserves previous in-memory state and removes temporary files', t => {
  const { store, file } = fixture(t);
  fs.mkdirSync(file);
  assert.throws(() => store.save(config({ selectedProfile: 'coding' })));
  assert.equal(store.view().selectedProfile, 'plain');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['destination-profiles.json']);
});

test('profile instructions constrain every destination to formatting existing dictation', () => {
  for (const { id } of PROFILE_LIST) {
    const instructions = profileInstructions(id);
    assert.match(instructions, /formatting only/);
    assert.match(instructions, /numbers, negation/);
    assert.match(instructions, /Do not translate/);
    assert.match(instructions, /greetings, recipients, signoffs/);
  }
  assert.match(profileInstructions('coding'), /generate unspoken code/);
  assert.equal(profileInstructions('__proto__'), profileInstructions('plain'));
});

test('secret settings targets are rejected', () => {
  for (const name of ['.env', '.env.json', 'credentials.json', 'service-account-prod.json', '.npmrc']) {
    assert.throws(() => createDestinationProfiles(path.join(os.tmpdir(), name)), TypeError);
  }
});
