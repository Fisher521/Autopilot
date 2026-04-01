/**
 * 任务系统 — 生成 → 拆解 → 执行 → checklist → 评估
 *
 * 核心原则（和 policy 一致）：
 *   - 任务生成和拆解：议会定，执行者不自己拆
 *   - checklist：议会定，执行者不自己跳过
 *   - 评估：议会做，执行者只汇报结果
 *   - 执行者唯一能做的"决策"：escalate
 *
 * 生命周期：
 *   goal → generate tasks → council approves
 *     → decompose task → council approves subtasks
 *       → executor runs subtask → checklist verify
 *         → council evaluates → next task / rework / pivot
 */

// ============================================================
// Types
// ============================================================

export type TaskStatus =
  | 'draft'          // 刚生成，等议会审批
  | 'approved'       // 议会通过，可以拆解
  | 'decomposed'     // 已拆解成 subtasks
  | 'in-progress'    // 执行中
  | 'checking'       // checklist 验证中
  | 'evaluating'     // 议会评估中
  | 'done'           // 完成
  | 'rework'         // 议会要求返工
  | 'dropped'        // 议会放弃

export type TaskType = 'frontend' | 'backend' | 'cli' | 'infra' | 'bugfix' | 'refactor' | 'data' | 'other'

export interface Task {
  id: string
  title: string
  description: string
  taskType?: TaskType        // P1-2: 任务类型，决定附加哪些对抗性探测
  status: TaskStatus
  parentId?: string          // 如果是 subtask，指向父任务
  subtasks: Task[]
  checklist: CheckItem[]
  evaluation?: Evaluation
  createdBy: string          // 'council' | 'human' | voter id
  assignedTo?: string        // executor id
  priority: 'p0' | 'p1' | 'p2' | 'p3'
  blocks: string[]           // P1-3: 这个任务完成后才能开始的任务 IDs
  blockedBy: string[]        // P1-3: 这个任务依赖的任务 IDs
  verified: boolean          // P1-4: 是否经过独立验证
  createdAt: Date
  updatedAt: Date
  context: Record<string, unknown>
}

export interface CheckItem {
  id: string
  description: string
  checkCommand?: string      // 自动验证命令（exit 0 = pass）
  type: 'auto' | 'manual'   // auto = 命令验证，manual = 需要人/议会确认
  required: boolean          // 必须通过才算完成
  passed?: boolean
  verdict?: CheckVerdict     // P2-3: 三档判定 — pass/fail/partial
  partialReason?: string     // P2-3: partial 的原因（只能是环境限制）
  checkedAt?: Date
  checkedBy?: string         // 谁验证的
  evidence?: CheckEvidence   // P0-4: 必须附命令输出证据
}

/**
 * P0-4: 验证证据 — "A check without a Command run block is not a PASS"
 *
 * 每个 auto check 必须记录：跑了什么命令、实际输出、退出码。
 * 没有证据的 PASS 不算 PASS。
 */
export interface CheckEvidence {
  command: string        // 跑了什么命令
  output: string         // 实际输出（copy-paste，不是 paraphrase）
  exitCode: number       // 退出码
  timestamp: Date
}

/**
 * P2-3: CheckVerdict — PASS/FAIL 之外加 PARTIAL
 *
 * PARTIAL 仅用于环境限制（没有测试框架、工具不可用、服务起不来）。
 * 不是"我不确定"，是"客观上跑不了这个检查"。
 */
export type CheckVerdict = 'pass' | 'fail' | 'partial'

export interface Evaluation {
  score: number              // 0-10
  verdict: 'accept' | 'rework' | 'drop'
  feedback: string
  reworkInstructions?: string  // 如果 rework，具体改什么
  evaluatedBy: string        // 'council' | voter id
  evaluatedAt: Date
  metrics?: Record<string, number>  // 量化评估
}

/**
 * TaskPlan — 任务拆解方案（需要议会审批）
 */
export interface TaskPlan {
  taskId: string
  subtasks: Array<{
    title: string
    description: string
    checklist: Array<{
      description: string
      checkCommand?: string
      type: 'auto' | 'manual'
      required: boolean
    }>
    priority: 'p0' | 'p1' | 'p2' | 'p3'
    estimatedRounds?: number
  }>
  reasoning: string
  proposedBy: string
}

