/**
 * 自编程引擎 — Policy-driven，执行者不做决策
 *
 * 核心原则：
 *   执行者只执行，不决策。决策权归议会。
 *
 * 旧设计（有问题）：
 *   executor 自己判断 explore/exploit/consolidate → 自己选策略 → 自己执行
 *   = 执行者做了太多决策
 *
 * 新设计：
 *   council 设定 policy → executor 只管按 policy 执行 → 结果回 council → council 调整 policy
 *
 * Policy 不是固定阶段，是议会随时可以发的"指令"：
 *   research   — 只读不写，收集信息汇报
 *   analyze    — 分析 results.tsv，不做新实验
 *   explore    — 大胆尝试，每轮换方向
 *   exploit    — 精炼当前最优，小步迭代
 *   consolidate — 清理、简化、固化
 *
 * executor 遇到任何需要判断的事 → 不自己决定 → escalate 给 council
 */

// ============================================================
// Types
// ============================================================

export type PolicyType = 'research' | 'analyze' | 'explore' | 'exploit' | 'consolidate'

/**
 * Policy — 议会下发给执行者的指令
 *
 * 不是"阶段"，是"当前你该怎么做"。
 * 议会可以随时换 policy，不需要按顺序走。
 */
export interface Policy {
  type: PolicyType
  instructions: string       // 具体指令，人话
  constraints: Constraint[]  // 这个 policy 下的约束
  metrics: Metric[]          // 这个 policy 下关注的指标
  maxRounds?: number         // 最多执行几轮，到了自动 escalate
  setBy: string              // 谁设的（'council' | 'human' | voter id）
  setAt: Date
}

/**
 * Metric — 评估指标（可以是议会生成的，也可以是人指定的）
 */
export interface Metric {
  name: string
  description: string
  extractCommand: string     // 怎么提取这个指标（shell 命令或脚本）
  weight: number             // 0-1，多个指标的权重
  direction: 'higher' | 'lower' | 'pass-fail'
  source: 'human' | 'council' | 'auto'  // 谁定的
}

/**
 * Constraint — 约束规则
 */
export interface Constraint {
  description: string
  type: 'hard' | 'soft'     // hard = 违反即 discard，soft = 扣分
  checkCommand: string       // 怎么检查（shell 命令，exit 0 = pass）
  penalty?: number           // soft 约束的扣分值（0-1）
  source: 'human' | 'council' | 'auto'
}

/**
 * Escalation — 执行者遇到需要判断的事，上报给议会
 *
 * P0-3: 必须附已尝试步骤（attempts），否则被拒绝。
 * 自动触发的（policy-expired）除外。
 */
export interface Escalation {
  id: string
  type: 'unknown-territory'   // 遇到没见过的情况
    | 'metric-ambiguous'      // 不确定指标好还是坏
    | 'constraint-conflict'   // 两个约束冲突
    | 'direction-unclear'     // 不知道该往哪走
    | 'policy-expired'        // maxRounds 到了
    | 'unexpected-result'     // 结果出乎意料
    | 'needs-research'        // 需要先调研
    | 'blocked'               // 执行被阻挡
  description: string
  context: Record<string, unknown>
  analysis?: BlockerAnalysis   // 阻挡问题的分析（blocked 类型必须附带）
  attempts: Array<{ action: string; result: string }>  // P0-3: 已尝试的步骤
  timestamp: Date
}

/**
 * BlockerAnalysis — 遇到阻挡问题时的结构化分析
 *
 * 原则："先分析问题，再去解决"
 * 不允许盲目重试，不允许跳过分析直接 escalate。
 *
 * 执行者遇到阻挡时必须填写：
 *   1. 什么问题 — 具体的错误/阻挡描述
 *   2. 为什么 — 根因分析（不是重复错误信息，是分析原因）
 *   3. 影响范围 — 这个问题会影响什么
 *   4. 可能的解法 — 至少想 1 个方向
 *   5. 选了哪个 — 选择的方向和理由
 */
export interface BlockerAnalysis {
  /** 什么问题 — 具体错误信息或阻挡描述 */
  what: string
  /** 为什么 — 根因分析 */
  why: string
  /** 影响范围 — 阻塞了什么，不阻塞什么 */
  impact: string
  /** 可能的解法 — 至少 1 个 */
  possibleFixes: Array<{
    approach: string
    pros: string
    cons: string
  }>
  /** 选择的方向 — 哪个解法、为什么 */
  chosen?: {
    approach: string
    reasoning: string
  }
  /** 分析时间 */
  analyzedAt: Date
}

