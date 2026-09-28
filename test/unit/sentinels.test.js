import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tag, splitTagged, stripBoundaryTags } from '../../extension/src/sentinels.js';

test('splitTagged attributes text between boundary tags and keeps data tags', () => {
    const c = `${tag('p', 'main')}hello\n${tag('p', 'x')}world ${tag('c', 'description')}`;
    const s = splitTagged(c);
    assert.deepEqual(s.map(x => [x.source?.id, x.text.trim()]), [['main', 'hello'], ['x', `world ${tag('c', 'description')}`]]);
    assert.deepEqual(s[1].data, [{ kind: 'c', id: 'description' }]);
});

test('stripBoundaryTags removes only p/u tags', () => {
    assert.equal(stripBoundaryTags(`${tag('p', 'a')}x${tag('h', '0')}`), `x${tag('h', '0')}`);
});