// ============================================================
// Task Store
// ============================================================

let tasks: Task[] = []

export function getAllTasks(): Task[] {
  return [...tasks]
}

export function getTask(id: string): Task | undefined {
  return findTaskDeep(tasks, id)
}

function findTaskDeep(list: Task[], id: string): Task | undefined {
  for (const t of list) {
    if (t.id === id) return t
    const found = findTaskDeep(t.subtasks, id)
    if (found) return found
  }
  return undefined
}

export function getActiveTasks(): Task[] {
  return tasks.filter(t =>
    t.status !== 'done' && t.status !== 'dropped'
  )
}

// ============================================================
// Task Generation — 从目标生成任务（议会用）
// ============================================================

/**
 * 生成任务 — 状态为 draft，需要议会审批
 *
 * 只有议会或人可以调用。执行者不能自己生成任务。
 */
export function createTask(
  title: string,
  description: string,
  createdBy: string,
  options?: {
    priority?: Task['priority']
    parentId?: string
    context?: Record<string, unknown>
    taskType?: TaskType
    blockedBy?: string[]
  },
): Task {
  const task: Task = {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title,
    description,
    taskType: options?.taskType,
    status: 'draft',
    parentId: options?.parentId,
    subtasks: [],
    checklist: [],
    createdBy,
    priority: options?.priority ?? 'p1',
    blocks: [],
    blockedBy: options?.blockedBy ?? [],
    verified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    context: options?.context ?? {},
  }

  if (options?.parentId) {
    const parent = findTaskDeep(tasks, options.parentId)
    if (parent) {
      parent.subtasks.push(task)
    }
  } else {
    tasks.push(task)
  }

  return task
}

/**
 * 议会审批任务
 */
export function approveTask(taskId: string): void {
  const task = getTask(taskId)
  if (task && task.status === 'draft') {
    task.status = 'approved'
    task.updatedAt = new Date()
  }
}

export function dropTask(taskId: string, reason: string): void {
  const task = getTask(taskId)
  if (task) {
    task.status = 'dropped'
    task.updatedAt = new Date()
    task.evaluation = {
      score: 0,
      verdict: 'drop',
      feedback: reason,
      evaluatedBy: 'council',
      evaluatedAt: new Date(),
    }
  }
}

// ============================================================
// Task Decomposition — 拆解任务（议会审批）
// ============================================================

/**
 * 应用拆解方案 — 把 TaskPlan 的 subtasks 挂到父任务上
 *
 * 拆解方案由 AI 提出，但必须经议会投票通过才能 apply。
 */
export function applyTaskPlan(plan: TaskPlan): Task[] {
  const parent = getTask(plan.taskId)
  if (!parent) throw new Error(`Task ${plan.taskId} not found`)

  const created: Task[] = []

  for (const sub of plan.subtasks) {
    const checklist: CheckItem[] = sub.checklist.map((c, i) => ({
      id: `check-${Date.now()}-${i}`,
      description: c.description,
      checkCommand: c.checkCommand,
      type: c.type,
      required: c.required,
    }))

    const subtask = createTask(sub.title, sub.description, plan.proposedBy, {
      priority: sub.priority,
      parentId: parent.id,
    })

    subtask.checklist = checklist
    subtask.status = 'approved'  // 拆解方案已通过议会，subtask 自动 approved
    created.push(subtask)
  }

  parent.status = 'decomposed'
  parent.updatedAt = new Date()

  return created
}

// ============================================================
// Task Execution — 执行者用
// ============================================================

/**
 * 开始执行任务
 */
export function startTask(taskId: string, executorId: string): void {
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)
  if (task.status !== 'approved') {
    throw new Error(`Task ${taskId} is ${task.status}, not approved. Cannot start.`)
  }

  // P1-3: 检查依赖 — blockedBy 的任务必须全部 done
  for (const depId of task.blockedBy) {
    const dep = getTask(depId)
    if (dep && dep.status !== 'done') {
      throw new Error(
        `Task "${task.title}" is blocked by "${dep.title}" (status: ${dep.status}). ` +
        `Complete blocking tasks first.`
      )
    }
  }

  task.status = 'in-progress'
  task.assignedTo = executorId
  task.updatedAt = new Date()
}