/**
 * 验证 BlockerAnalysis 是否合格
 *
 * 拒绝敷衍分析：
 * - what/why 不能太短（至少 10 字符）
 * - why 不能是 what 的复读
 * - 必须有至少 1 个 possibleFix
 */
export function validateBlockerAnalysis(analysis: BlockerAnalysis): {
  valid: boolean
  reason?: string
} {
  if (analysis.what.trim().length < 10) {
    return { valid: false, reason: 'Analysis "what" too short — describe the actual error/blocker in detail.' }
  }

  if (analysis.why.trim().length < 10) {
    return { valid: false, reason: 'Analysis "why" too short — analyze the root cause, don\'t just repeat the error.' }
  }

  // why 不能是 what 的复读（相似度检查）
  const whatLower = analysis.what.toLowerCase().trim()
  const whyLower = analysis.why.toLowerCase().trim()
  if (whatLower === whyLower || whyLower.startsWith(whatLower) || whatLower.startsWith(whyLower)) {
    return { valid: false, reason: '"why" is just repeating "what" — analyze the ROOT CAUSE, not the symptom.' }
  }

  if (analysis.possibleFixes.length === 0) {
    return { valid: false, reason: 'Must propose at least 1 possible fix before escalating or retrying.' }
  }

  return { valid: true }
}

/**
 * SelfProgram — 当前运行状态（policy + metrics + constraints + history）
 */
export interface SelfProgram {
  goal: string               // 人定的目标
  currentPolicy: Policy      // 当前 policy（议会设的）
  policyHistory: Policy[]    // 历史 policy
  escalations: Escalation[]  // 待处理的 escalation
  roundsOnCurrentPolicy: number
}

// ============================================================
// Policy presets — 议会的快捷选项，不是固定流程
// ============================================================

export const POLICY_PRESETS: Record<PolicyType, Omit<Policy, 'setBy' | 'setAt' | 'constraints' | 'metrics'>> = {
  research: {
    type: 'research',
    instructions: '只读不写。阅读代码、文档、搜索资料。把发现汇报给议会，不要自己做决定。',
    maxRounds: 5,
  },
  analyze: {
    type: 'analyze',
    instructions: '分析已有的 results.tsv 和实验历史。找规律、找趋势、找问题。输出分析报告给议会，不做新实验。',
    maxRounds: 3,
  },
  explore: {
    type: 'explore',
    instructions: '大胆尝试不同方向。每轮换一个思路。不要在一个方向上死磕。保留所有结果。',
    maxRounds: 10,
  },
  exploit: {
    type: 'exploit',
    instructions: '精炼当前最优方案。小步迭代，每轮只改一个变量。如果连续3轮没有提升，escalate 给议会。',
    maxRounds: 20,
  },
  consolidate: {
    type: 'consolidate',
    instructions: '清理代码，简化架构，固化成果。不再追求指标提升，focus 在可维护性。',
    maxRounds: 5,
  },
}

// ============================================================
// Core functions
// ============================================================

/**
 * 创建初始 SelfProgram — 给定目标，用默认 research policy 启动
 *
 * 开始永远是 research，因为不了解情况就不该动手。
 * 但议会可以在第一轮就切换到别的 policy（比如目标很清晰的时候直接 exploit）。
 */
export function createSelfProgram(goal: string, startPolicy?: PolicyType): SelfProgram {
  const policyType = startPolicy ?? 'research'
  const preset = POLICY_PRESETS[policyType]

  const initialPolicy: Policy = {
    ...preset,
    constraints: [],
    metrics: [],
    setBy: 'council',
    setAt: new Date(),
  }

  return {
    goal,
    currentPolicy: initialPolicy,
    policyHistory: [],
    escalations: [],
    roundsOnCurrentPolicy: 0,
  }
}

/**
 * 切换 policy — 只有议会能调用
 *
 * 执行者不能自己切换 policy。执行者只能 escalate。
 * P0-2: 物理检查 callerRole，非 council/human 直接 throw。
 */
