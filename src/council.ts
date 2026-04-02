/**
 * 决策议会 — 人和 Agent 是平等的决策参与者，但权重不同
 *
 * 核心理念：
 * - 人和 AI 做同样的事：补充信息、评估、决策
 * - 区别只在权重：人的权重更高（信任度更高）
 * - AI 之间也有权重差异（CC vs Codex vs OpenClaw）
 *
 * 不是"人指挥 AI"，是"决策议会投票"：
 *   人（权重 3.0）+ CC（权重 1.0）+ Codex（权重 1.0）+ OpenClaw（权重 0.5）
 *
 * 三种参与方式（人和 AI 都一样）：
 * 1. 补充信息 — "这个 API 有速率限制" / "这个文件有历史包袱"
 * 2. 评估 — "这个改动 7/10" / "这个方向不对"
 * 3. 决策 — "继续" / "换方向" / "停"
 */

export interface Voter {
  id: string
  name: string
  type: 'human' | 'agent'
  provider?: 'claude' | 'codex' | 'openclaw'
  weight: number          // 投票权重
  trustScore: number      // 0-1，随时间根据决策准确率调整
  capabilities: string[]  // 擅长什么
}

export interface Vote {
  voterId: string
  action: 'approve' | 'reject' | 'abstain' | 'needs-info'
  score?: number          // 0-10 评分（评估时用）
  reasoning: string
  synthesis?: string      // P1-1: 投票前必须先综合理解（文件路径、行号、具体发现）
  info?: string           // 补充信息
  suggestion?: string     // 建议的替代方案
  confidence: number      // 0-1，对自己判断的信心
  timestamp: Date
}

export interface DecisionContext {
  id: string
  type: 'keep-or-discard' | 'direction' | 'policy-change' | 'escalation' | 'goal-change' | 'emergency'
  description: string
  diff?: string           // 代码变更
  metrics?: Record<string, number>
  constraints?: string[]
  escalation?: { type: string; description: string; context: Record<string, unknown> }
  urgency: 'low' | 'medium' | 'high' | 'critical'
}

export interface DecisionResult {
  decision: string
  weightedScore: number
  votes: Vote[]
  humanOverride: boolean   // 人是否推翻了 AI 共识
  reasoning: string
}

// 默认决策者配置
const DEFAULT_VOTERS: Voter[] = [
  {
    id: 'human',
    name: process.env.AUTOPILOT_USER_NAME ?? 'Human',
    type: 'human',
    weight: 3.0,          // 人的权重是 AI 的 3 倍
    trustScore: 1.0,       // 人的信任分不衰减
    capabilities: ['direction', 'context', 'business-logic', 'final-call'],
  },
  {
    id: 'cc',
    name: 'Claude Code',
    type: 'agent',
    provider: 'claude',
    weight: 1.0,
    trustScore: 0.85,
    capabilities: ['code-quality', 'architecture', 'security', 'implementation'],
  },
  {
    id: 'codex',
    name: 'Codex',
    type: 'agent',
    provider: 'codex',
    weight: 1.0,
    trustScore: 0.80,
    capabilities: ['code-review', 'alternative-approaches', 'edge-cases', 'devil-advocate'],
  },
  {
    id: 'openclaw',
    name: 'OpenClaw (Gemini)',
    type: 'agent',
    provider: 'openclaw',
    weight: 0.5,
    trustScore: 0.75,
    capabilities: ['engineering', 'performance', 'scalability', 'background-tasks'],
  },
]

let voters: Voter[] = [...DEFAULT_VOTERS]

/**
 * 注册/更新决策者
 */
export function registerVoter(voter: Voter): void {
  const existing = voters.findIndex(v => v.id === voter.id)
  if (existing >= 0) {
    voters[existing] = voter
  } else {
    voters.push(voter)
  }
}

export function getVoters(): Voter[] {
  return [...voters]
}

/**
 * 综合投票 — 加权决策
 *
 * 决策逻辑：
 * 1. 每个投票者的分数 × 权重 × 信任分 × 信心 = 加权分
 * 2. 所有加权分求和 → 最终得分
 * 3. 人的投票有特殊规则：
 *    - 人投 reject → 直接否决（veto power）
 *    - 人投 approve → 即使 AI 全反对也通过
 *    - 人 abstain → 按 AI 投票决定
 */