/**
 * P1-3: 添加任务依赖
 */
export function addDependency(taskId: string, blockedById: string): void {
  const task = getTask(taskId)
  const blocker = getTask(blockedById)
  if (!task || !blocker) throw new Error('Task not found')

  if (!task.blockedBy.includes(blockedById)) {
    task.blockedBy.push(blockedById)
  }
  if (!blocker.blocks.includes(taskId)) {
    blocker.blocks.push(taskId)
  }
}

/**
 * 执行者完成执行，进入 checklist 验证
 */
export function submitForChecking(taskId: string): void {
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  task.status = 'checking'
  task.updatedAt = new Date()
}

// ============================================================
// Checklist — 执行者不能跳过，不能自己标 pass
// ============================================================

/**
 * 运行 auto checklist items — P0-4: 必须收集证据
 *
 * auto 类型的 check 必须记录命令输出作为证据。
 * 没有证据的 PASS 不算 PASS（CC 原则）。
 * manual 类型的必须等议会或人确认。
 */
export async function runChecklist(
  taskId: string,
  executeCheck: (command: string) => Promise<{ passed: boolean; output: string; exitCode: number }>,
): Promise<{ allPassed: boolean; results: Array<{ item: string; passed: boolean; verdict?: CheckVerdict; type: string; evidence?: CheckEvidence }> }> {

  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  const results: Array<{ item: string; passed: boolean; verdict?: CheckVerdict; type: string; evidence?: CheckEvidence }> = []

  for (const item of task.checklist) {
    // P2-3: 已经标记为 partial 的跳过自动执行
    if (item.verdict === 'partial') {
      results.push({ item: item.description, passed: false, verdict: 'partial', type: `partial (${item.partialReason ?? 'env limitation'})` })
      continue
    }

    if (item.type === 'auto' && item.checkCommand) {
      const result = await executeCheck(item.checkCommand)

      // P0-4: 记录证据
      const evidence: CheckEvidence = {
        command: item.checkCommand,
        output: result.output,
        exitCode: result.exitCode,
        timestamp: new Date(),
      }

      // P0-4: 验证证据有效性
      if (!result.output.trim()) {
        // 空输出 — 标记为 skip，不算 pass
        item.passed = false
        item.verdict = 'fail'
        item.evidence = evidence
        item.checkedAt = new Date()
        item.checkedBy = 'auto (no evidence)'
        results.push({ item: item.description, passed: false, verdict: 'fail', type: 'auto (empty output — not verified)', evidence })
      } else {
        item.passed = result.passed
        item.verdict = result.passed ? 'pass' : 'fail'
        item.evidence = evidence
        item.checkedAt = new Date()
        item.checkedBy = 'auto'
        results.push({ item: item.description, passed: result.passed, verdict: item.verdict, type: 'auto', evidence })
      }
    } else {
      // manual items — 还没验证
      results.push({
        item: item.description,
        passed: item.passed ?? false,
        verdict: item.verdict,
        type: 'manual (pending)',
      })
    }
  }

  // P2-3: allPassed 考虑 partial — partial 的 required 项不阻塞通过
  const allPassed = task.checklist
    .filter(c => c.required && c.verdict !== 'partial')
    .every(c => c.passed === true)

  return { allPassed, results }
}

/**
 * P2-3: 标记 check item 为 PARTIAL
 *
 * PARTIAL 仅用于环境限制，不是"我不确定"。
 * 合法原因：没有测试框架、工具不可用、服务起不来、CI 环境缺少依赖。
 */
