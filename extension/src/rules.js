// Source-code references for every mechanism the dissector reports.
// Line numbers refer to the pinned SillyTavern commit below; see docs/MECHANISMS.md.
export const ST_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
export const ST_VERSION = '1.19.0';

const src = (file, line, symbol) => ({ file, line, symbol, url: `https://github.com/SillyTavern/SillyTavern/blob/${ST_COMMIT}/${file}#L${line}` });

export const RULES = {
    promptOrder: { ...src('public/scripts/PromptManager.js', 1207, 'getPromptOrderForCharacter'), text: 'Chat Completion uses the global prompt_order list of dummy character 100001; other lists are ignored.' },
    collection: { ...src('public/scripts/PromptManager.js', 1516, 'getPromptCollection'), text: 'Only prompt_order entries with enabled=true whose trigger matches the generation type are collected; a disabled/untriggered "main" is replaced by an empty prompt.' },
    trigger: { ...src('public/scripts/PromptManager.js', 1549, 'shouldTrigger'), text: 'injection_trigger empty or missing = all generation types; otherwise only the listed types.' },
    macros: { ...src('public/scripts/PromptManager.js', 1277, 'preparePrompt'), text: 'Prompt content goes through substituteParams (macro engine) at build time.' },
    relativeAssembly: { ...src('public/scripts/openai.js', 1185, 'populateChatCompletion'), text: 'Relative prompts are placed at the position of their prompt_order entry; markers are filled by runtime data.' },
    inChat: { ...src('public/scripts/openai.js', 810, 'populationInjectionPrompts'), text: 'In-chat prompts (injection_position=1) are inserted into chat history by depth; same depth: higher order first, then system/user/assistant; same depth+order+role are joined with "\\n" into one message.' },
    overrides: { ...src('public/scripts/openai.js', 1498, 'preparePromptsForChatCompletion'), text: 'Character card system_prompt / post_history_instructions replace "main" / "jailbreak" unless forbid_overrides=true.' },
    squash: { ...src('public/scripts/openai.js', 3922, 'ChatCompletion.squashSystemMessages'), text: 'squash_system_messages merges consecutive unnamed system messages; it is NOT applied in dry-run, the dissector applies the same ST method afterwards.' },
    dryRun: { ...src('public/script.js', 5320, 'Generate'), text: 'Generate(type, {}, true) assembles the prompt and returns before any API call.' },
    regexScope: { ...src('public/script.js', 4504, 'Generate'), text: 'promptOnly regex scripts run on chat history messages (and world info) while building the prompt, never on preset prompt text; preset-scoped scripts run only if the preset is in preset_allowed_regex (engine.js L122).' },
    regexPlacement: { ...src('public/scripts/extensions/regex/engine.js', 333, 'getRegexedString'), text: 'markdownOnly scripts change only displayed text; promptOnly scripts change only the outgoing prompt; neither = edits the stored message.' },
};
