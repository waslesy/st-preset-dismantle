// Unique markers injected only into the probe run so every output fragment can be attributed.
// p = preset prompt, u = utility prompt setting (boundary markers, prefixed to content)
// c = character/persona field, h = chat message, x = example dialogue, o = card override, q = quiet prompt (data markers)
export const BOUNDARY_KINDS = new Set(['p', 'u']);
export const tag = (kind, id) => `\u27E6PD:${kind}:${id}\u27E7`;
export const TAG_RE = /\u27E6PD:([a-z]):([^\u27E7]*)\u27E7/g;

/**
 * Splits one output message into attributed segments.
 * @returns {{source: {kind:string,id:string}|null, text:string, data:{kind:string,id:string}[]}[]}
 */
export function splitTagged(content) {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const segments = [];
    let cur = { source: null, raw: '' };
    let last = 0;
    for (const m of text.matchAll(TAG_RE)) {
        if (!BOUNDARY_KINDS.has(m[1])) continue;
        cur.raw += text.slice(last, m.index);
        segments.push(cur);
        cur = { source: { kind: m[1], id: m[2] }, raw: '' };
        last = m.index + m[0].length;
    }
    cur.raw += text.slice(last);
    segments.push(cur);
    return segments
        .filter(s => s.source || s.raw.trim())
        .map(s => ({
            source: s.source,
            text: s.raw.replace(/^\n+|\n+$/g, ''),
            data: [...s.raw.matchAll(TAG_RE)].map(m => ({ kind: m[1], id: m[2] })),
        }));
}

export function stripBoundaryTags(content) {
    return String(content).replace(TAG_RE, (all, kind) => (BOUNDARY_KINDS.has(kind) ? '' : all));
}
