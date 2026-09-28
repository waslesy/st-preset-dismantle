// Renders an analysis report (from analyzer.js) as standalone HTML and Markdown. Pure functions.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BASIS = { 'dry-run': ['已在 dry-run 中观察', 'b-run'], 'source-rule': ['源码规则推导（本次未观察）', 'b-src'], heuristic: ['文本启发式（可能误判）', 'b-heu'] };
const badge = b => `<span class="badge ${BASIS[b]?.[1] || ''}" title="${esc(BASIS[b]?.[0] || b)}">${esc(BASIS[b]?.[0] || b)}</span>`;
const STATUS = {
    sent: '已发送', disabled: '已关闭', orphan: '不在顺序中', 'trigger-excluded': '触发器排除', 'empty-after-macros': '宏求值后为空',
    'no-runtime-data': '无运行时数据', empty: '空内容', 'not-observed': '未观察到', overridden: '被角色卡覆盖', 'probe-error': '探针出错',
};
const SRC = { p: 'Preset Prompt', u: '辅助提示设置', marker: '占位符', chat: '聊天消息', example: '示例对话', quiet: 'Quiet Prompt', override: '角色卡覆盖', unattributed: '未归因（ST/扩展内部）' };
const pre = t => `<pre>${esc(t)}</pre>`;
const place = p => p.kind === 'in-chat' ? `聊天内 depth=${p.depth} order=${p.order} role=${p.role}` : p.kind === 'marker' ? '占位符' : `相对 role=${p.role}`;

function evidenceBlock(list) {
    if (!list?.length) return '';
    return `<ul class="ev">${list.map(e => `<li><code>${esc(e.promptName || e.prompt || e.field || (e.run ? `${e.run} #${e.message}` : ''))}${e.lines ? ` L${e.lines[0]}${e.lines[1] !== e.lines[0] ? '-' + e.lines[1] : ''}` : e.line ? ` L${e.line}` : ''}</code>${pre(e.text)}</li>`).join('')}</ul>`;
}

