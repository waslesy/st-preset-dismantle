// SillyTavern UI extension: probes the currently loaded Chat Completion preset with dry-run generations
// (no API call, no API key) and dissects it with src/analyzer.js.
import { oai_settings, promptManager, getPresetApplicationPromise, ChatCompletion } from '../../../openai.js';
import { power_user } from '../../../power-user.js';
import { extension_settings } from '../../../extensions.js';
import { chat_metadata, eventSource, event_types, Generate, getCharacters, selectCharacterById, getRequestHeaders, saveChatConditional, main_api } from '../../../../script.js';
import { analyze, modulesToPromptExport, GLOBAL_ORDER_ID } from './src/analyzer.js';
import { renderHTML, renderModulesMarkdown } from './src/report.js';
import { tag } from './src/sentinels.js';

const PROBE_CHAR = 'PD Probe';
const PROBE_OVERRIDE_CHAR = 'PD Probe Override';
export const GENERATION_TYPES = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'];

const probeCardFields = override => ({
    ch_name: override ? PROBE_OVERRIDE_CHAR : PROBE_CHAR,
    description: tag('c', 'description'),
    personality: tag('c', 'personality'),
    scenario: tag('c', 'scenario'),
    first_mes: '',
    mes_example: `<START>\n{{user}}: ${tag('x', 'user')}\n{{char}}: ${tag('x', 'char')}`,
    system_prompt: override ? `${tag('o', 'main')}{{original}}` : '',
    post_history_instructions: override ? `${tag('o', 'jailbreak')}{{original}}` : '',
    creator_notes: 'Created by st-preset-dismantle for dry-run probing. Safe to delete.',
});

async function ensureProbeCharacter(override) {
    const ctx = SillyTavern.getContext();
    const name = override ? PROBE_OVERRIDE_CHAR : PROBE_CHAR;
    let idx = ctx.characters.findIndex(c => c.name === name);
    if (idx >= 0) return idx;
    const form = new FormData();
    for (const [k, v] of Object.entries(probeCardFields(override))) form.append(k, v);
    const res = await fetch('/api/characters/create', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form, cache: 'no-cache' });
    if (!res.ok) throw new Error(`创建探针角色失败：HTTP ${res.status}`);
    await getCharacters();
    idx = SillyTavern.getContext().characters.findIndex(c => c.name === name);
    if (idx < 0) throw new Error('探针角色创建后未找到');
    return idx;
}

async function prepareProbeChat(charIndex, length) {
    await selectCharacterById(charIndex);
    const ctx = SillyTavern.getContext();
    if (String(ctx.characterId) !== String(charIndex)) throw new Error('无法切换到探针角色');
    const charName = ctx.characters[charIndex].name;
    const msgs = [];
    for (let k = 0; k < length; k++) {
        // Oldest first; the last message is from the character so "continue" has a target.
        const isUser = (length - 1 - k) % 2 === 1;
        msgs.push({ name: isUser ? ctx.name1 : charName, is_user: isUser, is_system: false, send_date: new Date().toISOString(), mes: tag('h', String(k)), extra: {} });
    }
    ctx.chat.splice(0, ctx.chat.length, ...msgs);
    await saveChatConditional();
}

function walkMessages(root) {
    // root = PromptManager.messages (ChatCompletion.getMessages()). Mirrors ChatCompletion.getChat() but keeps container identifiers.
    const out = [];
    const push = (container, m) => out.push({ role: m.role, content: m.content, container, identifier: m.identifier, ...(m.name ? { name: m.name } : {}) });
    for (const item of root?.collection || []) {
        if (Array.isArray(item.collection)) { for (const m of item.collection) if (m.content || m.tool_calls) push(item.identifier, m); }
        else if (item.content || item.tool_calls) push(item.identifier, item);
    }
    return out;
}

async function dryRun(type) {
    // Every run starts from the same variable state so {{setvar}} side effects of one run cannot leak into the next.
    chat_metadata.variables = {};
    if (extension_settings.variables) extension_settings.variables.global = structuredClone(probeGlobals);
    let captured = null;
    const onReady = data => { if (data?.dryRun) captured = structuredClone(data.chat); };
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onReady);
    try {
        const opts = type === 'quiet' ? { quiet_prompt: tag('q', 'quiet') } : {};
        await Generate(type, opts, true);
    } finally {
        eventSource.removeListener(event_types.CHAT_COMPLETION_PROMPT_READY, onReady);
    }
    if (!captured) throw new Error(`dry-run(${type}) 没有产生 Chat Completion（检查是否选中了角色、API 是否为 Chat Completion）`);
    return { chat: captured, root: promptManager.messages };
}