export function switchPolicy(
  program: SelfProgram,
  newPolicyType: PolicyType,
  callerRole: 'council' | 'human' | 'executor',
  overrides?: Partial<Policy>,
): SelfProgram {
  if (callerRole === 'executor') {
    throw new Error('BLOCKED: Executor cannot switch policy. Use escalate() instead.')
  }
  // 旧 policy 归档
  const history = [...program.policyHistory, program.currentPolicy]

  const preset = POLICY_PRESETS[newPolicyType]
  const newPolicy: Policy = {
    ...preset,
    constraints: overrides?.constraints ?? program.currentPolicy.constraints,
    metrics: overrides?.metrics ?? program.currentPolicy.metrics,
    instructions: overrides?.instructions ?? preset.instructions,
    maxRounds: overrides?.maxRounds ?? preset.maxRounds,
    setBy: overrides?.setBy ?? 'council',
    setAt: new Date(),
  }

  return {
    ...program,
    currentPolicy: newPolicy,
    policyHistory: history,
    roundsOnCurrentPolicy: 0,
    escalations: [],  // 切换 policy 清空 escalation
  }
}

/**
 * Escalate — 执行者上报问题，不自己做决定
 *
 * P0-3: 必须附 attempts（已尝试的步骤），否则被拒绝。
 * 自动触发的（policy-expired）除外。
 *
 * CC 原则："Escalation is a last resort, not a first response to friction"
 */
export function escalate(
  program: SelfProgram,
  type: Escalation['type'],
  description: string,
  attempts: Array<{ action: string; result: string }> = [],
  context: Record<string, unknown> = {},
  analysis?: BlockerAnalysis,
): Escalation {
  // P0-3: 非自动触发的 escalation 必须有 attempts
  const AUTO_TYPES: Escalation['type'][] = ['policy-expired']
  if (!AUTO_TYPES.includes(type) && attempts.length === 0) {
    throw new Error(
      `BLOCKED: Escalation rejected — no prior attempts.\n` +
      `You must try to resolve "${type}" before escalating.\n` +
      `Provide at least one attempt: { action: "what you tried", result: "what happened" }`
    )
  }

  // blocked 类型必须附带分析
  if (type === 'blocked') {
    if (!analysis) {
      throw new Error(
        `BLOCKED: "blocked" escalation requires a BlockerAnalysis.\n` +
        `Analyze the problem first: what happened, why, impact, possible fixes.`
      )
    }
    const validation = validateBlockerAnalysis(analysis)
    if (!validation.valid) {
      throw new Error(`BLOCKED: BlockerAnalysis rejected — ${validation.reason}`)
    }
  }

  const esc: Escalation = {
    id: `esc-${Date.now()}`,
    type,
    description,
    context,
    analysis,
    attempts,
    timestamp: new Date(),
  }

  program.escalations.push(esc)
  return esc
}

/**
 * 执行者每轮执行后调用 — 检查是否需要 escalate
 *
 * 自动 escalation 场景：
 * 1. maxRounds 到了 → policy-expired
 * 2. exploit 模式下连续 N 轮没提升 → direction-unclear
 * 3. 结果违反 hard constraint → 不 escalate，直接 discard（这是规则不是决策）
 */
export function tickRound(
  program: SelfProgram,
  metricResults?: Record<string, number>,
  previousBest?: Record<string, number>,
): { program: SelfProgram; shouldEscalate: boolean; escalation?: Escalation } {

  program.roundsOnCurrentPolicy++

  // maxRounds 到了
  if (program.currentPolicy.maxRounds &&
      program.roundsOnCurrentPolicy >= program.currentPolicy.maxRounds) {
    const esc = escalate(program, 'policy-expired',
      `已执行 ${program.roundsOnCurrentPolicy} 轮，达到 ${program.currentPolicy.type} policy 上限`,
      [],  // auto-trigger, no attempts needed
      { roundsCompleted: program.roundsOnCurrentPolicy })
    return { program, shouldEscalate: true, escalation: esc }
  }

  // exploit 模式下连续没提升
  if (program.currentPolicy.type === 'exploit' && metricResults && previousBest) {
    const dominated = program.currentPolicy.metrics.every(m => {
      const current = metricResults[m.name]
      const best = previousBest[m.name]
      if (current === undefined || best === undefined) return false
      return m.direction === 'higher' ? current <= best : current >= best
    })

    if (dominated) {
      const esc = escalate(program, 'direction-unclear',
        '当前轮次没有超过最优值',
        [{ action: 'exploit iteration', result: `metrics did not improve: ${JSON.stringify(metricResults)}` }],
        { current: metricResults, best: previousBest })
      return { program, shouldEscalate: true, escalation: esc }
    }
  }

  return { program, shouldEscalate: false }
}

/**
 * 评估实验结果 — 纯计算，不做决策
 *
 * 返回加权分数和约束检查结果。
 * keep/discard 的决定不在这里做 — 交给 judge.ts 或 council。
 */
