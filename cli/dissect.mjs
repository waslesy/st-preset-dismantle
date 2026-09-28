#!/usr/bin/env node
/* global document, PresetDismantle, $ -- code inside page.evaluate() runs in the SillyTavern page */
// Imports a preset into a running SillyTavern through ST's own import UI, runs the dry-run dissection
// in the page and writes the report files. No model API is contacted.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

export async function dissect({ st = 'http://127.0.0.1:8000', preset = null, out = 'out', types = null, cardOverride = true, headed = false, saveInput = false, log = console.error, onPage = null } = {}) {
    const browser = await chromium.launch({ headless: !headed });
    try {
        const page = await browser.newPage();
        onPage?.(page);
        const pageErrors = [];
        page.on('pageerror', e => pageErrors.push(String(e)));
        await page.goto(st, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => globalThis.PresetDismantle && document.querySelector('#settings_preset_openai option'), null, { timeout: 120000 });
        await page.waitForFunction(() => globalThis.SillyTavern?.getContext && document.body.classList.length >= 0 && !document.querySelector('#preloader'), null, { timeout: 120000 }).catch(() => {});
        const api = await page.evaluate(() => PresetDismantle.mainApi());
        if (api !== 'openai') {
            log(`main_api=${api}; switching to Chat Completion`);
            await page.evaluate(() => { $('#main_api').val('openai').trigger('change'); });
            await page.waitForFunction(() => PresetDismantle.mainApi() === 'openai');
        }
        let rawPreset = null;
        if (preset) {
            rawPreset = JSON.parse(await fs.readFile(preset, 'utf8'));
            const name = path.basename(preset).replace(/\.[^/.]+$/, '');
            log(`importing ${preset} via ST preset import`);
            await page.setInputFiles('#openai_preset_import_file', preset);
            // ST may ask to overwrite an existing preset or to strip proxy fields: accept both (strip = OK).
            // The preset may already be selected from an earlier run, so wait until no popup has been open for 1.5 s.
            const deadline = Date.now() + 30000;
            let quietSince = Date.now();
            while (Date.now() < deadline) {
                const hadPopup = await page.evaluate(() => {
                    const ok = document.querySelector('dialog[open] .popup-button-ok');
                    ok?.click();
                    return !!ok;
                });
                if (hadPopup) quietSince = Date.now();
                else if (Date.now() - quietSince > 1500 && await page.evaluate(n => PresetDismantle.currentPreset() === n, name)) break;
                await page.waitForTimeout(200);
            }
            await page.evaluate(() => PresetDismantle.waitPresetApplied());
            const now = await page.evaluate(() => PresetDismantle.currentPreset());
            if (now !== name) throw new Error(`preset "${name}" was not selected after import (current: ${now})`);
        }
        log(`dissecting "${await page.evaluate(() => PresetDismantle.currentPreset())}"`);
        const files = await page.evaluate(async ({ types, cardOverride, rawPreset }) => {
            const report = await PresetDismantle.runDissection({ types: types || PresetDismantle.GENERATION_TYPES, cardOverride, rawPreset });
            const files = PresetDismantle.exportsFor(report);
            return files;
        }, { types, cardOverride, rawPreset });
        // Raw analyzer input (loaded preset + dry-run captures): lets the pure analyzer be re-run offline.
        if (saveInput) files['analyzer-input.json'] = await page.evaluate(() => JSON.stringify(PresetDismantle.lastInput, null, 1));
        await fs.mkdir(out, { recursive: true });
        const written = [];
        for (const [n, t] of Object.entries(files)) { const p = path.join(out, n); await fs.writeFile(p, t); written.push(p); }
        if (pageErrors.length) log(`page errors during run:\n${pageErrors.join('\n')}`);
        return { written, report: JSON.parse(files[Object.keys(files).find(n => n.endsWith('.dismantle.json'))]), pageErrors };
    } finally {
        await browser.close();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const { values } = parseArgs({
        options: {
            st: { type: 'string', default: 'http://127.0.0.1:8000' }, preset: { type: 'string' }, out: { type: 'string', default: 'out' },
            types: { type: 'string' }, 'save-input': { type: 'boolean', default: false }, 'no-override': { type: 'boolean', default: false }, headed: { type: 'boolean', default: false },
        },
    });
    const { written, report } = await dissect({ ...values, types: values.types ? values.types.split(',') : null, cardOverride: !values['no-override'], saveInput: values['save-input'] });
    console.log(JSON.stringify({ summary: report.summary, consistency: report.consistency, written }, null, 2));
}
