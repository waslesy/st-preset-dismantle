// Runs the pure analyzer on inputs captured from a real SillyTavern dry-run (see scripts in README),
// so these tests check attribution against ST's actual assembly, not against a re-implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyze, modulesToPromptExport } from '../../extension/src/analyzer.js';
import { renderHTML, renderModulesMarkdown } from '../../extension/src/report.js';

const load = n => JSON.parse(fs.readFileSync(new URL(`../fixtures/${n}.input.json`, import.meta.url), 'utf8'));
const fixture = analyze(load('fixture'));
const def = analyze(load('default'));
const row = (r, id) => r.prompts.find(p => p.identifier === id);
const st = (r, id, run) => row(r, id).status[run].status;
const seq = (r, run) => r.runs.find(x => x.key === run).messages.map(m => m.segments.map(s => `${s.source.kind}:${s.source.id}`).join('+'));
const types = r => r.findings.map(f => f.type);

test('attribution is consistent with the untagged run for every probe', () => {
    for (const r of [fixture, def]) for (const c of r.consistency) assert.ok(c.ok, `${c.run}: ${c.detail}`);
});

test('official Default preset: relative order as assembled by ST', () => {
    const s = seq(def, 'normal');
    assert.equal(s[0], 'p:main');
    assert.deepEqual(s.slice(1, 5), ['marker:personaDescription', 'marker:charDescription', 'marker:charPersonality', 'marker:scenario']);
    assert.equal(st(def, 'enhanceDefinitions', 'normal'), 'disabled');
    assert.equal(st(def, 'nsfw', 'normal'), 'empty');
    assert.equal(st(def, 'worldInfoBefore', 'normal'), 'no-runtime-data');
    assert.equal(st(def, 'chatHistory', 'normal'), 'sent');
});

test('in-chat injections land at their depth with ST grouping', () => {
    const s = seq(fixture, 'normal');
    const last = s.length - 1;
    assert.equal(s[last], 'p:jailbreak');
    assert.equal(s[last - 1], 'p:inchat0', 'depth 0 goes after the last chat message');
    const iA = s.indexOf('p:inchat2a+p:inchat2b');
    assert.ok(iA > 0, 'same depth/order/role prompts are merged into one message');
    assert.equal(s[iA + 1], 'p:inchat2c');
    assert.deepEqual(s.slice(iA + 2, iA + 4), ['chat:4', 'chat:5'], 'depth 2 = before the last two chat messages');
    const msgs = fixture.runs.find(x => x.key === 'normal').messages;
    assert.equal(msgs[iA].role, 'user');
    assert.equal(msgs[iA + 1].role, 'assistant');
    assert.ok(msgs[iA].inChatInjection);
});

test('enabled / orphan / trigger / empty-after-macros states', () => {
    assert.equal(st(fixture, 'off', 'normal'), 'disabled');
    assert.equal(st(fixture, 'orphan', 'normal'), 'orphan');
    assert.equal(st(fixture, 'impOnly', 'normal'), 'trigger-excluded');
    assert.equal(st(fixture, 'impOnly', 'impersonate'), 'sent');
    assert.equal(st(fixture, 'contOnly', 'continue'), 'sent');
    assert.equal(st(fixture, 'contOnly', 'quiet'), 'trigger-excluded');
    assert.equal(st(fixture, 'emptyMacro', 'normal'), 'empty-after-macros');
    assert.equal(row(fixture, 'impOnly').status.impersonate.basis, 'dry-run');
    assert.equal(row(fixture, 'off').status.normal.basis, 'source-rule');
});

test('macros are resolved by ST and unresolved ones are reported with evidence', () => {
    const vars = row(fixture, 'vars').status.normal.resolvedText;
    assert.match(vars, /当前心情：happy/);
    assert.doesNotMatch(vars, /setvar|这是注释/);
    const un = fixture.findings.find(f => f.type === 'macro-unregistered');
    assert.match(un.message, /notARealMacro/);
    assert.ok(fixture.findings.some(f => f.type === 'macro-unresolved-sent' && f.basis === 'dry-run'));
    assert.match(row(fixture, 'main').status.normal.resolvedText, /PD Probe/);
});

test('character-card override replaces jailbreak only in the override probe', () => {
    assert.equal(st(fixture, 'jailbreak', 'normal'), 'empty');
    assert.equal(st(fixture, 'jailbreak', 'normal+card-override'), 'sent');
    assert.ok(fixture.findings.some(f => f.type === 'dependency-card-override' && f.basis === 'dry-run'));
});

test('duplicates, conflicts, cosmetic, runtime dependencies keep original evidence', () => {
    const t = types(fixture);
    for (const k of ['duplicate-exact', 'conflict-polarity', 'conflict-length', 'conflict-pov', 'conflict-language', 'dependency-variable-order', 'dependency-foreign-syntax', 'dependency-regex', 'dependency-extension-data', 'dependency-marker']) assert.ok(t.includes(k), k);
    for (const f of fixture.findings) {
        assert.ok(['dry-run', 'source-rule', 'heuristic'].includes(f.basis), f.type);
        assert.ok(f.evidence?.length, `${f.type} has evidence`);
    }
    const pol = fixture.findings.find(f => f.type === 'conflict-polarity');
    assert.deepEqual(pol.evidence.map(e => e.text), ['- 禁止替{{user}}说话或行动。', '- 可以替{{user}}说话。']);
    assert.ok(fixture.cosmetic.some(c => c.kind === 'regex-display'));
    assert.ok(fixture.cosmetic.some(c => c.prompt === 'status'));
    assert.equal(def.findings.filter(f => f.type.startsWith('conflict')).length, 0);
});

test('modules are reusable units with reuse classification and export', () => {
    const style = fixture.modules.find(m => m.title.includes('<style>'));
    assert.equal(style.reuse, 'standalone');
    assert.equal(fixture.modules.find(m => m.source.prompt === 'status').reuse, 'coupled');
    const exp = modulesToPromptExport(fixture.modules);
    // Shape accepted by PromptManager.import() (validateObject against {version, type, data:{prompts, prompt_order}}).
    assert.equal(exp.version, 1);
    assert.equal(exp.data.prompts.length, fixture.modules.length);
    assert.ok(exp.data.prompts.every(p => p.identifier && typeof p.content === 'string'));
});

test('reports render', () => {
    const html = renderHTML(fixture);
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /已在 dry-run 中观察/);
    assert.doesNotMatch(html, /<script/i);
    assert.match(renderModulesMarkdown(fixture), /# 候选模块/);
});
