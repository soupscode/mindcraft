// Step 2: a model failure is never chatted, never added to history and never
// written to the memory summary. It leaves exactly one JSON line on the console.
//
// Uses the real Agent.handleMessage, Prompter, History and Ollama client.
// Everything around them that needs heavy dependencies (mineflayer, the command
// list, translation, the MindServer connection) is replaced by small stand-ins.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    stubModules, refusedPort, silentServer, captureConsole, modelFailureLines, closeAllServers,
} from './helpers/stubs.mjs';

stubModules({
    'src/agent/coder.js': 'export class Coder {}',
    'src/agent/vision/vision_interpreter.js': 'export class VisionInterpreter {}',
    'src/agent/vision/browser_viewer.js': 'export function addBrowserViewer() {}',
    'src/agent/modes.js': 'export function initModes() {}',
    'src/utils/mcdata.js': 'export function initBot() {}',
    'src/agent/npc/controller.js': 'export class NPCContoller {}',
    'src/agent/tasks/tasks.js': 'export class Task {}',
    'src/agent/speak.js': 'export function speak() {}',
    'src/agent/commands/index.js': `
        export function containsCommand(message) { const m = message.match(/!(\\w+)/); return m ? '!' + m[1] : null; }
        export function commandExists() { return false; }
        export async function executeCommand() { return null; }
        export function truncCommandMessage(message) { return message; }
        export function isAction() { return false; }
        export function blacklistCommands() {}
        export function getCommandDocs() { return ''; }
        export function getCommand() { return { perform: async () => '' }; }`,
    'src/agent/conversation.js': `
        export default {
            initAgent() {}, endAllConversations() {},
            isOtherAgent: () => false, inConversation: () => false, responseScheduledFor: () => false,
        };`,
    'src/utils/translator.js': `
        export async function handleTranslation(message) { return message; }
        export async function handleEnglishTranslation(message) { return message; }`,
    'src/agent/mindserver_proxy.js': `
        export const serverProxy = { getNumOtherAgents: () => 0, login() {}, shutdown() {} };
        export function sendOutputToServer(name, message) { (globalThis.genesis_test_server_output ??= []).push(message); }`,
    'src/agent/library/skill_library.js': `
        export class SkillLibrary {
            async initSkillLibrary() {}
            async getRelevantSkillDocs() { return ''; }
        }`,
});

const { setSettings } = await import('../../src/agent/settings.js');
const { Agent } = await import('../../src/agent/agent.js');
const { Prompter } = await import('../../src/models/prompter.js');
const { History } = await import('../../src/agent/history.js');
const { SelfPrompter } = await import('../../src/agent/self_prompter.js');
const { ActionManager } = await import('../../src/agent/action_manager.js');

const PLACEHOLDERS = ['No response data', 'My brain disconnected', 'I thought too hard'];
const TIMEOUT_MS = 300;
// a regression (for example a lost timeout) must fail the run, not hang it
const LIMIT = { timeout: 20000 };
after(closeAllServers);

// upstream writes ./bots/<name> relative to the working directory: keep that out of the repo
const work_dir = mkdtempSync(path.join(tmpdir(), 'genesis-test-'));
process.chdir(work_dir);

let agent_count = 0;

// A real Agent wired to a model server at `url`, with a fake Minecraft bot.
function makeAgent(url) {
    setSettings({
        base_profile: 'assistant', max_messages: 4, num_examples: 2, max_commands: -1,
        only_chat_with: [], chat_ingame: true, speak: false, show_command_syntax: 'full',
        log_all_prompts: false, relevant_docs_count: 5,
    });
    const name = `Tester${++agent_count}`;
    const profile = {
        name,
        cooldown: 0,
        model: { api: 'ollama', url, model: 'test-model', params: { request_timeout_ms: TIMEOUT_MS } },
        embedding: { api: 'ollama', url, model: 'embed-model', params: { request_timeout_ms: TIMEOUT_MS } },
    };
    const said = { chat: [], whisper: [] };
    globalThis.genesis_test_server_output = [];
    const agent = new Agent();
    agent.name = name;
    agent.shut_up = false;
    agent.last_sender = null;
    agent.blocked_actions = [];
    agent.task = { data: null, taskStartTime: 0 };
    agent.bot = {
        output: '',
        interrupt_code: false,
        emit() {},
        chat: (message) => said.chat.push(message),
        whisper: (to, message) => said.whisper.push(message),
        modes: { flushBehaviorLog: () => '' },
    };
    agent.actions = new ActionManager(agent);
    agent.prompter = new Prompter(agent, profile);
    agent.history = new History(agent);
    agent.self_prompter = new SelfPrompter(agent);
    return { agent, said };
}

