import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMacros, parseMacro, segment, tagInstruction, lengthConstraints, povValues, languageValues, foreignSyntax, containment, bigrams } from '../../extension/src/text.js';

test('findMacros handles nesting and escapes', () => {
    const m = findMacros('a {{getvar::{{char}}_hp}} b \\{\\{not}} {{user}}');
    assert.deepEqual(m.map(x => x.raw), ['{{getvar::{{char}}_hp}}', '{{user}}']);
});

test('parseMacro classifies variables, comments, conditionals', () => {
    assert.equal(parseMacro('// note').kind, 'comment');
    assert.equal(parseMacro('/if').kind, 'close');
    const set = parseMacro('setvar::mood::happy');
    assert.equal(set.kind, 'variable');
    assert.deepEqual([set.variable.name, set.variable.scope, set.variable.write, set.variable.value], ['mood', 'local', true, 'happy']);
    const get = parseMacro('getglobalvar::x');
    assert.deepEqual([get.variable.scope, get.variable.write], ['global', false]);
    assert.equal(parseMacro('.hp = 3').variable.write, true);
    assert.equal(parseMacro('$score').variable.scope, 'global');
    const cond = parseMacro('if .flag');
    assert.deepEqual([cond.kind, cond.variable.name, cond.variable.write], ['scope', 'flag', false]);
});

test('segment keeps line ranges and XML-like sections', () => {
    const units = segment('<rules>\n- 一\n- 二\n  续行\n</rules>\n正文');
    const texts = units.filter(u => u.kind !== 'structure').map(u => [u.text, u.line, u.endLine, u.section.join('/')]);
    assert.deepEqual(texts.find(t => t[0].startsWith('- 二')), ['- 二\n  续行', 3, 4, '<rules>']);
    assert.ok(texts.some(t => t[0] === '正文' && t[3] === ''));
});

test('instruction tags and value extractors', () => {
    assert.ok(tagInstruction('禁止替{{user}}说话').includes('prohibition'));
    assert.deepEqual(lengthConstraints('每次回复不少于300字').map(c => [c.min, c.max]), [[300, Infinity]]);
    assert.deepEqual(lengthConstraints('字数在200-400字之间').map(c => [c.min, c.max]), [[200, 400]]);
    assert.deepEqual(povValues('使用第一人称'), ['first']);
    assert.deepEqual(languageValues('请用英文回复'), ['en']);
    assert.ok(foreignSyntax('<% if (x) { %>').length);
    assert.equal(containment(bigrams('替说话'), bigrams('替说话或行动')), 1);
});
