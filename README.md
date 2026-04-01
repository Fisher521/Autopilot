# Autopilot

Autonomous AI loop engine — combining Karpathy's autoresearch pattern with multi-AI adversarial review, self-programming metrics, and a weighted decision council.

## Core Idea

Humans and AI agents are equal participants in the decision process — they differ only in weight. This isn't "human tells AI what to do." It's a **decision council that votes**.

## Architecture

```
src/
├── index.ts          # CLI entry (init / run / verify / review / status / serve)
├── loop.ts           # Core loop engine (verify → metric → judge → keep/discard → record)
├── judge.ts          # Judgment engine (higher/lower/pass-fail)
├── tracker.ts        # results.tsv read/write + statistics
├── reviewer.ts       # Multi-AI adversarial review (critique / evaluate / contradict / verify)
├── selfProgram.ts    # Self-programming engine (auto-generate metrics / constraints / strategy)
├── council.ts        # Decision council (weighted voting + dynamic trust scores)
├── hub.ts            # Multi-task hub (parallel tasks + trend evaluation + Telegram interaction)
├── computerUse.ts    # Computer Use browser automation
├── notify.ts         # Telegram / Webhook notifications
└── gateway.ts        # HTTP API (remote control)
```

## Three Key Innovations

### 1. Self-Programming (`selfProgram.ts`)

The system doesn't rely on hardcoded evaluation criteria. Given a goal, AI automatically generates:
- **Evaluation metrics** — what to measure, how to extract, what weight to assign
- **Constraints** — hard (violate = discard) vs soft (penalize but continue)
- **Experiment strategy** — auto-switch between explore → exploit → consolidate phases

Every N iterations, the system self-adjusts: analyzes results.tsv trends, rebalances weights, updates strategy.

### 2. Multi-AI Adversarial Review (`reviewer.ts`)

Not one AI talking to itself — multiple LLMs challenging each other:
- **Claude Code** — executor
- **Codex** — reviewer (devil's advocate, finds problems)
- **OpenClaw (Gemini)** — supplementary perspective (engineering & performance)

Four review modes: critique (pure criticism), evaluate (objective scoring), contradict (intentional opposition), verify (independent verification).

### 3. Decision Council (`council.ts`)

Humans and AI do the same three things: provide context, evaluate, decide. The only difference is weight:

| Participant | Weight | Trust Score | Role |
|-------------|--------|-------------|------|
| Human (Fisher) | 3.0 | 1.0 (fixed) | Direction, context, final call |
| Claude Code | 1.0 | 0.85 (dynamic) | Code quality, architecture, security |
| Codex | 1.0 | 0.80 (dynamic) | Review, alternatives, edge cases |
| OpenClaw | 0.5 | 0.75 (dynamic) | Engineering, performance, scalability |

Decision rules:
- Human votes reject → **veto** (instant reject)
- Human votes approve → passes even if all AIs disagree
- Human abstains → AI weighted vote decides
- Trust scores auto-adjust based on historical accuracy (+0.01 correct, -0.02 wrong)

## Usage

```bash
# Install
npm install -g autopilot

# Initialize a project
autopilot init

# Run the loop
autopilot run

# Check status
autopilot status

# Start HTTP API
autopilot serve
```

## Inspired By

- [Andrej Karpathy — autoresearch](https://github.com/karpathy/autoresearch) — LOOP FOREVER + keep/discard
- [Claude Code](https://claude.ai/code) — Coordinator Mode, multi-agent orchestration
- [OpenClaw](https://github.com/nicepkg/openclaw) — Remote AI gateway

## Contributors

- **[Fisher](https://github.com/Fisher521)** — Creator, architecture, product direction
- **[Claude Code](https://claude.ai/code)** (Anthropic) — Implementation, code quality
- **[Codex](https://openai.com/codex)** (OpenAI) — Adversarial review, alternative approaches
- **[Andrej Karpathy](https://github.com/karpathy)** — autoresearch pattern that inspired the core loop

## License

MIT