// Every piece of text the agent could have produced or stored.
function everythingStored(agent, said) {
    const texts = [
        JSON.stringify(agent.history.turns), agent.history.memory,
        JSON.stringify(said), JSON.stringify(globalThis.genesis_test_server_output),
    ];
    const walk = (dir) => {
        for (const entry of readdirSync(dir)) {
            const full = path.join(dir, entry);
            if (statSync(full).isDirectory()) walk(full);
            else if (entry !== 'last_profile.json') texts.push(readFileSync(full, 'utf8'));
        }
    };
    walk(path.join(work_dir, 'bots', agent.name));
    return texts.join('\n');
}

function assertNoPlaceholders(text) {
    for (const placeholder of PLACEHOLDERS) {
        assert.ok(!text.includes(placeholder), `found placeholder text "${placeholder}"`);
    }
}

// The same checks against both kinds of dead model server.
function failureSuite(label, expected_error, getUrl) {
    test(`${label}: a chat message gets no reply, nothing is chatted or stored`, LIMIT, async () => {
        const { url, close } = await getUrl();
        try {
            const { agent, said } = makeAgent(url);
            const started = Date.now();
            const { result: used_command, lines } = await captureConsole(() => agent.handleMessage('steve', 'hello there'));
            const elapsed = Date.now() - started;

            assert.equal(used_command, false);
            assert.deepEqual(said, { chat: [], whisper: [] }, 'the agent said something in game');
            assert.deepEqual(globalThis.genesis_test_server_output, [], 'the agent sent output to the MindServer');
            assert.deepEqual(agent.history.turns, [{ role: 'user', content: 'steve: hello there' }]);
            assert.equal(agent.history.memory, '');

            const failures = modelFailureLines(lines);
            assert.equal(failures.length, 1, `expected one model_failure line, got ${failures.length}`);
            assert.equal(failures[0].error, expected_error);
            assert.equal(failures[0].call, 'conversation');
            assert.equal(failures[0].agent, agent.name);
            assert.equal(failures[0].provider, 'ollama');
            assert.equal(failures[0].timeout_ms, TIMEOUT_MS);
            assert.ok(elapsed < TIMEOUT_MS + 1500, `took ${elapsed} ms`);

            assertNoPlaceholders(lines.join('\n'));
            assertNoPlaceholders(everythingStored(agent, said));
        } finally {
            await close();
        }
    });

    test(`${label}: the memory summary is kept when summarising fails`, LIMIT, async () => {
        const { url, close } = await getUrl();
        try {
            const { agent, said } = makeAgent(url);
            agent.history.memory = 'OLD MEMORY: base is at the oak tree';
            const { lines } = await captureConsole(async () => {
                for (let i = 0; i < 6; i++) { // max_messages is 4, so this forces a summary
                    await agent.history.add('steve', `message ${i}`);
                }
                await agent.history.save();
            });

            assert.equal(agent.history.memory, 'OLD MEMORY: base is at the oak tree');
            const failures = modelFailureLines(lines);
            assert.ok(failures.length >= 1, 'expected a model_failure line');
            assert.ok(failures.every((f) => f.call === 'memSaving' && f.error === expected_error));
            const saved = JSON.parse(readFileSync(path.join(work_dir, 'bots', agent.name, 'memory.json'), 'utf8'));
            assert.equal(saved.memory, 'OLD MEMORY: base is at the oak tree');
            assertNoPlaceholders(everythingStored(agent, said));
        } finally {
            await close();
        }
    });

    test(`${label}: start-up survives, the other model calls return "no reply"`, LIMIT, async () => {
        const { url, close } = await getUrl();
        try {
            const { agent, said } = makeAgent(url);
            const { lines } = await captureConsole(async () => {
                await agent.prompter.initExamples(); // embeddings fail, falls back to word overlap
                assert.equal(await agent.prompter.promptConvo([{ role: 'user', content: 'steve: hi' }]), '');
                assert.equal(await agent.prompter.promptMemSaving([{ role: 'user', content: 'steve: hi' }]), null);
                assert.equal(await agent.prompter.promptShouldRespondToBot('come here'), false);
                assert.equal(await agent.prompter.promptCoding([{ role: 'user', content: 'steve: hi' }]), null);
                assert.equal(agent.prompter.awaiting_coding, false);
                assert.equal(await agent.prompter.promptVision([{ role: 'user', content: 'steve: hi' }], Buffer.from('x')), null);
            });
            const calls = modelFailureLines(lines).map((f) => f.call);
            assert.deepEqual(calls, ['conversation', 'memSaving', 'botResponder', 'coding', 'vision']);
            assertNoPlaceholders(lines.join('\n'));
            assertNoPlaceholders(everythingStored(agent, said));
        } finally {
            await close();
        }
    });
}

failureSuite('connection refused', 'ModelUnavailableError', async () => {
    const port = await refusedPort();
    return { url: `http://127.0.0.1:${port}`, close: async () => {} };
});

failureSuite('server never answers', 'ModelTimeoutError', silentServer);
