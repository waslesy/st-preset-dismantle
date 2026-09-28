// Text-level parsing: macros, instruction segmentation, heuristic tagging.
// Everything here is static and heuristic unless stated otherwise.

/** Finds top-level {{...}} macros with balanced nesting. */
export function findMacros(text) {
    const out = [];
    if (typeof text !== 'string') return out;
    let i = 0;
    while (i < text.length) {
        const start = text.indexOf('{{', i);
        if (start < 0) break;
        if (start > 0 && text[start - 1] === '\\') { i = start + 2; continue; }
        let depth = 0; let j = start; let end = -1;
        while (j < text.length - 1) {
            if (text[j] === '{' && text[j + 1] === '{') { depth++; j += 2; continue; }
            if (text[j] === '}' && text[j + 1] === '}') { depth--; j += 2; if (depth === 0) { end = j; break; } continue; }
            j++;
        }
        if (end < 0) break;
        const raw = text.slice(start, end);
        out.push({ raw, index: start, ...parseMacro(raw.slice(2, -2)) });
        i = end;
    }
    return out;
}

const SHORTHAND = /^([.$])([\w-]+)\s*(\|\|=|\?\?=|\+\+|--|\+=|-=|==|!=|>=|<=|\|\||\?\?|=|>|<)?\s*([\s\S]*)$/;
const WRITE_OPS = new Set(['=', '++', '--', '+=', '-=', '||=', '??=']);
const VAR_WRITE = { setvar: 'local', addvar: 'local', incvar: 'local', decvar: 'local', setglobalvar: 'global', addglobalvar: 'global', incglobalvar: 'global', decglobalvar: 'global' };
const VAR_READ = { getvar: 'local', getglobalvar: 'global', hasvar: 'local', hasglobalvar: 'global', deletevar: 'local', deleteglobalvar: 'global' };