export function scoreExperiment(
  metrics: Metric[],
  constraints: Constraint[],
  results: Record<string, number>,
  constraintResults: Record<string, boolean>,
): { weightedScore: number; hardFail: boolean; softPenalty: number; details: string[] } {

  const details: string[] = []
  let weightedScore = 0
  let totalWeight = 0

  // 指标加权
  for (const metric of metrics) {
    const value = results[metric.name]
    if (value === undefined) {
      details.push(`[MISSING] ${metric.name}`)
      continue
    }
    weightedScore += value * metric.weight
    totalWeight += metric.weight
    details.push(`${metric.name}: ${value} (weight ${metric.weight})`)
  }

  if (totalWeight > 0) {
    weightedScore = weightedScore / totalWeight
  }

  // 约束检查
  let hardFail = false
  let softPenalty = 0

  for (const constraint of constraints) {
    const passed = constraintResults[constraint.description] ?? true
    if (!passed) {
      if (constraint.type === 'hard') {
        hardFail = true
        details.push(`[HARD FAIL] ${constraint.description}`)
      } else {
        softPenalty += constraint.penalty ?? 0.1
        details.push(`[SOFT FAIL -${constraint.penalty ?? 0.1}] ${constraint.description}`)
      }
    }
  }

  return { weightedScore, hardFail, softPenalty, details }
}

// ============================================================
// Prompt builders — 给 AI agent 用的
// ============================================================

/**
 * P2-4: Prompt 缓存边界标记
 *
 * CC 用 __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ 分割静态/动态部分：
 *   - 静态部分（可缓存）：角色定义、规则、约束模板
 *   - 动态部分（不缓存）：当前 policy、metrics、轮次
 *
 * 好处：静态部分的 token 只计费一次，减少 API 成本。
 */
export const PROMPT_CACHE_BOUNDARY = '__AUTOPILOT_PROMPT_DYNAMIC_BOUNDARY__'

/**
 * 给执行者的 prompt — 告诉它当前 policy 和边界
 *
 * 关键：明确告诉执行者"你不能决定什么"
 *
 * P2-4: prompt 分两段：
 *   1. 静态段（角色定义 + 规则）→ 可被 API provider 缓存
 *   2. 动态段（当前 policy + metrics + 轮次）→ 每次不同
 */
export function buildExecutorPrompt(program: SelfProgram): string {
  const p = program.currentPolicy

  // P0-1: 获取当前 policy 下可用的工具
  let availableToolsStr = ''
  try {
    const { getAvailableTools } = require('./toolGate.js')
    const tools = getAvailableTools(p.type, 'executor')
    availableToolsStr = tools.join(', ')
  } catch {
    availableToolsStr = '(tool gate not loaded)'
  }

  // === 静态段开始（可缓存）===
  let prompt = `# Your Role: EXECUTOR

You execute tasks. You do NOT make strategic decisions.

## What You CAN Do
- Execute the task according to the policy above
- Report results (metrics, observations, findings)
- Flag issues you encounter

## What You CANNOT Do
- Change direction or strategy (escalate instead)
- Skip constraints (even if you think they're wrong)
- Decide "this is good enough" (that's the council's call)
- Switch to a different approach without council approval
- Modify policy, checklist definitions, metrics, or evaluation criteria
- Use tools not listed above

## When Blocked → ANALYZE FIRST, FIX SECOND
When you encounter an error or blocker, you MUST follow this sequence:

**Step 1: ANALYZE** — What is the problem? Why did it happen? What does it affect?
**Step 2: THINK** — What are possible fixes? Pros/cons of each?
**Step 3: CHOOSE** — Pick the best approach and explain why.
**Step 4: FIX** — Execute the chosen approach.
**Step 5: VERIFY** — Did the fix work?

NEVER skip to Step 4. NEVER blindly retry the same thing.
NEVER escalate without completing Steps 1-3 first.

\`\`\`json
{
  "analysis": {
    "what": "specific error or blocker",
    "why": "root cause (NOT just repeating the error)",
    "impact": "what this blocks, what it doesn't",
    "possibleFixes": [{ "approach": "...", "pros": "...", "cons": "..." }],
    "chosen": { "approach": "...", "reasoning": "..." }
  }
}
\`\`\`

## Escalation (after analysis + fix attempt)
Only escalate after you have analyzed AND attempted at least one fix.
\`\`\`json
{
  "escalate": true,
  "type": "blocked",
  "description": "what happened",
  "analysis": { "what": "...", "why": "...", ... },
  "attempts": [{ "action": "what I tried", "result": "what happened" }]
}
\`\`\`

${PROMPT_CACHE_BOUNDARY}

## Current Goal
${program.goal}

## Current Policy: ${p.type.toUpperCase()}
${p.instructions}

## Available Tools (ENFORCED — other tools will be blocked)
${availableToolsStr}
`

  if (p.maxRounds) {
    prompt += `\n## Round Limit\nYou have ${p.maxRounds - program.roundsOnCurrentPolicy} rounds remaining on this policy.\n`
  }

  if (p.metrics.length > 0) {
    prompt += `\n## Metrics to Track\n`
    for (const m of p.metrics) {
      prompt += `- ${m.name} (${m.direction}, weight ${m.weight}): ${m.description}\n`
      prompt += `  Extract: \`${m.extractCommand}\`\n`
    }
  }

  if (p.constraints.length > 0) {
    prompt += `\n## Constraints (DO NOT VIOLATE)\n`
    for (const c of p.constraints) {
      prompt += `- [${c.type.toUpperCase()}] ${c.description}\n`
      prompt += `  Check: \`${c.checkCommand}\`\n`
    }
  }

  if (p.maxRounds) {
    prompt += `\n## Round Limit\nYou have ${p.maxRounds - program.roundsOnCurrentPolicy} rounds remaining on this policy.\n`
  }

  return prompt
}

