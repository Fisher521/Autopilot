# autopilot

CLI 自动化循环引擎 — 结合 Karpathy autoresearch + CC Coordinator + 多 AI 对抗审查 + 自编程 + 决策议会。

## 核心理念

人和 AI 是平等的决策参与者，区别只在权重。不是"人指挥 AI 干活"，是"决策议会投票"。

## 架构

```
autopilot/src/
├── index.ts          # CLI 入口（init / run / verify / review / status / serve）
├── loop.ts           # 核心循环引擎（verify → metric → judge → keep/discard → record）
├── judge.ts          # 判定器（higher/lower/pass-fail）
├── tracker.ts        # results.tsv 读写 + 统计
├── reviewer.ts       # 多 AI 对抗审查（critique / evaluate / contradict / verify）
├── selfProgram.ts    # 自编程引擎（自生成 metrics / constraints / strategy）
├── council.ts        # 决策议会（加权投票 + 信任分动态调整）
├── hub.ts            # 多任务中枢（并行任务 + 趋势评估 + Telegram 交互）
├── computerUse.ts    # Computer Use 浏览器自动化
├── notify.ts         # Telegram / Webhook 通知
└── gateway.ts        # HTTP API（远程控制）
```

## 三大创新

### 1. 自编程（selfProgram.ts）

系统不依赖人写死评估标准。给定目标，AI 自动生成：
- **评估指标** — 选什么 metric、怎么提取、权重多少
- **约束规则** — hard（违反即 discard）vs soft（扣分但可继续）
- **实验策略** — explore → exploit → consolidate 三阶段自动切换

每 N 轮自动 self-adjust：分析 results.tsv 趋势，调整权重，更新策略。

### 2. 多 AI 对抗审查（reviewer.ts）

不是一个 AI 自说自话，而是多个 LLM 互相挑刺：
- **Claude Code** — 执行者
- **Codex** — 审查者（唱反调、找问题）
- **OpenClaw (Gemini)** — 补充视角（工程性能）

四种审查模式：critique（纯挑刺）、evaluate（客观打分）、contradict（故意反对）、verify（独立验证）。

### 3. 决策议会（council.ts）

人和 AI 做同样的三件事：补充信息、评估、决策。区别只在权重：

| 参与者 | 权重 | 信任分 | 角色 |
|--------|------|--------|------|
| Human | 3.0 | 1.0 (固定) | 方向、上下文、最终决策 |
| Claude Code | 1.0 | 0.85 (动态) | 代码质量、架构、安全 |
| Codex | 1.0 | 0.80 (动态) | 审查、替代方案、边界情况 |
| OpenClaw | 0.5 | 0.75 (动态) | 工程、性能、可扩展性 |

决策规则：
- 人投 reject → 一票否决
- 人投 approve → 即使 AI 全反对也通过
- 人不投票 → AI 加权投票决定
- 信任分根据历史决策准确率自动调整（投对 +0.01，投错 -0.02）

## 使用

```bash
# 安装
npm install -g autopilot

# 初始化项目
autopilot init

# 运行循环
autopilot run

# 查看状态
autopilot status

# 启动 HTTP API
autopilot serve
```

## 灵感来源

- [Karpathy autoresearch](https://github.com/karpathy/autoresearch) — LOOP FOREVER + keep/discard
- Claude Code Coordinator Mode — 多 agent 编排
- OpenClaw — 远程 AI gateway

## License

MIT
