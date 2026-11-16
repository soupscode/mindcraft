// Genesis: saved memory loads by default and can be switched off for a full reset start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSettings } from '../lib/config.js';

const file_settings = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));

test('saved memory loads by default', () => {
    assert.equal(buildSettings(file_settings).load_memory, true);
    assert.equal(buildSettings(file_settings, undefined, undefined).load_memory, true);
});

test('GENESIS_LOAD_MEMORY=false gives a reset start', () => {
    assert.equal(buildSettings(file_settings, undefined, 'false').load_memory, false);
});

test('GENESIS_LOAD_MEMORY=true wins over a settings file that turns memory off', () => {
    assert.equal(buildSettings({ ...file_settings, load_memory: false }, undefined, 'true').load_memory, true);
});

test('any other value leaves the settings file in charge', () => {
    assert.equal(buildSettings(file_settings, undefined, 'maybe').load_memory, true);
    assert.equal(buildSettings({ ...file_settings, load_memory: false }, undefined, '').load_memory, false);
});