let probeGlobals = {};

async function withTags(fn) {
    // Tags are added to PromptManager.preparePrompt() results only (after macro substitution, in memory).
    // Settings objects are never mutated, so nothing tagged can be persisted by ST's settings autosave.
    const presetIds = new Set(oai_settings.prompts.filter(p => !p.marker).map(p => p.identifier));
    const original = promptManager.preparePrompt;
    promptManager.preparePrompt = function (prompt, orig = null) {
        const prepared = original.call(this, prompt, orig);
        if (presetIds.has(prepared.identifier) && typeof prepared.content === 'string') prepared.content = tag('p', prepared.identifier) + prepared.content;
        return prepared;
    };
    try { return await fn(); } finally { promptManager.preparePrompt = original; }
}

async function probeOnce(key, type, variant) {
    try {
        const tagged = await withTags(() => dryRun(type));
        const taggedWalk = walkMessages(tagged.root);
        const plain = await dryRun(type);
        let squashed = null;
        if (oai_settings.squash_system_messages && plain.root) {
            // Same ST method the real (non-dry) path calls; applied to the dry-run message tree.
            const cc = new ChatCompletion();
            cc.messages = plain.root;
            await cc.squashSystemMessages();
            squashed = cc.getChat();
        }
        const walkOk = taggedWalk.length === tagged.chat.length;
        if (!walkOk) throw new Error(`归因树与 ST 输出条数不一致（${taggedWalk.length} vs ${tagged.chat.length}）`);
        return { type, variant, tagged: taggedWalk, plain: plain.chat, squashed };
    } catch (e) {
        return { type, variant, error: String(e?.message || e) };
    }
}

function maxInChatDepth() {
    const order = oai_settings.prompt_order.find(o => String(o.character_id) === GLOBAL_ORDER_ID)?.order || [];
    const depths = order.filter(e => e.enabled).map(e => oai_settings.prompts.find(p => p.identifier === e.identifier)).filter(p => p && Number(p.injection_position) === 1).map(p => Number(p.injection_depth ?? 4));
    return depths.length ? Math.max(...depths) : 0;
}

export async function runDissection({ types = GENERATION_TYPES, cardOverride = true, rawPreset = null } = {}) {
    if (main_api !== 'openai') throw new Error('当前 API 不是 Chat Completion（openai），Prompt Manager Preset 不生效。');
    const ctx = SillyTavern.getContext();
    const originalChar = ctx.characterId;
    const persona = { d: power_user.persona_description, p: power_user.persona_description_position };
    const savedGlobals = structuredClone(extension_settings.variables?.global ?? {});
    probeGlobals = structuredClone(savedGlobals);
    const chatLength = Math.min(Math.max(maxInChatDepth() + 3, 6), 60);
    const probes = {};
    const notes = [
        `探针角色「${PROBE_CHAR}」：角色字段、用户人设、示例对话、${chatLength} 条聊天消息均为唯一标记，用于归因；每种生成类型运行两次 dry-run（带 Prompt 标记 / 原样）。`,
        'dry-run 在 ST 组装请求后、调用 API 前返回；之后由 sendOpenAIRequest 与服务端完成的供应商格式转换（如 Claude/Gemini 的 system 处理、assistant_prefill）不在本报告范围内。',
        'dry-run 下 swipe/regenerate 不会删除最后一条消息（script.js 中以 !dryRun 保护），因此这两种类型的聊天内容比真实生成多一条；Prompt 触发与位置规则不受影响。',
        '探针未提供世界书、作者注释、扩展注入；相关占位符显示为“无运行时数据”。',
        `角色卡覆盖是否启用取决于用户设置 prefer_character_prompt=${power_user.prefer_character_prompt} / prefer_character_jailbreak=${power_user.prefer_character_jailbreak}（当前值）。`,
    ];
    try {
        power_user.persona_description = tag('c', 'persona');
        power_user.persona_description_position = 0;
        const base = await ensureProbeCharacter(false);
        await prepareProbeChat(base, chatLength);
        for (const t of types) probes[t] = await probeOnce(t, t, 'base');
        if (cardOverride) {
            const ov = await ensureProbeCharacter(true);
            await prepareProbeChat(ov, chatLength);
            probes['normal+card-override'] = await probeOnce('normal+card-override', 'normal', 'card-override');
        }
    } finally {
        power_user.persona_description = persona.d;
        power_user.persona_description_position = persona.p;
        if (extension_settings.variables) extension_settings.variables.global = savedGlobals;
        if (originalChar !== undefined && SillyTavern.getContext().characters[originalChar]) await selectCharacterById(Number(originalChar));
    }
    if (JSON.stringify(oai_settings).includes('⟦PD:')) throw new Error('内部错误：探针标记泄漏到了 oai_settings，已中止。');
    const macroCatalog = {};
    try {
        for (const def of ctx.macros.registry.getAllMacros()) macroCatalog[def.name.toLowerCase()] = { name: def.name, category: def.category, description: def.description };
        for (const def of ctx.macros.registry.getAllMacros()) for (const a of def.aliases || []) macroCatalog[a.alias.toLowerCase()] = { name: def.name, category: def.category, description: def.description };
    } catch (e) { notes.push('无法读取宏注册表：' + e); }
    const preset = {
        name: oai_settings.preset_settings_openai,
        prompts: structuredClone(oai_settings.prompts),
        prompt_order: structuredClone(oai_settings.prompt_order),
        extensions: structuredClone(oai_settings.extensions || {}),
    };
    const input = { preset, rawPreset, probes, macroCatalog, probeInfo: { chatLength, types, cardOverride, notes } };
    globalThis.PresetDismantle.lastInput = input;
    return analyze(input);
}

