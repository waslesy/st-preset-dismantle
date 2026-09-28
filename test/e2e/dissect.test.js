// Requires a running SillyTavern (npm run setup:st, then `node server.js` in .st/). Set ST_URL to override.
// Drives the real ST import UI and dry-run; fails if ST tries to reach any model API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dissect } from '../../cli/dissect.mjs';

const ST = process.env.ST_URL || 'http://127.0.0.1:8000';
// Any ST generation endpoint (chat-completions/generate, text-completions/generate, kobold/generate, ...).
const GENERATE = /\/generate[^/]*$/;
let apiCalls;

async function run(preset) {
    apiCalls = [];
    const { report } = await dissect({
        st: ST, preset, out: `out/e2e/${preset.split('/').pop()}`, log: () => {},
        onPage: page => page.on('request', r => { if (GENERATE.test(new URL(r.url()).pathname)) apiCalls.push(r.url()); }),
    });
    return report;
}

test('official Default preset through real ST dry-run', async () => {
    const r = await run('fixtures/ST Default.json');
    assert.deepEqual(apiCalls, []);
    assert.ok(r.consistency.every(c => c.ok));
    assert.equal(r.summary.prompts, 12);
    assert.equal(r.summary.conflicts, 0);
    const normal = r.runs.find(x => x.key === 'normal');
    assert.equal(normal.messages[0].segments[0].source.id, 'main');
});

test('comprehensive fixture through real ST dry-run', async () => {
    const r = await run('fixtures/PD Fixture.json');
    assert.deepEqual(apiCalls, []);
    assert.ok(r.consistency.every(c => c.ok), JSON.stringify(r.consistency));
    const types = new Set(r.findings.map(f => f.type));
    for (const t of ['duplicate-exact', 'conflict-polarity', 'conflict-length', 'conflict-pov', 'conflict-language', 'dependency-variable-order', 'dependency-card-override', 'dependency-regex']) assert.ok(types.has(t), t);
    const st = (id, k) => r.prompts.find(p => p.identifier === id).status[k].status;
    assert.equal(st('impOnly', 'impersonate'), 'sent');
    assert.equal(st('impOnly', 'normal'), 'trigger-excluded');
    assert.equal(st('inchat0', 'normal'), 'sent');
});