export function parseMacro(inner) {
    const body = inner.trim();
    if (body.startsWith('//')) return { name: '//', kind: 'comment' };
    if (body.startsWith('/')) return { name: body.slice(1).trim().split(/[\s:]/)[0], kind: 'close' };
    const sh = body.match(SHORTHAND);
    if (sh) {
        const scope = sh[1] === '.' ? 'local' : 'global';
        const op = sh[3] || '';
        return { name: sh[1] + sh[2], kind: 'variable', variable: { name: sh[2], scope, op, write: WRITE_OPS.has(op), value: WRITE_OPS.has(op) ? sh[4] : undefined } };
    }
    const flagless = body.replace(/^[!?~#>]+\s*/, '');
    const m = flagless.match(/^([A-Za-z][\w-]*)/);
    if (!m) return { name: flagless.split(/[\s:]/)[0] || '', kind: 'unknown' };
    const name = m[1];
    const rest = flagless.slice(name.length);
    const args = rest.startsWith('::') ? rest.slice(2).split('::') : rest.startsWith(':') ? [rest.slice(1)] : rest.trim() ? [rest.trim()] : [];
    const lower = name.toLowerCase();
    if (VAR_WRITE[lower]) return { name, kind: 'variable', args, variable: { name: (args[0] || '').trim(), scope: VAR_WRITE[lower], op: lower, write: true, value: args[1] } };
    if (VAR_READ[lower]) return { name, kind: 'variable', args, variable: { name: (args[0] || '').trim(), scope: VAR_READ[lower], op: lower, write: false } };
    if (lower === 'if') {
        const cond = (args[0] || '').trim();
        const v = cond.replace(/^!/, '').match(/^([.$])([\w-]+)/);
        return { name, kind: 'scope', args, variable: v ? { name: v[2], scope: v[1] === '.' ? 'local' : 'global', op: 'if', write: false } : undefined };
    }
    return { name, kind: 'macro', args };
}

export function stripMacros(text) {
    let out = text; const ms = findMacros(text);
    for (let k = ms.length - 1; k >= 0; k--) out = out.slice(0, ms[k].index) + out.slice(ms[k].index + ms[k].raw.length);
    return out;
}

const TAG_LINE = /^\s*<(\/?)([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff:.-]*)((?:\s[^<>]*)?)(\/?)>\s*$/;
const HEADING = /^\s*(#{1,6}\s+\S.*|【[^】]+】\s*[:：]?\s*|={2,}\s*\S.*?={2,}|\[[^\]]{1,40}\]\s*[:：]?\s*)$/;
const BULLET = /^\s*(?:[-*•·+]|\d{1,3}[.、)）]|[（(]\d{1,3}[)）]|[一二三四五六七八九十]{1,3}[、.．])\s*/;

/**
 * Splits prompt text into instruction units with 1-based line numbers.
 * @returns {{n:number, line:number, endLine:number, text:string, kind:string, section:string[]}[]}
 */
export function segment(text) {
    const units = [];
    if (typeof text !== 'string' || !text) return units;
    const lines = text.split(/\r?\n/);
    const stack = []; let heading = null; let cur = null;
    const flush = () => { if (cur) { units.push(cur); cur = null; } };
    const section = () => [...stack.map(t => `<${t}>`), ...(heading ? [heading] : [])];
    const push = (kind, idx, t) => units.push({ line: idx + 1, endLine: idx + 1, text: t, kind, section: section() });
    // Multi-line {{// }} ... {{ /// }} comment blocks
    let inComment = false;
    lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (inComment) { cur.text += '\n' + line; cur.endLine = idx + 1; if (/\{\{\s*\/\/\/\s*\}\}/.test(line)) { inComment = false; flush(); } return; }
        if (/^\{\{\s*\/\/\s*\}\}\s*$/.test(trimmed)) { flush(); cur = { line: idx + 1, endLine: idx + 1, text: line, kind: 'comment', section: section() }; inComment = true; return; }
        if (!trimmed) { flush(); return; }
        const tag = trimmed.match(TAG_LINE);
        if (tag) {
            flush();
            const [, closing, name, , selfClosing] = tag;
            if (closing) { const at = stack.lastIndexOf(name); if (at >= 0) stack.length = at; heading = null; push('structure', idx, trimmed); }
            else { push('structure', idx, trimmed); if (!selfClosing) { stack.push(name); heading = null; } }
            return;
        }
        if (HEADING.test(trimmed) && !BULLET.test(trimmed)) { flush(); heading = trimmed.replace(/^#+\s*/, ''); push('heading', idx, trimmed); return; }
        if (cur && !BULLET.test(line) && /^\s{2,}/.test(line) && cur.bullet) { cur.text += '\n' + line; cur.endLine = idx + 1; return; }
        flush();
        cur = { line: idx + 1, endLine: idx + 1, text: line, kind: 'text', section: section(), bullet: BULLET.test(line) };
    });
    if (cur && inComment) cur.kind = 'comment';
    flush();
    return units.map((u, n) => {
        const { bullet: _b, ...rest } = u;
        return { n: n + 1, ...rest, kind: rest.kind === 'text' ? classifyKind(rest.text) : rest.kind };
    });
}

const NON_WORD = /[\p{P}\p{S}\p{Z}\s\p{Cc}]/gu;

export function classifyKind(text) {
    const macros = findMacros(text);
    const rest = stripMacros(text);
    if (!rest.replace(NON_WORD, '')) {
        if (!macros.length) return 'decorative';
        if (macros.every(m => m.kind === 'comment')) return 'comment';
        if (macros.some(m => m.variable?.write)) return 'variable-op';
        return 'macro-only';
    }
    return 'text';
}

export const NEG = /(不要|不准|不得|禁止|严禁|避免|切勿|切忌|勿|不可|不能|不许|杜绝|拒绝|无需|不需要|别再|\bnever\b|\bdon'?t\b|\bdo not\b|\bavoid\b|\bmust not\b|\bmustn'?t\b|\brefrain\b|\bno more\b)/i;
export const POS = /(必须|务必|一定要|应当|应该|需要|总是|始终|要求|请|可以|允许|\ballowed\b|\bmay\b|\balways\b|\bmust\b|\bshould\b|\bmake sure\b|\bensure\b|\brequired?\b)/i;

const TAGS = {
    prohibition: NEG,
    requirement: POS,
    format: /(格式|输出|排版|format|markdown|json|yaml|<\s*[a-z][\w-]*\s*>|标签)/i,
    length: /(\d+\s*(字|个字|词|words?|tokens?|段|段落|paragraphs?|句|sentences?)|字数|篇幅|长度|length)/i,
    pov: /(第[一二三]人称|\b(first|second|third)[- ]person\b|视角|\bPOV\b)/i,
    language: /(简体中文|繁体中文|中文|汉语|英文|英语|日文|日语|\bEnglish\b|\bChinese\b|\bJapanese\b)/i,
    role: /(你是|你将|扮演|身份|\byou are\b|\bact as\b|\broleplay\b|\brole-play\b)/i,
    thinking: /(思考|思维链|推理|草稿|<\/?think|\bthinking\b|\breason(ing)?\b|\bCoT\b)/i,
    content: /(NSFW|色情|性爱|暴力|血腥|露骨|R18|成人|\bexplicit\b|\bgore\b)/i,
    style: /(文风|风格|描写|语气|修辞|比喻|基调|\bstyle\b|\btone\b|\bprose\b)/i,
    cosmeticOutput: /(<\s*(div|span|details|summary|table|font|br|style|p)\b|style\s*=|\bcss\b|\bhtml\b|状态栏|美化|表情符号|\bemoji\b|颜色|\bcolor\b|字体|边框|卡片|面板|代码块)/i,
};

export function tagInstruction(text) {
    const plain = stripMacros(text);
    const tags = [];
    for (const [tag, re] of Object.entries(TAGS)) if (re.test(plain)) tags.push(tag);
    if (tags.includes('prohibition') && tags.includes('requirement') && !POS.test(plain.replace(new RegExp(NEG.source, 'gi'), ''))) tags.splice(tags.indexOf('requirement'), 1);
    return tags;
}

export function normalize(text) {
    return stripMacros(String(text)).toLowerCase().replace(NON_WORD, '');
}

export function bigrams(s) {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    if (s.length === 1) set.add(s);
    return set;
}

export function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    const [small, big] = a.size < b.size ? [a, b] : [b, a];
    for (const x of small) if (big.has(x)) inter++;
    return inter / (a.size + b.size - inter);
}

const UNIT = '(字|个字|词|words?|tokens?|段落|段|paragraphs?|句|sentences?)';
const unitKey = u => /^(字|个字)$/.test(u) ? 'chars' : /^(词|words?)$/i.test(u) ? 'words' : /tokens?/i.test(u) ? 'tokens' : /^(段落|段|paragraphs?)$/i.test(u) ? 'paragraphs' : 'sentences';

/** Extracts numeric length constraints as {unit,min,max,raw}. */
export function lengthConstraints(text) {
    const t = stripMacros(text); const out = [];
    const range = new RegExp(`(\\d+)\\s*(?:-|~|～|到|至|—|–|to)\\s*(\\d+)\\s*${UNIT}`, 'gi');
    const min = new RegExp(`(?:不少于|至少|最少|不低于|(?<!不)超过|(?<!不)多于|at least|minimum of|more than)\\s*(\\d+)\\s*${UNIT}|(\\d+)\\s*${UNIT}\\s*(?:以上|起)`, 'gi');
    const max = new RegExp(`(?:不超过|不多于|最多|至多|(?<!不)少于|(?<!不)低于|控制在|限制在|at most|no more than|up to|under|less than|maximum of)\\s*(\\d+)\\s*${UNIT}|(\\d+)\\s*${UNIT}\\s*(?:以内|以下|之内)`, 'gi');
    let m; const used = [];
    while ((m = range.exec(t))) { out.push({ unit: unitKey(m[3]), min: +m[1], max: +m[2], raw: m[0] }); used.push([m.index, m.index + m[0].length]); }
    const free = i => !used.some(([a, b]) => i >= a && i < b);
    while ((m = min.exec(t))) if (free(m.index)) { out.push({ unit: unitKey(m[2] || m[4]), min: +(m[1] || m[3]), max: Infinity, raw: m[0] }); used.push([m.index, m.index + m[0].length]); }
    while ((m = max.exec(t))) if (free(m.index)) out.push({ unit: unitKey(m[2] || m[4]), min: 0, max: +(m[1] || m[3]), raw: m[0] });
    return out;
}

const POV_RE = /(第一人称|第二人称|第三人称|\bfirst[- ]person\b|\bsecond[- ]person\b|\bthird[- ]person\b)/gi;
const povKey = s => /一|first/i.test(s) ? 'first' : /二|second/i.test(s) ? 'second' : 'third';
export function povValues(text) {
    const t = stripMacros(text); const found = new Set(); let m;
    while ((m = POV_RE.exec(t))) found.add(povKey(m[1]));
    return [...found];
}

const LANG_RE = /(?:使用|用|以|采用|输出|回复|回答|书写|写作|\bwrite in\b|\brespond in\b|\breply in\b|\banswer in\b|\bwrite only in\b)\s*(简体中文|繁体中文|中文|汉语|英文|英语|日文|日语|\bEnglish\b|\bChinese\b|\bJapanese\b)/gi;
const langKey = s => /繁体/.test(s) ? 'zh-Hant' : /中文|汉语|chinese/i.test(s) ? 'zh' : /英|english/i.test(s) ? 'en' : 'ja';
export function languageValues(text) {
    const t = stripMacros(text); const found = new Set(); let m;
    while ((m = LANG_RE.exec(t))) found.add(langKey(m[1]));
    return [...found];
}

/** Detects syntax that ST core does not evaluate (third-party extension syntax or display HTML). */
export function foreignSyntax(text) {
    const hits = [];
    if (/<%[\s\S]*?%>/.test(text)) hits.push({ kind: 'ejs', note: 'EJS 模板语法 <% %>，ST 本体不执行，需要第三方模板扩展。' });
    if (/<script\b/i.test(text)) hits.push({ kind: 'script', note: '<script> 标签，ST 本体不会在 Prompt 中执行。' });
    if (/^\s*\/[a-z][\w-]*\s/im.test(stripMacros(text)) && /^\s*\/(setvar|getvar|gen|send|sendas|echo|run|inject)\b/im.test(text)) hits.push({ kind: 'stscript', note: 'STscript 斜杠命令写在 Prompt 中只会作为文本发送，不会被执行。' });
    return hits;
}

/** |A∩B| / min(|A|,|B|): catches a short rule fully contained in a longer one. */
export function containment(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / Math.min(a.size, b.size);
}