export function renderHTML(r) {
    const h = [];
    h.push(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Preset 拆解：${esc(r.preset.name)}</title><style>${CSS}</style></head><body>`);
    h.push(`<h1>Preset 拆解报告：${esc(r.preset.name)}</h1>`);
    h.push(`<p class="meta">SillyTavern ${esc(r.st.version)} @ <code>${esc(r.st.commit.slice(0, 10))}</code> · 生成于 ${esc(r.generatedAt)} · 顺序来源 <code>${esc(r.preset.orderSource || '无')}</code></p>`);
    h.push(`<nav>${['概览', '生效顺序', 'Prompt 清单', '发现', '美化内容', '宏与变量', 'Regex', '候选模块', '逐条指令'].map((t, i) => `<a href="#s${i}">${t}</a>`).join(' · ')}</nav>`);

    h.push(`<h2 id="s0">概览</h2><table><tr>${Object.entries({ Prompt: r.summary.prompts, 在顺序中: r.summary.inOrder, 已启用: r.summary.enabled, 指令条数: r.summary.instructions, 重复: r.summary.duplicates, 冲突: r.summary.conflicts, 美化: r.summary.cosmetic, 候选模块: r.summary.modules }).map(([k, v]) => `<th>${k}</th><td>${v}</td>`).join('')}</tr></table>`);
    h.push(`<p>证据等级：${Object.keys(BASIS).map(badge).join(' ')}。只有“已在 dry-run 中观察”的结论来自 SillyTavern 实际组装的请求。</p>`);
    if (r.consistency.length) h.push(`<table><tr><th>探针</th><th>归因一致性（标记运行去标记后 = 原样运行）</th></tr>${r.consistency.map(c => `<tr><td>${esc(c.run)}</td><td class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '一致' : '不一致'}：${esc(c.detail)}</td></tr>`).join('')}</table>`);
    if (r.probeInfo?.notes?.length) h.push(`<ul>${r.probeInfo.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`);
    if (r.loadDiff?.length) h.push(`<h3>ST 加载时的变化</h3><ul>${r.loadDiff.map(d => `<li>${esc(d.kind)}：${esc(d.identifier || '')} ${esc(d.note)}</li>`).join('')}</ul>`);

    h.push('<h2 id="s1">生效顺序（SillyTavern dry-run 实际组装结果）</h2>');
    if (!r.runs.length) h.push('<p>未运行探针：以下没有任何“已发送”结论。</p>');
    for (const run of r.runs) {
        h.push(`<details ${run.key === 'normal' ? 'open' : ''}><summary>${esc(run.key)}（生成类型 ${esc(run.type)}${run.variant !== 'base' ? '，' + esc(run.variant) : ''}）：${run.messages.length} 条消息${run.error ? ' — 错误：' + esc(run.error) : ''}</summary>`);
        h.push('<table class="seq"><tr><th>#</th><th>role</th><th>容器</th><th>来源片段（按实际顺序）</th></tr>');
        for (const m of run.messages) {
            h.push(`<tr><td>${m.index}</td><td>${esc(m.role)}</td><td><code>${esc(m.container)}</code>${m.inChatInjection ? '<br><span class="badge b-run">聊天内注入</span>' : ''}</td><td>${m.segments.map(s => `<div class="seg s-${esc(s.source.kind)}"><b>${esc(SRC[s.source.kind] || s.source.kind)}</b> <code>${esc(s.source.name || s.source.id)}</code><details><summary>${esc(s.text.slice(0, 80))}${s.text.length > 80 ? '…' : ''}</summary>${pre(s.text)}</details></div>`).join('')}</td></tr>`);
        }
        h.push('</table>');
        if (run.squashed) h.push(`<p>squash_system_messages 已开启：按 ST 的 squashSystemMessages 合并后为 ${run.squashed.length} 条消息（dry-run 本身不合并）。</p>`);
        h.push('</details>');
    }

    h.push('<h2 id="s2">Prompt 清单（按全局 prompt_order）</h2><table><tr><th>序</th><th>名称 / identifier</th><th>位置</th><th>触发器</th><th>开关</th>' + r.runs.map(x => `<th>${esc(x.key)}</th>`).join('') + '</tr>');
    for (const p of r.prompts) {
        h.push(`<tr><td>${p.orderIndex ?? '—'}</td><td>${esc(p.name)}<br><code>${esc(p.identifier)}</code>${p.forbidOverrides ? '<br>forbid_overrides' : ''}</td><td>${esc(place(p.placement))}</td><td>${esc(p.triggers.join(', ') || '全部')}</td><td>${p.inOrder ? (p.enabled ? '开' : '关') : '—'}</td>${r.runs.map(x => { const s = p.status[x.key]; return `<td class="st-${esc(s.status)}" title="${esc(s.note || '')}">${esc(STATUS[s.status] || s.status)}${s.messages ? ' #' + s.messages.join(',#') : ''}</td>`; }).join('')}</tr>`);
    }
    h.push('</table>');

    h.push('<h2 id="s3">发现（重复 / 冲突 / 运行时依赖）</h2>');
    const groups = [['冲突', f => f.type.startsWith('conflict')], ['重复', f => f.type.startsWith('duplicate')], ['运行时依赖', f => f.type.startsWith('dependency') || f.type.startsWith('macro')], ['其他', f => f.type.startsWith('order')]];
    for (const [title, pred] of groups) {
        const list = r.findings.filter(pred);
        h.push(`<h3>${title}（${list.length}）</h3>`);
        for (const f of list) h.push(`<div class="finding"><div>${badge(f.basis)} ${f.scope ? `<span class="badge ${f.scope === 'effective' ? 'b-eff' : ''}">${f.scope === 'effective' ? '同时生效：' + esc((f.effectiveIn || []).join(',')) : '潜在（未同时发送）'}</span>` : ''} <code>${esc(f.type)}</code> ${esc(f.message)}${f.rule ? ` <a href="${esc(f.rule.url)}">源码</a>` : ''}</div>${evidenceBlock(f.evidence)}</div>`);
    }

    h.push(`<h2 id="s4">美化内容（${r.cosmetic.length}）</h2>`);
    for (const c of r.cosmetic) h.push(`<div class="finding">${badge(c.basis)} <code>${esc(c.kind)}</code> ${esc(c.note)}${evidenceBlock([c.evidence])}</div>`);

    h.push('<h2 id="s5">宏与变量</h2><table><tr><th>宏</th><th>类别</th><th>依赖</th><th>使用位置</th></tr>');
    for (const m of r.macros) h.push(`<tr><td><code>{{${esc(m.name)}}}</code></td><td>${esc(m.category || (m.registered ? '' : '未注册'))}</td><td>${esc(m.dependency || '')}</td><td>${m.uses.map(u => `${esc(u.promptName)} L${u.line}`).join('<br>')}</td></tr>`);
    h.push('</table><table><tr><th>变量</th><th>作用域</th><th>写入</th><th>读取</th></tr>');
    for (const v of r.variables) h.push(`<tr><td>${esc(v.name)}${v.external ? ' <span class="badge b-heu">外部来源</span>' : ''}</td><td>${esc(v.scope)}</td><td>${v.writes.map(w => `${esc(w.promptName)} L${w.line} <code>${esc(w.text)}</code>`).join('<br>')}</td><td>${v.reads.map(w => `${esc(w.promptName)} L${w.line} <code>${esc(w.text)}</code>`).join('<br>')}</td></tr>`);
    h.push('</table>');

    h.push(`<h2 id="s6">Regex 脚本（${r.regexScripts.length}）</h2><table><tr><th>名称</th><th>find</th><th>作用</th><th>禁用</th></tr>${r.regexScripts.map(x => `<tr><td>${esc(x.name)}</td><td><code>${esc(x.find)}</code></td><td>${esc(x.note)}</td><td>${x.disabled ? '是' : ''}</td></tr>`).join('')}</table>`);

    h.push(`<h2 id="s7">候选模块（${r.modules.length}）</h2><p>standalone = 不含宏与变量；needs-runtime = 依赖宏/变量等运行时数据；coupled = 读取其他 Prompt 写入的变量。</p>`);
    for (const m of r.modules) h.push(`<details class="module"><summary><b>${esc(m.title)}</b> <code>${esc(m.id)}</code> · ${esc(m.reuse)} · ${esc(place(m.placement))} · 发送于：${esc(m.sentIn.join(',') || '无')}${m.purelyCosmetic ? ' · 纯美化' : ''}</summary><p>来源 ${esc(m.source.promptName)} L${m.source.lines[0]}-${m.source.lines[1]}；宏：${esc(m.macros.join(', ') || '无')}；读变量：${esc(m.variablesRead.join(', ') || '无')}；写变量：${esc(m.variablesWritten.join(', ') || '无')}；相关发现：${esc(m.relatedFindings.map(f => f.id + ':' + f.type).join(', ') || '无')}</p>${pre(m.content)}</details>`);

    h.push('<h2 id="s8">逐条指令</h2>');
    const byPrompt = new Map();
    for (const i of r.instructions) { if (!byPrompt.has(i.prompt)) byPrompt.set(i.prompt, []); byPrompt.get(i.prompt).push(i); }
    for (const [pid, list] of byPrompt) {
        h.push(`<details><summary>${esc(list[0].promptName)} <code>${esc(pid)}</code>（${list.length} 条）</summary><table><tr><th>#</th><th>行</th><th>类型</th><th>标签</th><th>分区</th><th>原文</th></tr>${list.map(i => `<tr><td>${i.id.split('#')[1]}</td><td>${i.line}${i.endLine !== i.line ? '-' + i.endLine : ''}</td><td>${esc(i.kind)}</td><td>${esc(i.tags.join(' '))}</td><td>${esc(i.section.join(' › '))}</td><td>${pre(i.text)}</td></tr>`).join('')}</table></details>`);
    }
    h.push('</body></html>');
    return h.join('\n');
}

export function renderModulesMarkdown(r) {
    const out = [`# 候选模块：${r.preset.name}`, '', `SillyTavern ${r.st.version} (${r.st.commit.slice(0, 10)})，生成于 ${r.generatedAt}。`, ''];
    for (const m of r.modules) {
        out.push(`## ${m.title}`, '', `- id: \`${m.id}\``, `- 来源: ${m.source.promptName} (\`${m.source.prompt}\`) L${m.source.lines[0]}-${m.source.lines[1]}`,
            `- 位置: ${place(m.placement)}；触发器: ${m.triggers.join(', ') || '全部'}`, `- 可复用性: ${m.reuse}${m.purelyCosmetic ? '（纯美化）' : ''}`,
            `- 实际发送（dry-run）: ${m.sentIn.join(', ') || '未观察到'}`, `- 宏: ${m.macros.join(', ') || '无'}；读变量: ${m.variablesRead.join(', ') || '无'}；写变量: ${m.variablesWritten.join(', ') || '无'}`,
            `- 相关发现: ${m.relatedFindings.map(f => `${f.id}(${f.type})`).join(', ') || '无'}`, '', '````text', m.content, '````', '');
    }
    return out.join('\n');
}

const CSS = `body{font:14px/1.5 system-ui,sans-serif;margin:1.5em;color:#222;background:#fff}h2{border-bottom:2px solid #ddd;margin-top:2em}table{border-collapse:collapse;margin:.5em 0;width:100%}td,th{border:1px solid #ddd;padding:3px 6px;vertical-align:top;text-align:left}pre{white-space:pre-wrap;word-break:break-word;margin:2px 0;background:#f6f6f6;padding:4px;max-height:24em;overflow:auto}code{background:#eef;padding:0 3px}.badge{display:inline-block;font-size:12px;padding:0 6px;border-radius:8px;background:#ddd}.b-run{background:#c8f0c8}.b-src{background:#cde3ff}.b-heu{background:#ffe8b0}.b-eff{background:#ffc9c9}.ok{color:#070}.bad{color:#b00;font-weight:bold}.finding{border-left:3px solid #ccc;padding:2px 8px;margin:6px 0}.seg{border-left:3px solid #999;padding-left:6px;margin:3px 0}.s-p{border-color:#2a7}.s-u{border-color:#27a}.s-marker{border-color:#a72}.s-chat{border-color:#aaa}.s-unattributed{border-color:#d33}.st-sent{background:#e6f7e6}.st-disabled,.st-orphan,.st-trigger-excluded{color:#888}.ev{margin:2px 0}nav{position:sticky;top:0;background:#fff;padding:4px 0;border-bottom:1px solid #eee}.meta{color:#666}`;