export function resolveVotes(
  context: DecisionContext,
  votes: Vote[],
  requireSynthesis: boolean = false,
): DecisionResult {
  // P1-1: 如果要求 synthesis，拒绝没有 synthesis 的 AI 投票
  if (requireSynthesis) {
    for (const vote of votes) {
      const voter = voters.find(v => v.id === vote.voterId)
      if (voter?.type === 'agent' && vote.action !== 'abstain' && !vote.synthesis?.trim()) {
        return {
          decision: 'needs-info',
          weightedScore: 0,
          votes,
          humanOverride: false,
          reasoning: `Vote from "${voter.name}" rejected: missing synthesis. You must summarize your understanding before voting. Never write "based on the findings" — prove you understood.`,
        }
      }
    }
  }

  // 找人的投票
  const humanVote = votes.find(v => {
    const voter = voters.find(vt => vt.id === v.voterId)
    return voter?.type === 'human'
  })

  // 人的否决权
  if (humanVote?.action === 'reject') {
    return {
      decision: 'reject',
      weightedScore: 0,
      votes,
      humanOverride: true,
      reasoning: `Human veto: ${humanVote.reasoning}`,
    }
  }

  // 人的通过权
  if (humanVote?.action === 'approve') {
    const aiDissenters = votes.filter(v => {
      const voter = voters.find(vt => vt.id === v.voterId)
      return voter?.type === 'agent' && v.action === 'reject'
    })

    return {
      decision: 'approve',
      weightedScore: humanVote.score ?? 10,
      votes,
      humanOverride: aiDissenters.length > 0,
      reasoning: aiDissenters.length > 0
        ? `Human approved despite ${aiDissenters.length} AI dissent(s): ${humanVote.reasoning}`
        : `Human approved: ${humanVote.reasoning}`,
    }
  }

  // 人 abstain 或没投票 → 加权计算
  let totalWeightedScore = 0
  let totalWeight = 0
  let approveWeight = 0
  let rejectWeight = 0

  for (const vote of votes) {
    const voter = voters.find(v => v.id === vote.voterId)
    if (!voter || vote.action === 'abstain' || vote.action === 'needs-info') continue

    const effectiveWeight = voter.weight * voter.trustScore * vote.confidence
    totalWeight += effectiveWeight

    if (vote.action === 'approve') {
      approveWeight += effectiveWeight
      totalWeightedScore += (vote.score ?? 7) * effectiveWeight
    } else if (vote.action === 'reject') {
      rejectWeight += effectiveWeight
      totalWeightedScore += (vote.score ?? 3) * effectiveWeight
    }
  }

  const avgScore = totalWeight > 0 ? totalWeightedScore / totalWeight : 5

  // All abstain → default to approve (continue), not reject (stop)
  // Rationale: stopping requires an explicit reject vote, silence = continue
  const decision = totalWeight === 0 ? 'approve'
    : approveWeight >= rejectWeight ? 'approve' : 'reject'

  // 有人要求补充信息 → 暂停
  const needsInfo = votes.filter(v => v.action === 'needs-info')
  if (needsInfo.length > 0) {
    return {
      decision: 'needs-info',
      weightedScore: avgScore,
      votes,
      humanOverride: false,
      reasoning: `Info needed: ${needsInfo.map(v => v.info).join('; ')}`,
    }
  }

  return {
    decision,
    weightedScore: Number(avgScore.toFixed(2)),
    votes,
    humanOverride: false,
    reasoning: `Weighted vote: approve=${approveWeight.toFixed(1)} vs reject=${rejectWeight.toFixed(1)}`,
  }
}

/**
 * 信任分自动调整
 *
 * 每次决策结果出来后，回溯看谁投对了：
 * - 投对了 → trustScore += 0.01（最高 1.0）
 * - 投错了 → trustScore -= 0.02（最低 0.3）
 *
 * 人的信任分不变（永远 1.0）
 * AI 的信任分会随时间反映它的判断质量
 */
export function updateTrustScores(
  votes: Vote[],
  actualOutcome: 'good' | 'bad',
): void {
  for (const vote of votes) {
    const voter = voters.find(v => v.id === vote.voterId)
    if (!voter || voter.type === 'human') continue  // 人的信任分不动

    const wasRight =
      (actualOutcome === 'good' && vote.action === 'approve') ||
      (actualOutcome === 'bad' && vote.action === 'reject')

    if (wasRight) {
      voter.trustScore = Math.min(1.0, voter.trustScore + 0.01)
    } else {
      voter.trustScore = Math.max(0.3, voter.trustScore - 0.02)
    }
  }
}

/**
 * 生成投票请求 prompt — 给 AI agent 用
 */
