/**
 * 核心循环引擎 — 执行者只执行，不决策
 *
 * 流程：
 *   1. 读取当前 policy
 *   2. 按 policy 执行一轮
 *   3. 收集 metrics
 *   4. 检查 constraints
 *   5. scoreExperiment（纯计算）
 *   6. tickRound（检查是否需要 escalate）
 *   7. 如果 shouldEscalate → 停下来，等议会决策
 *   8. 如果不需要 escalate → judge keep/discard → record → 下一轮
 *
 * 执行者不做的事：
 * - 不判断该用什么策略
 * - 不决定"够了"还是"继续"
 * - 不自己切换方向
 * - 遇到不确定 → escalate
 */

import type { SelfProgram, Metric, Constraint, BlockerAnalysis, Escalation } from './selfProgram.js'
import { tickRound, scoreExperiment, escalate, validateBlockerAnalysis } from './selfProgram.js'
import { gate, type Tool } from './toolGate.js'

export interface LoopConfig {
  program: SelfProgram
  /** 执行一轮的函数 — 外部注入 */
  execute: (instructions: string, round: number) => Promise<string>
  /** 提取 metrics 的函数 */
  extractMetrics: (metrics: Metric[]) => Promise<Record<string, number>>
  /** 检查 constraints 的函数 */
  checkConstraints: (constraints: Constraint[]) => Promise<Record<string, boolean>>
  /** keep 当前结果 */
  onKeep: (round: number, score: number, details: string[]) => Promise<void>
  /** discard 当前结果 */
  onDiscard: (round: number, reason: string) => Promise<void>
  /** escalate 给议会 */
  onEscalate: (escalation: { type: string; description: string; context: Record<string, unknown>; analysis?: BlockerAnalysis }) => Promise<void>
  /**
   * 遇到阻挡时的分析函数 — 必须返回结构化分析
   *
   * 原则："先分析问题，再去解决"
   * 当执行失败/出错时，loop 会调用这个函数要求分析。
   * 分析结果决定：尝试修复 还是 escalate。
   */
  analyzeBlocker?: (error: string, round: number) => Promise<BlockerAnalysis>
  /** 尝试修复阻挡问题 — 基于分析结果执行修复 */
  attemptFix?: (analysis: BlockerAnalysis, round: number) => Promise<{ fixed: boolean; output: string }>
  /** 每轮结束后的通知 */
  onRoundEnd?: (round: number, status: string) => Promise<void>
  /** 最优记录 */
  bestMetrics?: Record<string, number>
  /** 最大连续失败次数（超过后 escalate，默认 3）*/
  maxConsecutiveFailures?: number
}

export interface LoopResult {
  rounds: number
  kept: number
  discarded: number
  escalated: boolean
  escalationReason?: string
}

/**
 * 运行循环 — 按 policy 执行直到 escalate 或被外部停止
 *
 * 注意：这个函数会在 escalate 时返回，不会自己继续。
 * 议会决策后需要外部重新调用 runLoop。
 */
