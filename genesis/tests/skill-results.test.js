// Step 3: actions return a structured result {ok, interrupted, timedout, output},
// and a skill that returns false produces ok: false.
//
// Uses the real ActionManager and the real command definitions in
// src/agent/commands/actions.js. Only the skills module (mineflayer code) is
// replaced by stand-ins that log a line and return true or false.
// Run from the repository root:  node --test genesis/tests/*.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { stubModules, captureConsole } from './helpers/stubs.mjs';
import { trackSkillReturns, runWithSkillTracking } from '../lib/skill_results.js';

stubModules({
    'src/agent/library/skills.js': `
        export function log(bot, message) { bot.output += message + '\\n'; }
        export async function collectBlock(bot, type, num) { log(bot, 'Could not find any ' + type + ' to collect.'); return false; }
        export async function craftRecipe(bot, name, num) { log(bot, 'Successfully crafted ' + name + '.'); return true; }
        export async function moveAway(bot, distance) { return true; }
        export async function discard(bot, name, num) { log(bot, 'You do not have any ' + name + ' to discard.'); return false; }
        export async function goToPosition(bot, x, y, z, min_distance) { return true; }
        export async function viewChest(bot) { log(bot, 'The chest is empty.'); }
        export async function followPlayer(bot, name, distance) { log(bot, 'Lost sight of ' + name + '.'); return false; }
        export async function goToBed(bot) { throw new Error('pathfinder exploded'); }`,
    'src/agent/conversation.js': 'export default { inConversation: () => false, isOtherAgent: () => false };',
});

const { actionsList } = await import('../../src/agent/commands/actions.js');
const { ActionManager } = await import('../../src/agent/action_manager.js');

function makeAgent() {
    const agent = {
        name: 'Tester',
        bot: {
            output: '', interrupt_code: false,
            entity: { position: { x: 0, y: 64, z: 0 } },
            emit() {},
        },
        memory_bank: { recallPlace: () => null },
        self_prompter: { isActive: () => false },
        history: { add() {} },
        isIdle() { return !this.actions.executing; },
        clearBotLogs() { this.bot.output = ''; this.bot.interrupt_code = false; },
        requestInterrupt() { this.bot.interrupt_code = true; },
        cleanKill() { throw new Error('cleanKill called'); },
    };
    agent.actions = new ActionManager(agent);
    // remember what the action path returned, next to the text the command returns
    agent.results = [];
    const runAction = agent.actions.runAction.bind(agent.actions);
    agent.actions.runAction = async (...args) => {
        const result = await runAction(...args);
        agent.results.push(result);
        return result;
    };
    return agent;
}

async function perform(agent, name, ...args) {
    const command = actionsList.find((a) => a.name === name);
    const { result } = await captureConsole(() => command.perform(agent, ...args));
    // actions that follow each other within 20 ms count as a runaway loop upstream
    await new Promise((resolve) => setTimeout(resolve, 30));
    return result;
}

test('a skill that returns false produces ok: false', async () => {
    const agent = makeAgent();
    const text = await perform(agent, '!collectBlocks', 'oak_log', 3);
    assert.equal(agent.results.length, 1);
    const result = agent.results[0];
    assert.equal(result.ok, false);
    assert.equal(result.interrupted, false);
    assert.equal(result.timedout, false);
    assert.match(result.output, /Could not find any oak_log to collect\./);
    // the text for the model still holds the action output, and now says it failed
    assert.match(text, /Action output:\nCould not find any oak_log to collect\./);
    assert.match(text, /Action did not succeed\./);
});

test('a skill that returns true produces ok: true and unchanged text', async () => {
    const agent = makeAgent();
    const text = await perform(agent, '!craftRecipe', 'stick', 1);
    const result = agent.results[0];
    assert.deepEqual(
        { ok: result.ok, interrupted: result.interrupted, timedout: result.timedout },
        { ok: true, interrupted: false, timedout: false },
    );
    assert.equal(text, 'Action output:\nSuccessfully crafted stick.\n');
    assert.equal(result.output, text);
});

test('a skill that returns nothing counts as ok', async () => {
    const agent = makeAgent();
    await perform(agent, '!viewChest');
    assert.equal(agent.results[0].ok, true);
});

test('an action running several skills is not ok when one of them returns false', async () => {
    const agent = makeAgent();
    await perform(agent, '!discard', 'dirt', 1); // moveAway: true, discard: false, goToPosition: true
    assert.equal(agent.results[0].ok, false);
});

test('an action that returns false itself is not ok', async () => {
    const agent = makeAgent();
    const text = await perform(agent, '!goToRememberedPlace', 'home');
    assert.equal(agent.results[0].ok, false);
    assert.match(text, /No location named "home" saved\./);
});

test('a skill that throws produces ok: false with the error in the output', async () => {
    const agent = makeAgent();
    const text = await perform(agent, '!goToBed');
    const result = agent.results[0];
    assert.equal(result.ok, false);
    assert.match(result.output, /pathfinder exploded/);
    assert.equal(text, result.output); // no extra "did not succeed" line, the exception text says it
});

test('resumable actions run too (the ActionManager uses assert on that path)', async () => {
    const agent = makeAgent();
    await perform(agent, '!followPlayer', 'steve', 4);
    assert.equal(agent.results[0].ok, false);
    assert.match(agent.results[0].output, /Lost sight of steve\./);
    assert.doesNotMatch(agent.results[0].output, /assert is not defined/);
});

test('older field names still work: message is the output, success means "did not throw"', async () => {
    const agent = makeAgent();
    await perform(agent, '!collectBlocks', 'oak_log', 3);
    await perform(agent, '!goToBed');
    const [returned_false, threw] = agent.results;
    assert.equal(returned_false.message, returned_false.output);
    assert.equal(returned_false.success, true);
    assert.equal(threw.message, threw.output);
    assert.equal(threw.success, false);
});

test('the result has exactly the documented fields plus the two older names', async () => {
    const agent = makeAgent();
    await perform(agent, '!craftRecipe', 'stick', 1);
    assert.deepEqual(Object.keys(agent.results[0]).sort(),
        ['interrupted', 'message', 'ok', 'output', 'success', 'timedout']);
});

test('actions run directly through the ActionManager report ok from their return value', async () => {
    const agent = makeAgent();
    const { result: failed } = await captureConsole(() => agent.actions.runAction('test:fail', async () => false));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const { result: fine } = await captureConsole(() => agent.actions.runAction('test:fine', async () => {}));
    assert.equal(failed.ok, false);
    assert.equal(fine.ok, true);
});

test('skill tracking keeps overlapping actions apart', async () => {
    const skills = trackSkillReturns({
        slowFail: async () => { await new Promise((r) => setTimeout(r, 20)); return false; },
        fastWin: async () => true,
        notAFunction: 42,
    });
    const [a, b] = await Promise.all([
        runWithSkillTracking(async () => { await skills.slowFail(); }),
        runWithSkillTracking(async () => { await skills.fastWin(); }),
    ]);
    assert.equal(a, false);
    assert.equal(b, true);
    assert.equal(skills.notAFunction, 42);
    assert.equal(await skills.slowFail(), false); // outside an action: same value, nothing recorded
});