export function buildVotePrompt(context: DecisionContext): string {
  let prompt = `You are a voting member of the autopilot decision council.

Decision type: ${context.type}
Urgency: ${context.urgency}
Description: ${context.description}
`

  if (context.diff) {
    prompt += `\nCode diff:\n\`\`\`\n${context.diff}\n\`\`\`\n`
  }

  if (context.metrics) {
    prompt += `\nMetrics:\n${Object.entries(context.metrics).map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n`
  }

  prompt += `
## BEFORE YOU VOTE — SYNTHESIZE FIRST

You MUST first summarize what you understood. Include specific:
- File paths and line numbers
- What changed and why
- Key findings or concerns

NEVER write "based on the findings" or "looks good overall" — that's lazy delegation.
Prove you read and understood by citing specifics.

## Your Vote (REQUIRED — you MUST choose one, no abstaining)
1. APPROVE — this change/direction is good
2. REJECT — this is bad, explain why and suggest alternatives
3. NEEDS-INFO — you can't decide without more information

You are NOT allowed to abstain. Pick one of the three options above.

Output JSON:
{
  "synthesis": "REQUIRED: your understanding of the situation with specific details",
  "action": "approve|reject|needs-info",
  "score": 0-10,
  "confidence": 0-1,
  "reasoning": "why this vote",
  "suggestion": "alternative if rejecting",
  "info": "what you need if needs-info"
}
`

  return prompt
}

/**
 * 处理 escalation — 执行者上报的问题，议会投票决定 policy
 *
 * 这是 council 和 selfProgram 的桥梁：
 *   executor escalate → council 投票 → 结果转成 policy 变更
 */
export function buildEscalationContext(
  escalation: { type: string; description: string; context: Record<string, unknown> },
  currentPolicy: string,
  roundsCompleted: number,
): DecisionContext {
  return {
    id: `esc-decision-${Date.now()}`,
    type: 'escalation',
    description: `[${escalation.type}] ${escalation.description}\n\nCurrent policy: ${currentPolicy} (${roundsCompleted} rounds completed)`,
    escalation,
    urgency: escalation.type === 'policy-expired' ? 'medium' : 'high',
  }
}

/**
 * 生成 Telegram 投票卡片 — 给人用
 */
export function buildTelegramVoteMessage(context: DecisionContext): string {
  let msg = `🗳 **Decision Required**\n\n`
  msg += `Type: ${context.type}\n`
  msg += `Urgency: ${context.urgency}\n`
  msg += `\n${context.description}\n`

  if (context.metrics) {
    msg += `\nMetrics:\n`
    for (const [k, v] of Object.entries(context.metrics)) {
      msg += `  ${k}: ${v}\n`
    }
  }

  msg += `\nReply:\n`
  msg += `/vote approve <reason>\n`
  msg += `/vote reject <reason>\n`
  msg += `/vote info <what you need>\n`
  msg += `\nOr just ignore — AI council will decide in 5 min.`

  return msg
}

/**
 * 生成 policy 变更投票 prompt — escalation 场景用
 *
 * 和普通投票不同：这里要求投票者选择下一个 policy，不只是 approve/reject
 */
export function buildPolicyVotePrompt(
  escalation: { type: string; description: string; context: Record<string, unknown> },
  currentPolicy: string,
  policyHistory: string[],
): string {
  return `You are a voting member of the autopilot decision council.

The executor has escalated a decision to the council.

## Escalation
Type: ${escalation.type}
Description: ${escalation.description}
Context: ${JSON.stringify(escalation.context, null, 2)}

## Current Policy: ${currentPolicy}
## Policy History: ${policyHistory.join(' → ') || 'None'}

## Available Policies
- research — read-only, gather information, report back
- analyze — analyze existing data, find patterns, no new experiments
- explore — try different approaches, bold experiments
- exploit — refine current best approach, small iterations
- consolidate — clean up, simplify, finalize

## Your Vote
Choose the next policy and explain why.

Output JSON:
{
  "policy": "research|analyze|explore|exploit|consolidate",
  "reasoning": "why this policy now",
  "instructions": "optional specific instructions for the executor",
  "maxRounds": 10,
  "confidence": 0.8
}
`
}

/**
 * Telegram policy 投票卡片
 */
export function buildTelegramPolicyMessage(
  escalation: { type: string; description: string },
  currentPolicy: string,
): string {
  let msg = `⚡ **Policy Decision Required**\n\n`
  msg += `Escalation: [${escalation.type}] ${escalation.description}\n`
  msg += `Current policy: ${currentPolicy}\n\n`
  msg += `Reply with one of:\n`
  msg += `/policy research — 先调研\n`
  msg += `/policy analyze — 分析数据\n`
  msg += `/policy explore — 试新方向\n`
  msg += `/policy exploit — 精炼当前\n`
  msg += `/policy consolidate — 收尾\n`
  msg += `\nOr ignore — AI council decides in 5 min.`
  return msg
}
