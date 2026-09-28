# st-preset-dismantle

SillyTavern（Chat Completion）社区 Preset 拆解工具。以 SillyTavern 扩展形式运行，**由 SillyTavern 自己解析并组装已加载的 Preset**（`Generate(type, {}, true)` dry-run，在发出请求前返回），不调用任何模型 API，不需要 API Key。

锁定版本：SillyTavern 1.19.0 @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127`（见 `extension/src/rules.js`，所有源码规则都附带该 commit 的 GitHub 行号链接）。

## 它做什么

- **实际生效顺序**：对 normal / continue / impersonate / swipe / regenerate / quiet 以及“角色卡覆盖”各跑一次 dry-run，拿到 ST 最终要发送的消息序列。探针在内存中给每个已准备的 Prompt 加边界标记（包装 `promptManager.preparePrompt`，不写入设置），再用无标记的一次运行校验去标记后的消息完全一致，从而把每条最终消息归因到 Prompt、角色卡字段、聊天记录、示例对话或 ST 辅助提示。
- **逐条指令**：按行/列表项/XML 段落切分，保留原文、行号、所在段落、宏、变量读写，以及每种生成类型下是否发送、落在哪条消息。
- **判断与证据**：重复（完全/近似）、冲突（禁止↔允许、字数、人称、语言）、纯美化内容（装饰行、状态栏 HTML、仅显示的 Regex）、运行时依赖（占位符、未注册/未解析的宏、变量读写顺序、角色卡覆盖、Regex、EJS 等非 ST 语法、第三方扩展数据）。每条判断都带原文证据和证据等级：
  - `dry-run`：本次真实 dry-run 中观察到；
  - `source-rule`：依据锁定版本的 ST 源码推导，本次探针未观察到；
  - `heuristic`：文本启发式，需要人工复核。
  只有 `dry-run` 代表已验证。
- **候选模块**：按段落/主题聚合为可复用模块，标注 `standalone` / `needs-runtime` / `coupled`，可导出为 Prompt Manager 可导入的 JSON（导入后出现在 Prompt 列表中，需手动加入顺序）。

输出：`*.dismantle.html`（报告）、`*.dismantle.json`（完整数据）、`*.modules.md`、`*.modules.prompts.json`。

## 使用

需要 Node ≥ 20。

```bash
npm ci
npx playwright install chromium
npm run setup:st            # 在 .st/ 检出锁定版 ST，关闭无关扩展，链接本扩展
(cd .st && node server.js)  # http://127.0.0.1:8000
npm run dissect -- --preset "path/to/preset.json" --out out/my-preset
```

CLI 通过 ST 自己的 Preset 导入界面导入 JSON，然后在页面内运行拆解。参数：`--st <url>`、`--types normal,continue`、`--no-override`、`--headed`、`--save-input`（额外保存分析器输入，便于离线复现）。

也可以直接在 ST 中使用：扩展设置面板 → “Preset 拆解” → 拆解当前 Preset / 查看报告 / 导出。

## 探针的局限（报告中也会列出）

- 探针角色没有世界书，不会触发第三方扩展注入；这些位置只标为占位符依赖。
- 报告的是 ST 组装后的消息，不包括发送前各供应商的格式转换（如 system 合并、Claude 前缀）。
- dry-run 下 swipe/regenerate 不会删除最后一条消息；角色卡覆盖是否生效取决于 `prefer_character_prompt` / `prefer_character_jailbreak`。
- Regex 脚本只报告其作用范围和字段，本次探针不执行。

## 开发

```bash
npm run lint
npm run check      # node --check 语法检查
npm test           # 单元测试：分析器基于真实 dry-run 捕获的输入（test/fixtures/*.input.json）
npm run test:e2e   # 需要运行中的 ST：官方 Default + 综合 fixture，断言没有任何 generate 请求
```

`fixtures/PD Fixture.json` 由 `scripts/make-fixture.py` 从官方 Default 生成，覆盖 in-chat 深度/顺序/角色、触发器、禁用、孤立 Prompt、宏、变量、冲突、重复、Regex 和扩展数据。