export function markCheckPartial(
  taskId: string,
  checkItemId: string,
  reason: string,
  checkedBy: string,
): void {
  const VALID_PARTIAL_KEYWORDS = [
    'no test framework', 'tool not available', 'service unavailable',
    'environment', 'CI', 'missing dependency', 'cannot install',
    'no access', 'permission denied', 'port in use', 'not installed',
  ]

  const hasValidReason = VALID_PARTIAL_KEYWORDS.some(kw =>
    reason.toLowerCase().includes(kw.toLowerCase())
  )

  if (!hasValidReason) {
    throw new Error(
      `PARTIAL rejected: "${reason}" does not describe an environmental limitation. ` +
      `PARTIAL is for: ${VALID_PARTIAL_KEYWORDS.join(', ')}. ` +
      `If you're unsure, the check is a FAIL, not a PARTIAL.`
    )
  }

  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  const item = task.checklist.find(c => c.id === checkItemId)
  if (!item) throw new Error(`Check item ${checkItemId} not found`)

  item.verdict = 'partial'
  item.partialReason = reason
  item.passed = false  // partial 不算 passed
  item.checkedAt = new Date()
  item.checkedBy = checkedBy
}

/**
 * 手动标记 checklist item（议会或人用）
 */
export function markCheckItem(
  taskId: string,
  checkItemId: string,
  passed: boolean,
  checkedBy: string,
): void {
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  const item = task.checklist.find(c => c.id === checkItemId)
  if (!item) throw new Error(`Check item ${checkItemId} not found`)

  item.passed = passed
  item.checkedAt = new Date()
  item.checkedBy = checkedBy
}

/**
 * checklist 全部通过，提交给议会评估
 */
export function submitForEvaluation(taskId: string): void {
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  const requiredPassed = task.checklist
    .filter(c => c.required)
    .every(c => c.passed === true)

  if (!requiredPassed) {
    throw new Error(`Task ${taskId} has failing required check items. Cannot submit for evaluation.`)
  }

  task.status = 'evaluating'
  task.updatedAt = new Date()
}

// ============================================================
// Evaluation — 议会做，执行者只看结果
// ============================================================

/**
 * 议会评估任务结果
 *
 * P0-2: 只有 council/human 能评估。executor 不能给自己打分。
 *
 * 三种结果：
 * - accept → done
 * - rework → 回到 in-progress，附带返工指令
 * - drop → 放弃这个任务
 */
export function evaluateTask(
  taskId: string,
  evaluation: Evaluation,
  callerRole: 'council' | 'human' | 'executor' = 'council',
): void {
  if (callerRole === 'executor') {
    throw new Error('BLOCKED: Executor cannot evaluate its own work. Only council/human can.')
  }
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  task.evaluation = evaluation
  task.updatedAt = new Date()

  switch (evaluation.verdict) {
    case 'accept':
      task.status = 'done'
      break
    case 'rework':
      task.status = 'rework'
      break
    case 'drop':
      task.status = 'dropped'
      break
  }
}

/**
 * P1-4: 验证 Nudge — 连续完成 N 个任务没有独立验证 → 警告
 *
 * CC 原则：完成 3+ 任务但没有一个 verification → 自动提醒
 */
export function checkVerificationNudge(threshold: number = 3): {
  nudge: boolean
  unverifiedCount: number
  message?: string
} {
  const doneTasks = tasks.filter(t => t.status === 'done')
  const recentDone = doneTasks.slice(-threshold)

  if (recentDone.length < threshold) {
    return { nudge: false, unverifiedCount: 0 }
  }

  const unverified = recentDone.filter(t => !t.verified)
  if (unverified.length >= threshold) {
    return {
      nudge: true,
      unverifiedCount: unverified.length,
      message: `WARNING: Last ${unverified.length} completed tasks have no independent verification. ` +
        `Spawn a verification step before proceeding. Tasks: ${unverified.map(t => t.title).join(', ')}`,
    }
  }

  return { nudge: false, unverifiedCount: unverified.length }
}

/**
 * 标记任务已验证
 */
export function markVerified(taskId: string): void {
  const task = getTask(taskId)
  if (task) {
    task.verified = true
    task.updatedAt = new Date()
  }
}

/**
 * 执行者接受返工指令，重新开始
 */
export function startRework(taskId: string): void {
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)
  if (task.status !== 'rework') {
    throw new Error(`Task ${taskId} is ${task.status}, not rework.`)
  }

  // 重置 checklist
  for (const item of task.checklist) {
    item.passed = undefined
    item.checkedAt = undefined
    item.checkedBy = undefined
  }

  task.status = 'in-progress'
  task.updatedAt = new Date()
}

