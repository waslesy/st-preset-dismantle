// Pure analysis over (a) the preset as loaded by SillyTavern and (b) dry-run probe outputs.
// Every finding carries `basis`: 'dry-run' (observed in ST output), 'source-rule' (derived from pinned ST code,
// not observed in this run) or 'heuristic' (text analysis, may be wrong), plus evidence with original text.
import { RULES, ST_COMMIT, ST_VERSION } from './rules.js';
import { splitTagged, stripBoundaryTags } from './sentinels.js';
import {
    findMacros, segment, tagInstruction, normalize, bigrams, jaccard, containment, NEG, POS,
    lengthConstraints, povValues, languageValues, foreignSyntax,
} from './text.js';

export const GLOBAL_ORDER_ID = '100001';
export const MARKERS = {
    worldInfoBefore: '世界书（角色定义前）', worldInfoAfter: '世界书（角色定义后）', charDescription: '角色描述',
    charPersonality: '角色性格', scenario: '场景', personaDescription: '用户人设', dialogueExamples: '示例对话', chatHistory: '聊天记录',
};
export const UTILITY_FIELDS = [
    'impersonation_prompt', 'new_chat_prompt', 'new_group_chat_prompt', 'new_example_chat_prompt',
    'continue_nudge_prompt', 'group_nudge_prompt', 'wi_format', 'scenario_format', 'personality_format',
];
// Container identifiers ST gives utility-prompt messages in openai.js (prepareOpenAIMessages & co).
export const UTILITY_CONTAINERS = {
    newMainChat: 'new_chat_prompt', newChat: 'new_example_chat_prompt', continueNudge: 'continue_nudge_prompt',
    impersonate: 'impersonation_prompt', groupNudge: 'group_nudge_prompt',
};
const DATA_SOURCE = {
    'c:description': 'charDescription', 'c:personality': 'charPersonality', 'c:scenario': 'scenario', 'c:persona': 'personaDescription',
};
const MACRO_DEP_LABEL = {
    names: '参与者名字（{{user}}/{{char}} 等）', character: '角色卡/人设字段', chat: '聊天记录内容', time: '系统时间（每次不同）',
    random: '随机值（每次生成不同）', variable: '聊天/全局变量', prompts: '文本补全模板字段（Chat Completion 下通常为空）', state: '运行时状态（模型/API/生成类型）',
};

export function fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
}