export function exportsFor(report) {
    const slug = String(report.preset.name || 'preset').replace(/[^\w\u4e00-\u9fff-]+/g, '_');
    return {
        [`${slug}.dismantle.json`]: JSON.stringify(report, null, 2),
        [`${slug}.dismantle.html`]: renderHTML(report),
        [`${slug}.modules.md`]: renderModulesMarkdown(report),
        [`${slug}.modules.prompts.json`]: JSON.stringify(modulesToPromptExport(report.modules), null, 4),
    };
}

function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: name.endsWith('.html') ? 'text/html' : 'application/json' }));
    a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

let lastReport = null;

function mountUI() {
    const html = `
    <div id="pd_panel" class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header"><b>Preset 拆解</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
      <div class="inline-drawer-content">
        <small>对当前加载的 Chat Completion Preset 执行 dry-run 探针（不调用 API），还原实际顺序并拆解。</small>
        <div id="pd_types">${GENERATION_TYPES.map(t => `<label class="checkbox_label"><input type="checkbox" value="${t}" checked>${t}</label>`).join('')}</div>
        <label class="checkbox_label"><input id="pd_override" type="checkbox" checked>角色卡覆盖探针</label>
        <div class="flex-container">
          <div id="pd_run" class="menu_button">拆解当前 Preset</div>
          <div id="pd_view" class="menu_button disabled">查看报告</div>
          <div id="pd_export" class="menu_button disabled">导出</div>
        </div>
        <div id="pd_status"></div>
      </div>
    </div>`;
    $('#extensions_settings2').append(html);
    $('#pd_run').on('click', async () => {
        $('#pd_status').text('运行中…');
        try {
            const types = $('#pd_types input:checked').map((_, el) => el.value).get();
            lastReport = await runDissection({ types, cardOverride: $('#pd_override').prop('checked') });
            const s = lastReport.summary;
            $('#pd_status').text(`完成：${s.prompts} 个 Prompt，${s.instructions} 条指令，${s.conflicts} 个冲突候选，${s.duplicates} 个重复，${s.modules} 个候选模块。`);
            $('#pd_view, #pd_export').removeClass('disabled');
        } catch (e) {
            console.error('[preset-dismantle]', e);
            $('#pd_status').text('失败：' + (e?.message || e));
        }
    });
    $('#pd_view').on('click', () => {
        if (!lastReport) return;
        const w = window.open(URL.createObjectURL(new Blob([renderHTML(lastReport)], { type: 'text/html' })), '_blank');
        if (!w) toastr.warning('浏览器阻止了弹窗');
    });
    $('#pd_export').on('click', () => { if (lastReport) for (const [n, t] of Object.entries(exportsFor(lastReport))) download(n, t); });
}

globalThis.PresetDismantle = {
    runDissection, exportsFor, analyze, GENERATION_TYPES,
    currentPreset: () => oai_settings.preset_settings_openai,
    mainApi: () => main_api,
    waitPresetApplied: () => getPresetApplicationPromise(),
};
jQuery(() => mountUI());
