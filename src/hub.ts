/**
 * Worker Hub — Continue vs Spawn 决策
 *
 * P2-1: 学习 CC Coordinator 的决策表：
 *   什么时候复用现有 worker（continue），什么时候起新的（spawn fresh）
 *
 * 核心问题：context overlap
 *   - 重叠高 → continue（避免重复工作）
 *   - 重叠低或方向错 → spawn（新鲜视角）
 */

// ============================================================
// Types
// ============================================================

export interface Worker {
  id: string
  name: string
  provider: 'claude' | 'codex' | 'openclaw'
  status: 'idle' | 'working' | 'stuck' | 'done' | 'failed'
  currentTaskId?: string
  contextFiles: string[]       // 这个 worker 已经读过/研究过的文件
  contextSummary?: string      // worker 当前理解的概要
  errorHistory: string[]       // 最近遇到的错误
  roundsCompleted: number
  createdAt: Date
}

export type SpawnDecision = 'continue' | 'spawn-fresh'

export interface SpawnReason {
  decision: SpawnDecision
  reason: string
  confidence: number   // 0-1
}

export interface SpawnContext {
  taskFiles: string[]          // 新任务涉及的文件
  taskType: 'research' | 'implement' | 'fix' | 'verify' | 'refactor'
  previousOutcome?: 'success' | 'failure' | 'wrong-direction' | 'partial'
  isVerification: boolean      // 是否是验证别人代码的任务
}

// ============================================================
// Worker Store
// ============================================================

let workers: Worker[] = []

export function registerWorker(worker: Worker): void {
  const existing = workers.findIndex(w => w.id === worker.id)
  if (existing >= 0) {
    workers[existing] = worker
  } else {
    workers.push(worker)
  }
}

export function getWorker(id: string): Worker | undefined {
  return workers.find(w => w.id === id)
}

export function getIdleWorkers(): Worker[] {
  return workers.filter(w => w.status === 'idle')
}

export function getAllWorkers(): Worker[] {
  return [...workers]
}

// ============================================================
// P2-1: Continue vs Spawn 决策表
//
// CC Coordinator 的决策逻辑：
//   1. 研究了要改的文件 → continue（context 重叠高）
//   2. 研究范围广但实现范围窄 → spawn fresh（避免噪音）
//   3. 修正失败 → continue（有错误上下文）
//   4. 验证别人写的代码 → spawn fresh（新鲜视角）
//   5. 完全错误的方向 → spawn fresh（避免锚定）
// ============================================================

/**
 * 计算 context overlap — 新任务和 worker 已有上下文的重叠度
 */
export function contextOverlap(worker: Worker, taskFiles: string[]): number {
  if (worker.contextFiles.length === 0 || taskFiles.length === 0) return 0

  const workerSet = new Set(worker.contextFiles)
  const overlap = taskFiles.filter(f => workerSet.has(f)).length

  // 双向重叠：既看 taskFiles 的覆盖率，也看 worker context 的相关度
  const taskCoverage = overlap / taskFiles.length
  const contextRelevance = overlap / worker.contextFiles.length

  // 取几何平均，兼顾两边
  return Math.sqrt(taskCoverage * contextRelevance)
}

/**
 * P2-1 核心：决定是复用 worker 还是起新的
 *
 * 决策表（按优先级排序）：
 *
 * | 条件                           | 决策        | 原因              |
 * |-------------------------------|-------------|------------------|
 * | 验证别人代码                    | spawn fresh | 新鲜视角，避免偏见  |
 * | 上次完全错误方向                 | spawn fresh | 避免锚定效应       |
 * | 上次失败 + 有错误上下文          | continue    | 有调试线索         |
 * | context overlap > 0.6          | continue    | 重叠高，复用知识    |
 * | 研究范围广但任务窄              | spawn fresh | 避免信息噪音       |
 * | context overlap < 0.2          | spawn fresh | 重叠低，无复用价值  |
 * | 默认                          | continue    | 保守策略           |
 */
export function shouldContinueOrSpawn(
  worker: Worker,
  context: SpawnContext,
): SpawnReason {

  // Rule 1: 验证任务 → 一定要新鲜视角
  if (context.isVerification) {
    return {
      decision: 'spawn-fresh',
      reason: 'Verification requires fresh perspective — avoid confirming your own bias.',
      confidence: 0.95,
    }
  }

  // Rule 2: 上次完全走错方向 → 新鲜开始，避免锚定
  if (context.previousOutcome === 'wrong-direction') {
    return {
      decision: 'spawn-fresh',
      reason: 'Previous approach was fundamentally wrong — fresh start avoids anchoring bias.',
      confidence: 0.9,
    }
  }

  // Rule 3: 上次失败但有错误上下文 → 继续，有调试线索
  if (context.previousOutcome === 'failure' && worker.errorHistory.length > 0) {
    return {
      decision: 'continue',
      reason: `Worker has error context from ${worker.errorHistory.length} previous error(s) — useful for debugging.`,
      confidence: 0.85,
    }
  }

  // Rule 4-6: 基于 context overlap 决策
  const overlap = contextOverlap(worker, context.taskFiles)

  // 高重叠 → 复用
  if (overlap > 0.6) {
    return {
      decision: 'continue',
      reason: `High context overlap (${(overlap * 100).toFixed(0)}%) — worker already understands the relevant code.`,
      confidence: 0.8,
    }
  }

  // 研究范围广但实现范围窄：worker 读了很多文件，但新任务只改少数几个
  if (worker.contextFiles.length > 10 && context.taskFiles.length <= 3 && overlap < 0.3) {
    return {
      decision: 'spawn-fresh',
      reason: `Broad research context (${worker.contextFiles.length} files) but narrow implementation (${context.taskFiles.length} files) — spawn to avoid noise.`,
      confidence: 0.75,
    }
  }

  // 低重叠 → 新起
  if (overlap < 0.2) {
    return {
      decision: 'spawn-fresh',
      reason: `Low context overlap (${(overlap * 100).toFixed(0)}%) — no reuse value, fresh start is better.`,
      confidence: 0.7,
    }
  }

  // 默认: 中等重叠 → 继续（保守策略，复用比浪费好）
  return {
    decision: 'continue',
    reason: `Moderate context overlap (${(overlap * 100).toFixed(0)}%) — continuing is the safer default.`,
    confidence: 0.6,
  }
}

/**
 * 选择最佳 worker — 从空闲 worker 中挑最合适的
 *
 * 如果没有合适的（全部 spawn-fresh），返回 null 表示应该新建。
 */
export function selectWorker(
  context: SpawnContext,
): { worker: Worker; reason: SpawnReason } | null {
  const idle = getIdleWorkers()
  if (idle.length === 0) return null

  let bestWorker: Worker | null = null
  let bestReason: SpawnReason | null = null
  let bestOverlap = -1

  for (const worker of idle) {
    const reason = shouldContinueOrSpawn(worker, context)
    if (reason.decision === 'continue') {
      const overlap = contextOverlap(worker, context.taskFiles)
      if (overlap > bestOverlap) {
        bestWorker = worker
        bestReason = reason
        bestOverlap = overlap
      }
    }
  }

  if (bestWorker && bestReason) {
    return { worker: bestWorker, reason: bestReason }
  }

  return null  // 没有适合的 → 新建
}

/**
 * 重置 workers（测试用）
 */
export function _resetWorkers(): void {
  workers = []
}