/**
 * 给议会的 prompt — 用于决定下一步 policy
 *
 * 议会看到全局信息，做出 policy 决策。
 */
export function buildCouncilPolicyPrompt(
  program: SelfProgram,
  recentResults?: string,
  escalation?: Escalation,
): string {

  let prompt = `# Policy Decision Required

## Goal
${program.goal}

## Current Policy
Type: ${program.currentPolicy.type}
Rounds completed: ${program.roundsOnCurrentPolicy}
Set by: ${program.currentPolicy.setBy}
Instructions: ${program.currentPolicy.instructions}

## Policy History
${program.policyHistory.map((p, i) =>
  `${i + 1}. ${p.type} (${p.setBy}, ${program.policyHistory.length - i} policies ago)`
).join('\n') || 'None — this is the first policy'}
`

  if (escalation) {
    prompt += `
## Escalation
Type: ${escalation.type}
Description: ${escalation.description}
Context: ${JSON.stringify(escalation.context, null, 2)}
`
  }

  if (recentResults) {
    prompt += `
## Recent Results
${recentResults}
`
  }

  prompt += `
## Available Policies
- research — 只读不写，收集信息
- analyze — 分析已有数据，找规律
- explore — 大胆尝试不同方向
- exploit — 精炼当前最优
- consolidate — 清理收尾

## Your Decision
Choose next policy. You can also:
- Adjust metrics and their weights
- Add/remove constraints
- Override instructions
- Set max rounds

Output JSON:
{
  "policy": "research|analyze|explore|exploit|consolidate",
  "instructions": "optional override",
  "maxRounds": 10,
  "metrics": [{ "name": "...", "weight": 0.5, ... }],
  "constraints": [{ "description": "...", "type": "hard|soft", ... }],
  "reasoning": "why this policy now"
}
`

  return prompt
}

/**
 * 渲染当前 program 状态 — 人类可读
 */
export function renderStatus(program: SelfProgram): string {
  let out = `# Autopilot Status\n\n`
  out += `**Goal:** ${program.goal}\n`
  out += `**Policy:** ${program.currentPolicy.type} (round ${program.roundsOnCurrentPolicy}`
  if (program.currentPolicy.maxRounds) {
    out += `/${program.currentPolicy.maxRounds}`
  }
  out += `)\n`
  out += `**Set by:** ${program.currentPolicy.setBy}\n`
  out += `**Instructions:** ${program.currentPolicy.instructions}\n\n`

  if (program.currentPolicy.metrics.length > 0) {
    out += `## Metrics\n`
    for (const m of program.currentPolicy.metrics) {
      out += `- ${m.name} (${m.direction}, w=${m.weight})\n`
    }
    out += '\n'
  }

  if (program.currentPolicy.constraints.length > 0) {
    out += `## Constraints\n`
    for (const c of program.currentPolicy.constraints) {
      out += `- [${c.type}] ${c.description}\n`
    }
    out += '\n'
  }

  if (program.escalations.length > 0) {
    out += `## Pending Escalations\n`
    for (const e of program.escalations) {
      out += `- [${e.type}] ${e.description}\n`
    }
    out += '\n'
  }

  if (program.policyHistory.length > 0) {
    out += `## Policy History\n`
    for (const p of program.policyHistory) {
      out += `- ${p.type} (by ${p.setBy})\n`
    }
  }

  return out
}