// ============================================================
// Prompt builders
// ============================================================

/**
 * 给 AI 的任务拆解 prompt
 */
export function buildDecomposePrompt(task: Task): string {
  return `# Task Decomposition

You are proposing a task breakdown for council approval.
You do NOT decide — you propose. Council votes.

## Task
Title: ${task.title}
Description: ${task.description}
Priority: ${task.priority}
Context: ${JSON.stringify(task.context, null, 2)}

## Requirements
1. Break into 2-7 subtasks (smaller is better)
2. Each subtask must have a clear checklist (what counts as "done")
3. Checklist items should be auto-verifiable when possible (provide shell commands)
4. Mark checks as required (must pass) or optional (nice to have)
5. Order subtasks by dependency — which must be done first?

## Output JSON
{
  "subtasks": [
    {
      "title": "...",
      "description": "...",
      "priority": "p0|p1|p2|p3",
      "checklist": [
        {
          "description": "what to check",
          "checkCommand": "shell command, exit 0 = pass",
          "type": "auto|manual",
          "required": true
        }
      ]
    }
  ],
  "reasoning": "why this breakdown"
}
`
}

/**
 * 给议会的评估 prompt
 */
export function buildEvaluationPrompt(task: Task): string {
  const checkResults = task.checklist.map(c => {
    const verdict = c.verdict === 'partial'
      ? 'PARTIAL'
      : c.passed ? 'PASS' : c.passed === false ? 'FAIL' : 'PENDING'
    const suffix = c.verdict === 'partial' ? ` — ${c.partialReason}` : ''
    return `- [${verdict}] ${c.description} (${c.type}${c.required ? ', required' : ''})${suffix}`
  }).join('\n')

  return `# Task Evaluation

You are evaluating whether this task was completed satisfactorily.

## Task
Title: ${task.title}
Description: ${task.description}

## Checklist Results
${checkResults}

## Your Evaluation
Rate 0-10 and choose a verdict:
- **accept** — task is done well, move on
- **rework** — not good enough, provide specific rework instructions
- **drop** — this task is no longer needed or approach is wrong

Output JSON:
{
  "score": 0-10,
  "verdict": "accept|rework|drop",
  "feedback": "what's good and what's not",
  "reworkInstructions": "if rework, what specifically to change",
  "metrics": { "optional_metric": 0.95 }
}
`
}

/**
 * Telegram 任务状态卡片
 */
export function buildTelegramTaskMessage(task: Task): string {
  const statusEmoji: Record<TaskStatus, string> = {
    'draft': '📝',
    'approved': '✅',
    'decomposed': '🔀',
    'in-progress': '🔄',
    'checking': '🔍',
    'evaluating': '⚖️',
    'done': '✅',
    'rework': '🔁',
    'dropped': '❌',
  }

  let msg = `${statusEmoji[task.status]} **${task.title}**\n`
  msg += `Status: ${task.status} | Priority: ${task.priority}\n`

  if (task.subtasks.length > 0) {
    msg += `\nSubtasks:\n`
    for (const sub of task.subtasks) {
      const icon = sub.status === 'done' ? '✅' : sub.status === 'in-progress' ? '🔄' : '⬜'
      msg += `  ${icon} ${sub.title}\n`
    }
  }

  if (task.checklist.length > 0) {
    const passed = task.checklist.filter(c => c.passed).length
    msg += `\nChecklist: ${passed}/${task.checklist.length}\n`
  }

  if (task.evaluation) {
    msg += `\nEvaluation: ${task.evaluation.score}/10 — ${task.evaluation.verdict}\n`
    msg += `${task.evaluation.feedback}\n`
  }

  return msg
}

// ============================================================
// P1-2: 对抗性探测模板 — 按任务类型自动附加
// ============================================================