export async function runLoop(config: LoopConfig): Promise<LoopResult> {
  const { program } = config
  const policy = program.currentPolicy
  let kept = 0
  let discarded = 0
  let round = program.roundsOnCurrentPolicy
  let consecutiveFailures = 0
  const maxFailures = config.maxConsecutiveFailures ?? 3

  while (true) {
    round++

    // 0. P0-1: 工具门禁检查 — executor 只能用 policy 允许的工具
    const toolCheck = gate({
      tool: 'bash' as Tool,
      policy: policy.type,
      role: 'executor',
      callerId: 'loop-executor',
    })
    // gate 检查在这里是预检。实际的逐命令检查在 execute 内部做。

    // 1. 按 policy 执行 — 出错时走"先分析再解决"流程
    let output: string
    try {
      output = await config.execute(policy.instructions, round)
      consecutiveFailures = 0  // 成功了，重置计数
    } catch (execError: any) {
      consecutiveFailures++
      const errorMsg = execError?.message ?? String(execError)

      // ── 先分析问题 ──
      if (config.analyzeBlocker) {
        const analysis = await config.analyzeBlocker(errorMsg, round)
        const validation = validateBlockerAnalysis(analysis)

        if (validation.valid && analysis.chosen && config.attemptFix) {
          // 分析合格 + 有选定方案 → 尝试修复
          const fixResult = await config.attemptFix(analysis, round)

          if (fixResult.fixed) {
            // 修复成功 → 继续循环
            consecutiveFailures = 0
            await config.onRoundEnd?.(round, `blocker fixed: ${analysis.chosen.approach}`)
            continue
          }

          // 修复失败 → 记录 attempt
          // 如果连续失败太多 → escalate（附带分析）
          if (consecutiveFailures >= maxFailures) {
            const esc = escalate(program, 'blocked', errorMsg,
              [{ action: analysis.chosen.approach, result: fixResult.output }],
              { error: errorMsg, consecutiveFailures },
              analysis,
            )
            await config.onEscalate(esc)
            return {
              rounds: round, kept, discarded,
              escalated: true,
              escalationReason: `Blocked after ${consecutiveFailures} failures: ${errorMsg}`,
            }
          }

          // 还没到上限 → 下一轮继续
          await config.onRoundEnd?.(round, `fix attempt failed, retrying (${consecutiveFailures}/${maxFailures})`)
          continue
        }

        // 分析不合格 或 没有选定方案 → 直接 escalate
        const esc = escalate(program, 'blocked', errorMsg,
          [{ action: 'analyzed blocker', result: `analysis: ${analysis.what} / ${analysis.why}` }],
          { error: errorMsg, analysis },
          analysis,
        )
        await config.onEscalate(esc)
        return {
          rounds: round, kept, discarded,
          escalated: true,
          escalationReason: `Blocked (no viable fix): ${errorMsg}`,
        }
      }

      // 没有 analyzeBlocker 函数 → 连续失败达上限后 escalate
      if (consecutiveFailures >= maxFailures) {
        await config.onEscalate({
          type: 'blocked',
          description: `Execution failed ${consecutiveFailures} consecutive times: ${errorMsg}`,
          context: { error: errorMsg, consecutiveFailures },
        })
        return {
          rounds: round, kept, discarded,
          escalated: true,
          escalationReason: `${consecutiveFailures} consecutive failures: ${errorMsg}`,
        }
      }

      await config.onRoundEnd?.(round, `execution error (${consecutiveFailures}/${maxFailures}): ${errorMsg}`)
      continue
    }

    // 2. research/analyze — report only, no scoring or keep/discard
    if (policy.type === 'research' || policy.type === 'analyze') {
      // These policies produce reports, not experiments — always keep output
      const outputSummary = output.length > 500 ? output.slice(0, 500) + '...' : output
      await config.onKeep(round, 0, [`[${policy.type}] ${outputSummary}`])
      kept++

      // Still check maxRounds for escalation
      const tick = tickRound(program, {}, config.bestMetrics)
      if (tick.shouldEscalate && tick.escalation) {
        await config.onEscalate(tick.escalation)
        return {
          rounds: round, kept, discarded,
          escalated: true,
          escalationReason: tick.escalation.description,
        }
      }

      await config.onRoundEnd?.(round, `${policy.type} report collected`)
      continue
    }

    // 3. 收集 metrics
    let metricResults: Record<string, number> = {}
    if (policy.metrics.length > 0) {
      metricResults = await config.extractMetrics(policy.metrics)
    }

    // 4. 检查 constraints
    let constraintResults: Record<string, boolean> = {}
    if (policy.constraints.length > 0) {
      constraintResults = await config.checkConstraints(policy.constraints)
    }

    // 5. 评分（纯计算，不是决策）— skip if no metrics defined
    if (policy.metrics.length === 0) {
      // No metrics = no scoring. Keep output by default.
      const outputSummary = output.length > 500 ? output.slice(0, 500) + '...' : output
      await config.onKeep(round, 0, [`[no-metrics] ${outputSummary}`])
      kept++

      const tick = tickRound(program, {}, config.bestMetrics)
      if (tick.shouldEscalate && tick.escalation) {
        await config.onEscalate(tick.escalation)
        return {
          rounds: round, kept, discarded,
          escalated: true,
          escalationReason: tick.escalation.description,
        }
      }

      await config.onRoundEnd?.(round, 'kept (no metrics)')
      continue
    }

    const score = scoreExperiment(
      policy.metrics,
      policy.constraints,
      metricResults,
      constraintResults,
    )

    // 6. hard constraint 违反 → 直接 discard（这是规则，不是决策）
    if (score.hardFail) {
      await config.onDiscard(round, `Hard constraint violated: ${score.details.filter(d => d.includes('HARD FAIL')).join(', ')}`)
      discarded++
      await config.onRoundEnd?.(round, 'discarded (hard fail)')
      continue
    }

    // 7. 检查是否需要 escalate
    const tick = tickRound(program, metricResults, config.bestMetrics)

    if (tick.shouldEscalate && tick.escalation) {
      await config.onEscalate(tick.escalation)
      return {
        rounds: round,
        kept,
        discarded,
        escalated: true,
        escalationReason: tick.escalation.description,
      }
    }

    // 8. 没有 escalate → keep/discard 基于分数
    const finalScore = score.weightedScore - score.softPenalty
    const isBetter = !config.bestMetrics || finalScore > 0

    if (isBetter) {
      const outputSnippet = output.length > 300 ? output.slice(0, 300) + '...' : output
      await config.onKeep(round, finalScore, [...score.details, `[output] ${outputSnippet}`])
      config.bestMetrics = { ...metricResults }
      kept++
      await config.onRoundEnd?.(round, `kept (score: ${finalScore.toFixed(2)})`)
    } else {
      await config.onDiscard(round, `Score ${finalScore.toFixed(2)} not better than baseline`)
      discarded++
      await config.onRoundEnd?.(round, `discarded (score: ${finalScore.toFixed(2)})`)
    }
  }
}
