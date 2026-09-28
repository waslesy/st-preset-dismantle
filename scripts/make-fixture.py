# Builds fixtures/PD Fixture.json: the official Default preset plus prompts that exercise each mechanism.
import json, copy
d = json.load(open('fixtures/ST Default.json'))
d = copy.deepcopy(d)
def P(identifier, name, content, **kw):
    return {'identifier': identifier, 'name': name, 'role': kw.pop('role', 'system'), 'content': content,
            'system_prompt': False, 'marker': False, **kw}
extra = [
    P('rules', '写作规则', '<rules>\n# 写作规则\n- 必须使用第三人称叙述。\n- 每次回复不少于300字。\n- 禁止替{{user}}说话或行动。\n- 必须使用简体中文回复。\n</rules>\n<style>\n- 文风细腻，注重感官描写。\n</style>'),
    P('rules2', '补充规则', '- 使用第一人称叙述。\n- 每次回复不超过100字。\n- 可以替{{user}}说话。\n- 请用英文回复。\n- 文风细腻，注重感官描写。'),
    P('status', '状态栏', '<status>\n在每次回复末尾输出状态栏：\n```html\n<div class="status">❤ 好感度：{{getvar::affection}}</div>\n```\n</status>\n════════════════'),
    P('vars', '变量初始化', '{{setvar::affection::10}}{{setvar::mood::happy}}当前心情：{{getvar::mood}}\n{{// 这是注释，不会发送}}\n{{if .flag}}flag已设置{{/if}}\n{{notARealMacro}}\n<% if (x) { %>EJS 片段<% } %>'),
    P('dupe', '重复规则', '- 文风细腻，注重感官描写。'),
    P('inchat0', '深度0-系统', '[D0 系统注入：保持角色]', injection_position=1, injection_depth=0, injection_order=100),
    P('inchat2a', '深度2-用户-低序', '[D2 用户 order50 A]', role='user', injection_position=1, injection_depth=2, injection_order=50),
    P('inchat2b', '深度2-用户-低序-同组', '[D2 用户 order50 B]', role='user', injection_position=1, injection_depth=2, injection_order=50),
    P('inchat2c', '深度2-助手-高序', '[D2 助手 order200]', role='assistant', injection_position=1, injection_depth=2, injection_order=200),
    P('impOnly', '仅扮演触发', '[仅在 impersonate 时发送]', injection_trigger=['impersonate']),
    P('contOnly', '仅续写触发', '[仅在 continue 时发送]', injection_trigger=['continue']),
    P('off', '已关闭', '[这条已被关闭]'),
    P('orphan', '孤立条目', '[不在 prompt_order 中]'),
    P('emptyMacro', '宏求值为空', '{{trim}}'),
]
d['prompts'].extend(extra)
order = next(o for o in d['prompt_order'] if str(o['character_id']) == '100001')['order']
idx = [o['identifier'] for o in order].index('chatHistory')
new = [{'identifier': p['identifier'], 'enabled': p['identifier'] != 'off'} for p in extra if p['identifier'] != 'orphan']
order[idx:idx] = [x for x in new if not x['identifier'].startswith('inchat')]
order.extend(x for x in new if x['identifier'].startswith('inchat'))
d['extensions'] = {
    'regex_scripts': [
        {'id': 'pd-regex-1', 'scriptName': '隐藏状态栏', 'findRegex': '/<status>[\\s\\S]*?<\\/status>/g', 'replaceString': '',
         'trimStrings': [], 'placement': [2], 'disabled': False, 'markdownOnly': True, 'promptOnly': False, 'runOnEdit': True,
         'substituteRegex': 0, 'minDepth': None, 'maxDepth': None},
        {'id': 'pd-regex-2', 'scriptName': '提示词替换', 'findRegex': '/foo/g', 'replaceString': 'bar', 'trimStrings': [],
         'placement': [1, 2], 'disabled': False, 'markdownOnly': False, 'promptOnly': True, 'runOnEdit': False,
         'substituteRegex': 0, 'minDepth': None, 'maxDepth': 2},
    ],
    'some_other_extension': {'foo': 1},
}
json.dump(d, open('fixtures/PD Fixture.json', 'w'), ensure_ascii=False, indent=4)
print('ok', len(d['prompts']))