const ADVERSARIAL_PROBES: Record<TaskType, Array<{ description: string; checkCommand?: string; type: 'auto' | 'manual'; required: boolean }>> = {
  frontend: [
    { description: 'Page loads without console errors', checkCommand: 'curl -s -o /dev/null -w "%{http_code}" http://localhost:3000', type: 'auto', required: true },
    { description: 'Empty state renders correctly', type: 'manual', required: true },
    { description: 'Rapid double-click does not create duplicates', type: 'manual', required: false },
  ],
  backend: [
    { description: 'Concurrent requests: create-if-not-exists does not duplicate', type: 'manual', required: true },
    { description: 'Boundary: empty body returns 400 not 500', checkCommand: 'curl -s -X POST -H "Content-Type: application/json" -d "{}" http://localhost:3000/api/test -o /dev/null -w "%{http_code}"', type: 'auto', required: true },
    { description: 'Idempotency: same POST twice does not create two records', type: 'manual', required: true },
    { description: 'Orphan: reference non-existent ID returns 404 not 500', type: 'manual', required: true },
  ],
  cli: [
    { description: 'Empty input handled gracefully', type: 'manual', required: true },
    { description: '--help output is accurate', type: 'manual', required: true },
    { description: 'Invalid flags produce clear error', type: 'manual', required: false },
  ],
  infra: [
    { description: 'Dry-run succeeds', type: 'manual', required: true },
    { description: 'Rollback/down migration works', type: 'manual', required: true },
  ],
  bugfix: [
    { description: 'Original bug is reproducible before fix', type: 'manual', required: true },
    { description: 'Bug is fixed after change', type: 'manual', required: true },
    { description: 'No regression in related functionality', type: 'manual', required: true },
  ],
  refactor: [
    { description: 'Existing test suite passes unchanged', checkCommand: 'npm test', type: 'auto', required: true },
    { description: 'Public API surface unchanged (no new/removed exports)', type: 'manual', required: true },
  ],
  data: [
    { description: 'Output row count matches input (no silent data loss)', type: 'manual', required: true },
    { description: 'Handles NaN/null/empty gracefully', type: 'manual', required: true },
  ],
  other: [],
}

/**
 * P1-2: 获取某种任务类型的对抗性探测 checklist
 */
export function getAdversarialProbes(taskType: TaskType): CheckItem[] {
  const probes = ADVERSARIAL_PROBES[taskType] ?? []
  return probes.map((p, i) => ({
    id: `adversarial-${Date.now()}-${i}`,
    description: `[ADVERSARIAL] ${p.description}`,
    checkCommand: p.checkCommand,
    type: p.type,
    required: p.required,
  }))
}

/**
 * P1-2: 给任务自动附加对抗性探测
 */
export function attachAdversarialProbes(taskId: string): CheckItem[] {
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)
  if (!task.taskType) return []

  const probes = getAdversarialProbes(task.taskType)
  task.checklist.push(...probes)
  task.updatedAt = new Date()
  return probes
}

/**
 * 渲染任务树 — 人类可读的完整状态
 */
export function renderTaskTree(taskList?: Task[], indent: number = 0): string {
  const list = taskList ?? tasks
  let out = ''
  const pad = '  '.repeat(indent)

  for (const task of list) {
    const statusIcon: Record<TaskStatus, string> = {
      'draft': '[ ]', 'approved': '[~]', 'decomposed': '[/]',
      'in-progress': '[>]', 'checking': '[?]', 'evaluating': '[=]',
      'done': '[x]', 'rework': '[!]', 'dropped': '[-]',
    }

    out += `${pad}${statusIcon[task.status]} ${task.title} (${task.priority})\n`

    if (task.checklist.length > 0) {
      const passed = task.checklist.filter(c => c.passed).length
      const required = task.checklist.filter(c => c.required).length
      const requiredPassed = task.checklist.filter(c => c.required && c.passed).length
      out += `${pad}  checklist: ${passed}/${task.checklist.length} (required: ${requiredPassed}/${required})\n`
    }

    if (task.evaluation) {
      out += `${pad}  eval: ${task.evaluation.score}/10 ${task.evaluation.verdict}\n`
    }

    if (task.subtasks.length > 0) {
      out += renderTaskTree(task.subtasks, indent + 1)
    }
  }

  return out
}
