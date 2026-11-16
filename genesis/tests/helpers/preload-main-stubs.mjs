// Preload for running the real main.js in a test:  node --import <this file> main.js
// Replaces the Mindcraft runtime with a recorder that prints what main.js asked
// for, and yargs with a stand-in, so main.js runs without installed dependencies
// and without connecting to anything.

import { register } from 'node:module';

register('./stub-hooks.mjs', {
    parentURL: import.meta.url,
    data: {
        stubs: {
            'src/mindcraft/mindcraft.js': `
                export function init(host_public, port, auto_open_ui) {
                    console.log('GENESIS_TEST_INIT ' + JSON.stringify({ host_public, port, auto_open_ui }));
                }
                export function createAgent(settings) {
                    console.log('GENESIS_TEST_AGENT ' + JSON.stringify(settings));
                    return { success: true, error: null };
                }`,
            'yargs': `
                const chain = { option() { return chain; }, help() { return chain; }, alias() { return chain; }, parse() { return {}; } };
                export default function yargs() { return chain; }`,
            'yargs/helpers': 'export function hideBin(argv) { return argv.slice(2); }',
        },
    },
});