const excerpt = (t, n = 160) => { const s = String(t ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const isInChat = p => Number(p?.injection_position) === 1;

function placementOf(p) {
    if (p?.marker) return { kind: 'marker' };
    if (isInChat(p)) return { kind: 'in-chat', depth: p.injection_depth ?? 4, order: p.injection_order ?? 100, role: p.role || 'system' };
    return { kind: 'relative', role: p?.role || 'system' };
}

/**
 * @param {object} input
 * @param {{name:string, prompts:object[], prompt_order:object[], extensions?:object, settings?:object}} input.preset Preset state loaded by ST.
 * @param {object} [input.rawPreset] The imported file, to report what ST changed while loading.
 * @param {Object<string,{tagged:{role:string,content:any,container:string,identifier:string}[], plain:{role:string,content:any}[], squashed?:object[], error?:string, variant?:string, type:string}>} [input.probes]
 * @param {Object<string,{name:string,category:string,description?:string}>} [input.macroCatalog] lower-case macro name -> def
 * @param {object} [input.probeInfo]
 */
export function analyze({ preset, rawPreset = null, probes = {}, macroCatalog = {}, probeInfo = {} }) {
    const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
    const byId = new Map(prompts.map(p => [p.identifier, p]));
    const orderList = (preset.prompt_order || []).find(o => String(o.character_id) === GLOBAL_ORDER_ID);
    const order = orderList?.order || [];
    const findings = [];
    const add = f => { f.id = `f${findings.length + 1}`; findings.push(f); return f; };

    // ---------- Probe outputs -> attributed sequences ----------
    const runs = {};
    for (const [key, probe] of Object.entries(probes)) runs[key] = buildRun(key, probe, byId);

    // ---------- Prompt rows ----------
    const rows = [];
    const seen = new Set();
    order.forEach((entry, idx) => {
        const p = byId.get(entry.identifier);
        if (seen.has(entry.identifier)) add({ type: 'order-duplicate-entry', basis: 'source-rule', rule: RULES.collection, severity: 'warn', prompts: [entry.identifier], message: `prompt_order 中重复出现 ${entry.identifier}。`, evidence: [{ field: `prompt_order[${GLOBAL_ORDER_ID}].order[${idx}]`, text: JSON.stringify(entry) }] });
        seen.add(entry.identifier);
        if (!p) {
            add({ type: 'order-missing-prompt', basis: 'source-rule', rule: RULES.collection, severity: 'info', prompts: [entry.identifier], message: `prompt_order 引用了不存在的 Prompt ${entry.identifier}，ST 会跳过。`, evidence: [{ field: `prompt_order[${GLOBAL_ORDER_ID}].order[${idx}]`, text: JSON.stringify(entry) }] });
            return;
        }
        rows.push(buildRow(p, entry, idx, runs));
    });
    prompts.filter(p => !seen.has(p.identifier)).forEach(p => rows.push(buildRow(p, null, null, runs)));

    // ---------- Instructions ----------
    const instructions = [];
    for (const r of rows) {
        const p = byId.get(r.identifier);
        if (p.marker || typeof p.content !== 'string') continue;
        for (const u of segment(p.content)) {
            instructions.push({
                id: `${r.identifier}#${u.n}`, prompt: r.identifier, promptName: r.name, line: u.line, endLine: u.endLine,
                text: u.text, kind: u.kind, section: u.section, tags: u.kind === 'text' ? tagInstruction(u.text) : [],
                macros: findMacros(u.text).map(m => m.name), sentIn: r.sentIn,
            });
        }
    }
    const instById = new Map(instructions.map(i => [i.id, i]));
    const ev = i => ({ prompt: i.prompt, promptName: i.promptName, field: `prompts[${i.prompt}].content`, lines: [i.line, i.endLine], text: i.text });
    const jointScope = (a, b) => {
        const both = a.sentIn.filter(t => b.sentIn.includes(t));
        return { effectiveIn: both, scope: both.length ? 'effective' : 'latent' };
    };

    // ---------- Duplicates ----------
    const textual = instructions.filter(i => i.kind === 'text').map(i => ({ i, norm: normalize(i.text) })).filter(x => x.norm.length >= 6);
    const exact = new Map();
    for (const x of textual) { if (!exact.has(x.norm)) exact.set(x.norm, []); exact.get(x.norm).push(x.i); }
    const inExact = new Set();
    for (const group of exact.values()) {
        if (group.length < 2) continue;
        group.forEach(g => inExact.add(g.id));
        const scope = group.filter(g => g.sentIn.length).length >= 2 ? 'effective' : 'latent';
        add({ type: 'duplicate-exact', basis: 'heuristic', severity: 'warn', scope, instructions: group.map(g => g.id), prompts: [...new Set(group.map(g => g.prompt))], message: `${group.length} 条指令去除空白/标点/宏后完全相同。`, evidence: group.map(ev) });
    }
    const grams = textual.map(x => ({ ...x, g: bigrams(x.norm) }));
    for (let a = 0; a < grams.length; a++) {
        for (let b = a + 1; b < grams.length; b++) {
            const A = grams[a]; const B = grams[b];
            if (A.norm === B.norm) continue;
            const ratio = Math.min(A.norm.length, B.norm.length) / Math.max(A.norm.length, B.norm.length);
            if (ratio < 0.7) continue;
            const sim = jaccard(A.g, B.g);
            if (sim >= 0.8) add({ type: 'duplicate-near', basis: 'heuristic', severity: 'info', similarity: +sim.toFixed(2), ...jointScope(A.i, B.i), instructions: [A.i.id, B.i.id], prompts: [...new Set([A.i.prompt, B.i.prompt])], message: `两条指令字符二元组 Jaccard 相似度 ${sim.toFixed(2)}。`, evidence: [ev(A.i), ev(B.i)] });
        }
    }
    const contentGroups = new Map();
    for (const p of prompts) { if (p.marker || !p.content?.trim()) continue; const k = normalize(p.content); if (!contentGroups.has(k)) contentGroups.set(k, []); contentGroups.get(k).push(p); }
    for (const g of contentGroups.values()) if (g.length > 1) add({ type: 'duplicate-prompt', basis: 'heuristic', severity: 'warn', prompts: g.map(p => p.identifier), message: `${g.length} 个 Prompt 内容相同（${g.map(p => p.name || p.identifier).join('、')}）。`, evidence: g.map(p => ({ prompt: p.identifier, promptName: p.name, field: `prompts[${p.identifier}].content`, text: excerpt(p.content, 300) })) });
    for (const run of Object.values(runs)) {
        const counts = new Map();
        run.messages.forEach(m => m.segments.forEach(s => {
            if (s.source?.kind !== 'p' || normalize(s.text).length < 6) return;
            const k = normalize(s.text); if (!counts.has(k)) counts.set(k, []); counts.get(k).push({ m: m.index, s });
        }));
        for (const hits of counts.values()) {
            const ids = [...new Set(hits.map(h => h.s.source.id))];
            if (hits.length > 1) add({ type: 'duplicate-sent', basis: 'dry-run', severity: 'warn', run: run.key, prompts: ids, message: `[${run.key}] 同一段文本在最终请求中出现 ${hits.length} 次（消息 ${hits.map(h => '#' + h.m).join(', ')}）。`, evidence: hits.map(h => ({ run: run.key, message: h.m, prompt: h.s.source.id, text: excerpt(h.s.text, 300) })) });
        }
    }

    // ---------- Conflicts (heuristic) ----------
    const directive = instructions.filter(i => i.kind === 'text');
    const polar = directive.map(i => {
        const plain = normalize(i.text);
        const neg = NEG.test(i.text);
        const pos = !neg && POS.test(i.text);
        const topic = plain.replace(new RegExp(NEG.source, 'gi'), '').replace(new RegExp(POS.source, 'gi'), '').replace(/(使用|进行|出现|任何|所有|的|了|地|得)/g, '');
        return { i, neg, pos, topic, g: bigrams(topic) };
    }).filter(x => (x.neg || x.pos) && x.g.size >= 2);
    for (const N of polar.filter(x => x.neg)) {
        for (const P of polar.filter(x => x.pos)) {
            if (N.i.prompt === P.i.prompt && Math.abs(N.i.line - P.i.line) < 1) continue;
            const sim = Math.max(jaccard(N.g, P.g), Math.min(N.g.size, P.g.size) >= 2 ? containment(N.g, P.g) : 0);
            if (sim >= 0.6) add({ type: 'conflict-polarity', basis: 'heuristic', severity: 'warn', similarity: +sim.toFixed(2), ...jointScope(N.i, P.i), instructions: [N.i.id, P.i.id], prompts: [...new Set([N.i.prompt, P.i.prompt])], message: '一条禁止、一条要求/允许，且去掉否定/要求词后主题高度相似（或一条包含另一条）。', evidence: [ev(N.i), ev(P.i)] });
        }
    }
    const lens = directive.flatMap(i => lengthConstraints(i.text).map(c => ({ ...c, i })));
    for (let a = 0; a < lens.length; a++) {
        for (let b = a + 1; b < lens.length; b++) {
            const A = lens[a]; const B = lens[b];
            if (A.unit !== B.unit || A.i.id === B.i.id) continue;
            if (Math.max(A.min, B.min) > Math.min(A.max, B.max)) add({ type: 'conflict-length', basis: 'heuristic', severity: 'warn', ...jointScope(A.i, B.i), instructions: [A.i.id, B.i.id], prompts: [...new Set([A.i.prompt, B.i.prompt])], message: `长度约束无交集：「${A.raw}」与「${B.raw}」。`, evidence: [ev(A.i), ev(B.i)] });
        }
    }
    const valueConflicts = (type, fn, label) => {
        const hits = directive.filter(i => !NEG.test(i.text)).flatMap(i => fn(i.text).map(v => ({ v, i })));
        const values = [...new Set(hits.map(h => h.v))];
        if (values.length < 2) return;
        const pick = values.map(v => hits.find(h => h.v === v));
        const sets = pick.map(h => h.i.sentIn);
        const both = sets.reduce((acc, s) => acc.filter(t => s.includes(t)));
        add({ type, basis: 'heuristic', severity: 'warn', scope: both.length ? 'effective' : 'latent', effectiveIn: both, instructions: hits.map(h => h.i.id), prompts: [...new Set(hits.map(h => h.i.prompt))], message: `出现多个不同的${label}要求：${values.join(' / ')}。`, evidence: hits.map(h => ({ ...ev(h.i), value: h.v })) });
    };
    valueConflicts('conflict-pov', povValues, '人称');
    valueConflicts('conflict-language', languageValues, '输出语言');

    // ---------- Variables / macros / runtime dependencies ----------
    const vars = new Map();
    const macroUse = new Map();
    for (const r of rows) {
        const p = byId.get(r.identifier);
        if (p.marker || typeof p.content !== 'string') continue;
        const starts = [0]; for (let k = 0; k < p.content.length; k++) if (p.content[k] === '\n') starts.push(k + 1);
        const lineAt = idx => { let n = 0; while (n + 1 < starts.length && starts[n + 1] <= idx) n++; return n + 1; };
        for (const m of findMacros(p.content)) {
            const line = lineAt(m.index);
            if (m.variable?.name) {
                const key = `${m.variable.scope}:${m.variable.name}`;
                if (!vars.has(key)) vars.set(key, { name: m.variable.name, scope: m.variable.scope, writes: [], reads: [] });
                vars.get(key)[m.variable.write ? 'writes' : 'reads'].push({ prompt: r.identifier, promptName: r.name, line, text: m.raw, value: m.variable.value, sentIn: r.sentIn });
            }
            if (m.kind === 'close' || m.kind === 'comment') continue;
            const lower = m.name.toLowerCase();
            if (!macroUse.has(lower)) macroUse.set(lower, { name: m.name, uses: [] });
            macroUse.get(lower).uses.push({ prompt: r.identifier, promptName: r.name, line, text: m.raw });
        }
    }
    const macros = [...macroUse.entries()].map(([lower, u]) => {
        const def = macroCatalog[lower] || (lower.startsWith('.') || lower.startsWith('$') ? { name: u.name, category: 'variable' } : null);
        return { name: u.name, registered: !!def, category: def?.category || null, description: def?.description || '', dependency: def ? (MACRO_DEP_LABEL[def.category] || null) : null, uses: u.uses };
    });
    for (const m of macros) {
        if (m.registered || !Object.keys(macroCatalog).length) continue;
        add({ type: 'macro-unregistered', basis: 'source-rule', severity: 'warn', prompts: [...new Set(m.uses.map(u => u.prompt))], message: `宏 {{${m.name}}} 不在当前 ST 宏注册表中；若无扩展注册，会按原文发送或被忽略。`, evidence: m.uses.map(u => ({ prompt: u.prompt, promptName: u.promptName, line: u.line, text: u.text })) });
    }
    // Macros observed literally in output = not resolved by ST in this run
    for (const run of Object.values(runs)) {
        for (const msg of run.messages) for (const s of msg.segments) {
            if (s.source?.kind !== 'p') continue;
            const left = findMacros(s.text).filter(m => m.kind !== 'close');
            if (left.length) add({ type: 'macro-unresolved-sent', basis: 'dry-run', severity: 'warn', run: run.key, prompts: [s.source.id], message: `[${run.key}] 最终请求中仍含未解析的宏文本：${[...new Set(left.map(m => m.raw))].slice(0, 5).join(' ')}`, evidence: [{ run: run.key, message: msg.index, prompt: s.source.id, text: excerpt(s.text, 300) }] });
        }
    }
    const variables = [...vars.values()].map(v => ({ ...v, external: v.reads.length > 0 && v.writes.length === 0 }));
    // Read placed before write in the actual message sequence: within one request the read sees the previous value.
    for (const v of variables) {
        if (!v.reads.length || !v.writes.length) continue;
        for (const run of Object.values(runs)) {
            const firstMsg = id => Math.min(...(run.hitsBySource.get(`p:${id}`) || []).map(h => h.message));
            const w = Math.min(...v.writes.map(x => firstMsg(x.prompt)));
            const early = v.reads.filter(x => x.prompt !== v.writes[0].prompt && firstMsg(x.prompt) < w);
            if (!Number.isFinite(w) || !early.length) continue;
            add({ type: 'dependency-variable-order', basis: 'dry-run', severity: 'warn', run: run.key, prompts: [...new Set([...early.map(x => x.prompt), ...v.writes.map(x => x.prompt)])], message: `[${run.key}] 变量「${v.name}」在消息 #${firstMsg(early[0].prompt)} 被读取，但写入它的 Prompt 位于消息 #${w}：同一次请求中读到的是之前保存的值（首次为空）。`, evidence: [...early, ...v.writes].map(x => ({ run: run.key, prompt: x.prompt, promptName: x.promptName, line: x.line, text: x.text })) });
            break;
        }
    }
    for (const v of variables) {
        if (v.external) add({ type: 'dependency-variable', basis: 'heuristic', severity: 'info', prompts: [...new Set(v.reads.map(r => r.prompt))], message: `读取${v.scope === 'global' ? '全局' : '聊天'}变量「${v.name}」，但本 Preset 内没有写入它：值来自聊天状态、其他扩展或角色卡。`, evidence: v.reads.map(r => ({ prompt: r.prompt, promptName: r.promptName, line: r.line, text: r.text })) });
        const writers = new Set(v.writes.map(w => w.prompt));
        const values = new Set(v.writes.filter(w => w.value !== undefined).map(w => w.value.trim()));
        if (writers.size > 1 && values.size > 1) add({ type: 'conflict-variable', basis: 'heuristic', severity: 'warn', prompts: [...writers], message: `多个 Prompt 给变量「${v.name}」写入不同值；最终值取决于宏求值顺序，本工具未单独验证该顺序。`, evidence: v.writes.map(w => ({ prompt: w.prompt, promptName: w.promptName, line: w.line, text: w.text })) });
    }
    for (const r of rows) {
        const p = byId.get(r.identifier);
        if (typeof p.content === 'string') for (const h of foreignSyntax(p.content)) add({ type: 'dependency-foreign-syntax', basis: 'heuristic', severity: 'warn', prompts: [r.identifier], message: h.note, evidence: [{ prompt: r.identifier, promptName: r.name, field: `prompts[${r.identifier}].content`, text: excerpt(p.content, 300) }] });
    }
    for (const r of rows) {
        if (!r.marker || !r.inOrder || !r.enabled) continue;
        const observed = Object.entries(r.status).filter(([, s]) => s.status === 'sent').map(([k]) => k);
        add({ type: 'dependency-marker', basis: observed.length ? 'dry-run' : 'source-rule', rule: RULES.relativeAssembly, severity: 'info', prompts: [r.identifier], message: `占位符「${r.name}」由运行时的${MARKERS[r.identifier] || '外部数据'}填充${observed.length ? `（探针中已观察到：${observed.join(', ')}）` : '（本次探针没有该类数据，未观察到输出）'}。`, evidence: observed.length ? observed.map(k => ({ run: k, message: r.status[k].messages[0], text: r.status[k].sample })) : [{ field: `prompt_order[${GLOBAL_ORDER_ID}].order[${r.orderIndex}]`, text: JSON.stringify({ identifier: r.identifier, enabled: r.enabled }) }] });
    }
    for (const r of rows.filter(x => ['main', 'jailbreak'].includes(x.identifier) && x.inOrder && x.enabled)) {
        const field = r.identifier === 'main' ? 'system_prompt（Main Prompt 覆盖）' : 'post_history_instructions（Post-History 覆盖）';
        const ovRun = Object.values(runs).find(x => x.variant === 'card-override');
        const replaced = ovRun ? ovRun.overridden.includes(r.identifier) : null;
        add({
            type: 'dependency-card-override', severity: 'info', rule: RULES.overrides, prompts: [r.identifier],
            basis: ovRun ? 'dry-run' : 'source-rule',
            message: r.forbidOverrides
                ? `「${r.name}」设置了 forbid_overrides，角色卡的 ${field} 不会替换它${ovRun ? (replaced ? '——但探针中观察到被替换，与预期不符' : '（探针已确认未被替换）') : ''}。`
                : `角色卡的 ${field} 会替换「${r.name}」${ovRun ? (replaced ? '（探针已确认替换发生）' : '——但探针中未观察到替换') : '（源码规则，未探测）'}。`,
            evidence: [{ prompt: r.identifier, field: `prompts[${r.identifier}].forbid_overrides`, text: String(!!r.forbidOverrides) }],
        });
    }

    // ---------- Cosmetic ----------
    const cosmetic = [];
    for (const i of instructions) {
        if (i.kind === 'decorative') cosmetic.push({ kind: 'decorative-text', basis: 'heuristic', instruction: i.id, prompt: i.prompt, note: i.sentIn.length ? `纯装饰文本，无指令语义；但会发送给模型（${i.sentIn.join(', ')}）并占用 token。` : '纯装饰文本，无指令语义；当前未发送。', evidence: ev(i) });
        if (i.kind === 'comment') cosmetic.push({ kind: 'comment', basis: 'source-rule', instruction: i.id, prompt: i.prompt, note: '{{// }} 注释宏，由宏引擎移除，不发送给模型。', evidence: ev(i) });
        if (i.tags.includes('cosmeticOutput')) cosmetic.push({ kind: 'cosmetic-output-instruction', basis: 'heuristic', instruction: i.id, prompt: i.prompt, note: '要求模型输出 HTML/状态栏/样式等展示性内容的指令（美化型输出，属于指令但主要作用于显示）。', evidence: ev(i) });
    }
    const regexScripts = (preset.extensions?.regex_scripts || []).map((s, idx) => {
        const effect = s.markdownOnly ? 'display-only' : s.promptOnly ? 'prompt-only' : 'stored-message';
        const r = {
            index: idx, name: s.scriptName, find: s.findRegex, replace: s.replaceString, placement: s.placement || [], disabled: !!s.disabled,
            markdownOnly: !!s.markdownOnly, promptOnly: !!s.promptOnly, minDepth: s.minDepth ?? null, maxDepth: s.maxDepth ?? null, effect,
            note: effect === 'display-only' ? '仅修改显示层（纯美化候选），不改变发给模型的内容。' : effect === 'prompt-only' ? '只在构建请求时修改聊天记录/世界书文本（不改 Preset Prompt 本身）。' : '直接修改存储的聊天消息文本，会间接影响之后的请求。',
        };
        if (effect === 'display-only' && !r.disabled) cosmetic.push({ kind: 'regex-display', basis: 'source-rule', rule: RULES.regexPlacement, regex: idx, note: `Regex「${s.scriptName}」${r.note}`, evidence: { field: `extensions.regex_scripts[${idx}]`, text: `find: ${s.findRegex}\nreplace: ${excerpt(s.replaceString, 300)}` } });
        return r;
    });
    if (regexScripts.length) add({ type: 'dependency-regex', basis: 'source-rule', rule: RULES.regexScope, severity: 'info', prompts: [], message: `Preset 携带 ${regexScripts.length} 个 Regex 脚本；只有在用户允许该 Preset 的 Regex 后才运行，且只作用于聊天/世界书/显示文本，不作用于 Preset Prompt。本工具未在探针中执行它们。`, evidence: regexScripts.map(r => ({ field: `extensions.regex_scripts[${r.index}]`, text: `${r.name}: ${r.find}` })) });
    const otherExt = Object.keys(preset.extensions || {}).filter(k => k !== 'regex_scripts');
    if (otherExt.length) add({ type: 'dependency-extension-data', basis: 'heuristic', severity: 'info', prompts: [], message: `Preset 携带非 ST 本体的扩展数据：${otherExt.join(', ')}。其效果取决于对应第三方扩展，本工具未执行。`, evidence: otherExt.map(k => ({ field: `extensions.${k}`, text: excerpt(JSON.stringify(preset.extensions[k]), 300) })) });

    // ---------- Loading differences ----------
    const loadDiff = rawPreset ? diffLoad(rawPreset, preset) : null;

    // ---------- Consistency of attribution ----------
    const consistency = Object.values(runs).map(r => ({ run: r.key, ok: r.consistent, detail: r.consistencyDetail }));

    // ---------- Candidate modules ----------
    const modules = buildModules(rows, byId, instructions, variables, findings, instById);

    const summary = {
        prompts: rows.length, inOrder: rows.filter(r => r.inOrder).length, enabled: rows.filter(r => r.inOrder && r.enabled).length,
        instructions: instructions.filter(i => i.kind === 'text').length,
        sentByRun: Object.fromEntries(Object.keys(runs).map(k => [k, rows.filter(x => x.status[k]?.status === 'sent').length])),
        duplicates: findings.filter(f => f.type.startsWith('duplicate')).length,
        conflicts: findings.filter(f => f.type.startsWith('conflict')).length,
        cosmetic: cosmetic.length, modules: modules.length,
    };

    return {
        tool: 'st-preset-dismantle', schema: 1, st: { version: ST_VERSION, commit: ST_COMMIT }, generatedAt: new Date().toISOString(),
        preset: { name: preset.name, orderSource: orderList ? `prompt_order[character_id=${GLOBAL_ORDER_ID}]` : null },
        probeInfo, summary, rules: RULES, consistency, loadDiff,
        runs: Object.values(runs).map(({ hitsBySource: _h, ...r }) => r),
        prompts: rows, instructions, findings, cosmetic, macros, variables, regexScripts, modules,
    };

    function buildRow(p, entry, idx) {
        const inOrder = !!entry;
        const enabled = !!entry?.enabled;
        const triggers = Array.isArray(p.injection_trigger) ? p.injection_trigger : [];
        const row = {
            identifier: p.identifier, name: p.name || p.identifier, orderIndex: idx, inOrder, enabled, marker: !!p.marker,
            systemPrompt: !!p.system_prompt, forbidOverrides: !!p.forbid_overrides, placement: placementOf(p), triggers,
            contentLength: typeof p.content === 'string' ? p.content.length : 0, status: {}, sentIn: [],
        };
        for (const [key, run] of Object.entries(runs)) {
            row.status[key] = statusFor(p, row, run);
            if (row.status[key].status === 'sent') row.sentIn.push(key);
        }
        return row;
    }
}

function statusFor(p, row, run) {
    const type = run.type;
    if (run.error) return { status: 'probe-error', basis: 'dry-run', note: run.error };
    if (!row.inOrder) return { status: 'orphan', basis: 'source-rule', rule: 'promptOrder', note: '不在全局 prompt_order 中，不会被收集。' };
    if (!row.enabled) return { status: 'disabled', basis: 'source-rule', rule: 'collection', note: row.identifier === 'main' ? '已关闭；ST 以空内容的 main 占位。' : '在 prompt_order 中被关闭。' };
    if (row.triggers.length && !row.triggers.includes(type)) return { status: 'trigger-excluded', basis: 'source-rule', rule: 'trigger', note: `触发器 ${row.triggers.join(',')} 不含 ${type}。` };
    const hits = run.hitsBySource.get(`p:${p.identifier}`) || run.hitsBySource.get(`marker:${p.identifier}`) || [];
    const nonEmpty = hits.filter(h => h.text.trim());
    if (nonEmpty.length) return { status: 'sent', basis: 'dry-run', messages: [...new Set(nonEmpty.map(h => h.message))], roles: [...new Set(nonEmpty.map(h => h.role))], container: nonEmpty[0].container, sample: excerpt(nonEmpty[0].text, 300), resolvedText: nonEmpty.map(h => h.text).join('\n') };
    if (run.overridden.includes(p.identifier)) return { status: 'overridden', basis: 'dry-run', rule: 'overrides', note: '被角色卡覆盖内容替换。' };
    if (!row.marker && !String(p.content || '').trim()) return { status: 'empty', basis: 'source-rule', note: 'Prompt 内容为空，不产生消息。' };
    if (hits.length) return { status: 'empty-after-macros', basis: 'dry-run', note: '宏求值后内容为空，实际请求中不会出现。' };
    if (row.marker) return { status: 'no-runtime-data', basis: 'dry-run', note: '探针未提供此类运行时数据，输出中没有对应内容。' };
    return { status: 'not-observed', basis: 'dry-run', note: '已启用且触发，但输出中未找到（可能因 token 预算被舍弃或被其他机制移除）。' };
}

function buildRun(key, probe, byId) {
    const messages = [];
    const hitsBySource = new Map();
    const overridden = [];
    const hit = (k, h) => { if (!hitsBySource.has(k)) hitsBySource.set(k, []); hitsBySource.get(k).push(h); };
    (probe.tagged || []).forEach((m, index) => {
        const segments = splitTagged(m.content).map(s => {
            let source = s.source ? { kind: s.source.kind, id: s.source.id } : null;
            if (!source) {
                const only = s.data.length === 1 ? s.data[0] : null;
                if (only && DATA_SOURCE[`${only.kind}:${only.id}`]) source = { kind: 'marker', id: DATA_SOURCE[`${only.kind}:${only.id}`] };
                else if (only?.kind === 'h') source = { kind: 'chat', id: only.id };
                else if (only?.kind === 'x') source = { kind: 'example', id: only.id };
                else if (only?.kind === 'q') source = { kind: 'quiet', id: only.id };
                else if (only?.kind === 'o') source = { kind: 'override', id: only.id };
                else if (UTILITY_CONTAINERS[m.identifier]) source = { kind: 'u', id: UTILITY_CONTAINERS[m.identifier] };
                else if (MARKERS[m.container] && m.container !== 'chatHistory') source = { kind: 'marker', id: m.container };
                else source = { kind: 'unattributed', id: m.identifier || m.container || '' };
            }
            if (source.kind === 'p') source.name = byId.get(source.id)?.name || source.id;
            if (source.kind === 'marker') source.name = MARKERS[source.id] || source.id;
            for (const d of s.data) {
                if (d.kind === 'o' && !overridden.includes(d.id)) overridden.push(d.id);
                if (DATA_SOURCE[`${d.kind}:${d.id}`] && source.kind !== 'marker') hit(`marker:${DATA_SOURCE[`${d.kind}:${d.id}`]}`, { message: index, role: m.role, container: m.container, text: s.text, via: source });
            }
            return { ...s, source };
        });
        const inChat = m.container === 'chatHistory' && segments.some(s => s.source.kind === 'p' || s.source.kind === 'u');
        messages.push({ index, role: m.role, name: m.name, container: m.container, identifier: m.identifier, inChatInjection: inChat, segments });
        for (const s of segments) {
            const h = { message: index, role: m.role, container: m.container, text: s.text };
            hit(s.source.kind === 'marker' ? `marker:${s.source.id}` : `${s.source.kind}:${s.source.id}`, h);
            // Runtime data placed by a marker's own container (examples, chat messages) counts as that marker being sent.
            if (s.source.kind !== 'marker' && s.source.kind !== 'p' && MARKERS[m.container]) hit(`marker:${m.container}`, h);
        }
    });
    // Consistency: tagged run minus boundary tags must equal the untagged run.
    const plain = probe.plain || [];
    const norm = c => String(typeof c === 'string' ? c : JSON.stringify(c)).replace(/\s+/g, ' ').trim();
    const stripped = (probe.tagged || []).map(m => ({ role: m.role, content: norm(stripBoundaryTags(m.content)) })).filter(m => m.content);
    const plainN = plain.map(m => ({ role: m.role, content: norm(m.content) })).filter(m => m.content);
    let consistent = stripped.length === plainN.length && stripped.every((m, i) => m.role === plainN[i].role && m.content === plainN[i].content);
    let consistencyDetail = consistent ? `${plainN.length} 条消息逐条一致` : `标记运行 ${stripped.length} 条 / 原样运行 ${plainN.length} 条`;
    if (!consistent && stripped.length === plainN.length) {
        const bad = stripped.findIndex((m, i) => m.role !== plainN[i].role || m.content !== plainN[i].content);
        consistencyDetail += `，第 ${bad} 条不同`;
    }
    return { key, type: probe.type || key, variant: probe.variant || 'base', error: probe.error || null, messages, plain, squashed: probe.squashed || null, consistent, consistencyDetail, hitsBySource, overridden };
}

function diffLoad(raw, loaded) {
    const out = [];
    const rawIds = new Set((raw.prompts || []).map(p => p.identifier));
    for (const p of loaded.prompts || []) if (!rawIds.has(p.identifier)) out.push({ kind: 'prompt-added', identifier: p.identifier, note: 'ST 加载时补入的 Prompt（文件中不存在）。' });
    const ro = (raw.prompt_order || []).find(o => String(o.character_id) === GLOBAL_ORDER_ID)?.order || [];
    const lo = (loaded.prompt_order || []).find(o => String(o.character_id) === GLOBAL_ORDER_ID)?.order || [];
    if (!ro.length) out.push({ kind: 'order-missing', note: `文件中没有 character_id=${GLOBAL_ORDER_ID} 的 prompt_order，已加载状态使用 ${lo.length} 项。` });
    const rIds = ro.map(e => `${e.identifier}:${e.enabled}`).join('|');
    const lIds = lo.map(e => `${e.identifier}:${e.enabled}`).join('|');
    if (ro.length && rIds !== lIds) out.push({ kind: 'order-changed', note: 'ST 加载后的全局顺序/开关与文件不同。', raw: ro, loaded: lo });
    return out;
}

function buildModules(rows, byId, instructions, variables, findings) {
    const modules = [];
    for (const r of rows) {
        const p = byId.get(r.identifier);
        if (p.marker || !String(p.content || '').trim()) continue;
        const lines = p.content.split(/\r?\n/);
        const units = instructions.filter(i => i.prompt === r.identifier);
        const blocks = [];
        const top = units.filter(u => u.kind === 'structure' && u.section.length === 0 && !u.text.startsWith('</'));
        const closes = units.filter(u => u.kind === 'structure' && u.section.length === 0 && u.text.startsWith('</'));
        if (top.length >= 2) {
            let cursor = 1;
            for (const open of top) {
                const name = open.text.match(/^<([^\s>/]+)/)[1];
                const close = closes.find(c => c.line > open.line && c.text.startsWith(`</${name}`));
                if (!close) continue;
                if (open.line > cursor && lines.slice(cursor - 1, open.line - 1).join('\n').trim()) blocks.push({ title: `${r.name}（前言）`, from: cursor, to: open.line - 1 });
                blocks.push({ title: `${r.name} / <${name}>`, from: open.line, to: close.line });
                cursor = close.line + 1;
            }
            if (cursor <= lines.length && lines.slice(cursor - 1).join('\n').trim()) blocks.push({ title: `${r.name}（尾部）`, from: cursor, to: lines.length });
        }
        if (!blocks.length) blocks.push({ title: r.name, from: 1, to: lines.length });
        for (const b of blocks) {
            const content = lines.slice(b.from - 1, b.to).join('\n');
            const inst = units.filter(u => u.line >= b.from && u.endLine <= b.to);
            const ids = new Set(inst.map(i => i.id));
            const reads = variables.filter(v => v.reads.some(x => x.prompt === r.identifier && x.line >= b.from && x.line <= b.to)).map(v => v.name);
            const writes = variables.filter(v => v.writes.some(x => x.prompt === r.identifier && x.line >= b.from && x.line <= b.to)).map(v => v.name);
            const macroNames = [...new Set(findMacros(content).filter(m => m.kind === 'macro').map(m => m.name))];
            const related = findings.filter(f => (f.instructions || []).some(id => ids.has(id)));
            const coupledReads = reads.filter(n => variables.find(v => v.name === n)?.writes.some(w => w.prompt !== r.identifier));
            const kinds = inst.reduce((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] || 0) + 1 }), {});
            const tagCount = {}; inst.forEach(i => i.tags.forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; }));
            const reuse = coupledReads.length ? 'coupled' : (macroNames.length || reads.length) ? 'needs-runtime' : 'standalone';
            modules.push({
                id: `m-${fnv(r.identifier + ':' + b.from + ':' + content)}`, title: b.title,
                source: { prompt: r.identifier, promptName: r.name, lines: [b.from, b.to] },
                content, role: r.placement.role, placement: r.placement, triggers: r.triggers, sentIn: r.sentIn,
                enabledInPreset: r.inOrder && r.enabled, kinds, tags: tagCount, macros: macroNames, variablesRead: reads, variablesWritten: writes,
                coupledVariables: coupledReads, reuse,
                purelyCosmetic: inst.length > 0 && inst.every(i => ['decorative', 'comment', 'structure', 'heading'].includes(i.kind) || i.tags.includes('cosmeticOutput')),
                relatedFindings: related.map(f => ({ id: f.id, type: f.type })),
            });
        }
    }
    return modules;
}

/** ST Prompt Manager import format; prompt_order is empty so importing never reorders the user's list. */
export function modulesToPromptExport(modules) {
    return {
        version: 1, type: 'full',
        data: {
            prompts: modules.map(m => ({
                identifier: `pd-${m.id.slice(2)}`, name: `[拆解] ${m.title}`, role: m.role || 'system', content: m.content,
                system_prompt: false, marker: false, injection_position: m.placement.kind === 'in-chat' ? 1 : 0,
                injection_depth: m.placement.depth ?? 4, injection_order: m.placement.order ?? 100,
                injection_trigger: m.triggers || [], forbid_overrides: false,
            })),
            prompt_order: [],
        },
    };
}
