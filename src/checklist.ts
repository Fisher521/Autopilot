/**
 * autopilot 改进清单 — 从 CC 源码学到的
 *
 * 来源：
 * 1. CC 机制 vs autopilot 对比（决策、验证、编排、任务）
 * 2. CC 限制机制分析（十层纵深防御）
 *
 * 原则：不是全抄 CC，是挑适合 autopilot 多 AI 议会制的部分。
 * CC 是独裁制（一个 AI 决策），autopilot 是议会制（多 AI 投票）。
 * 但限制和安全机制是通用的。
 */

// ============================================================
// P0 — 必须有，没有就是裸奔
// ============================================================

export interface ChecklistItem {
  id: string
  priority: 'P0' | 'P1' | 'P2'
  category: string
  title: string
  description: string
  ccReference: string        // CC 源码里对应的文件/机制
  status: 'todo' | 'done'
  implementIn: string        // 改哪个文件
}

export const CHECKLIST: ChecklistItem[] = [

  // ──────────────────────────────────────────
  // P0-1: 工具白名单绑定 Policy
  // ──────────────────────────────────────────
  {
    id: 'P0-1',
    priority: 'P0',
    category: '限制机制',
    title: '工具白名单绑定 Policy',
    description: `每种 policy 只能用特定工具，物理移除而不是靠 prompt 说"请不要"。
      research  → [read, search, fetch]
      analyze   → [read, search, fetch, results.tsv]
      explore   → [read, write, bash(limited), git(no force)]
      exploit   → [read, write, bash(limited), git(no force)]
      consolidate → [read, write, bash, git]`,
    ccReference: 'constants/tools.ts ASYNC_AGENT_ALLOWED_TOOLS + verificationAgent.ts disallowedTools',
    status: 'done',
    implementIn: 'autopilot/src/toolGate.ts (POLICY_TOOLS + checkToolAccess + gate)',
  },

  // ──────────────────────────────────────────
  // P0-2: Executor 不能修改自己的规则
  // ──────────────────────────────────────────
  {
    id: 'P0-2',
    priority: 'P0',
    category: '限制机制',
    title: 'Executor 不能自我修改',
    description: `三样东西 executor 物理上不能改：
      1. 自己的 policy（只有 council 能 switchPolicy）
      2. checklist 定义（只有 council 能 markCheckItem）
      3. 评估标准 metrics（只有 council 能调整 weights）
    实现方式：写操作检查 callerId，非 council 直接 throw。`,
    ccReference: '.claude/ DANGEROUS_DIRECTORY + DANGEROUS_FILES 列表',
    status: 'done',
    implementIn: 'selfProgram.ts switchPolicy(callerRole) + task.ts evaluateTask(callerRole) + toolGate.ts checkResourceAccess()',
  },

  // ──────────────────────────────────────────
  // P0-3: Escalation 有门槛
  // ──────────────────────────────────────────
  {
    id: 'P0-3',
    priority: 'P0',
    category: '决策机制',
    title: 'Escalation 不能太轻率',
    description: `CC 原则："not as a first response to friction"
      1. escalate 时必须附上已尝试的步骤（attempts 字段）
      2. 没有 attempts 的 escalation 被拒绝
      3. 连续 3 次无效 escalation → executor trustScore 扣分
      4. 低风险操作自动放行，不上议会`,
    ccReference: 'constants/prompts.ts "Escalate to the user only when genuinely stuck after investigation"',
    status: 'done',
    implementIn: 'selfProgram.ts escalate(attempts) + toolGate.ts validateEscalation()',
  },

  // ──────────────────────────────────────────
  // P0-4: Verification 要有证据
  // ──────────────────────────────────────────
  {
    id: 'P0-4',
    priority: 'P0',
    category: '验证机制',
    title: 'Checklist 必须附命令输出证据',
    description: `CC 的 verification agent 规则：
      - 每个 check 必须有 "Command run" + "Output observed"
      - 没有命令输出的 PASS 不算 PASS
      - "code looks correct" 不是验证，必须跑命令
    auto checklist item 的 checkCommand 结果必须记录输出。`,
    ccReference: 'verificationAgent.ts "A check without a Command run block is not a PASS — it\'s a skip"',
    status: 'done',
    implementIn: 'task.ts CheckEvidence + runChecklist(evidence) + toolGate.ts validateCheckEvidence()',
  },

  // ──────────────────────────────────────────
  // P0-5: 验证者不能修改代码
  // ──────────────────────────────────────────
  {
    id: 'P0-5',
    priority: 'P0',
    category: '限制机制',
    title: '验证者只读，不能修改项目',
    description: `CC 做法：verification agent 的 disallowedTools 移除 Edit/Write。
    双保险：system prompt 说不能改 + 工具物理移除。
    autopilot 的 reviewer / checker 也应该是只读的。`,
    ccReference: 'verificationAgent.ts disallowedTools + "STRICTLY PROHIBITED from creating, modifying, or deleting"',
    status: 'done',
    implementIn: 'toolGate.ts ROLE_DISALLOWED verifier/reviewer → no write/edit/bash/git',
  },

  // ============================================================
  // P1 — 下一步做，显著提升质量
  // ============================================================

  // ──────────────────────────────────────────
  // P1-1: 议会投票前先综合理解
  // ──────────────────────────────────────────
  {
    id: 'P1-1',
    priority: 'P1',
    category: '决策机制',
    title: 'Council 投票前必须 synthesis',
    description: `CC Coordinator 核心原则：
      "you must understand them before directing follow-up work"
      "Never write 'based on your findings'"
    议会成员投票前，必须先综合理解 executor 的汇报：
      1. 读 executor 的报告
      2. 提炼关键发现（文件路径、行号、具体问题）
      3. 然后才投票
    投票 payload 加 synthesis 必填字段。`,
    ccReference: 'coordinatorMode.ts "Always synthesize — your most important job"',
    status: 'done',
    implementIn: 'autopilot/src/council.ts Vote interface + buildVotePrompt()',
  },

  // ──────────────────────────────────────────
  // P1-2: 对抗性探测模板
  // ──────────────────────────────────────────
  {
    id: 'P1-2',
    priority: 'P1',
    category: '验证机制',
    title: '对抗性探测模板',
    description: `CC verification agent 的对抗性探测：
      - 并发：parallel requests to create-if-not-exists
      - 边界值：0, -1, empty string, MAX_INT
      - 幂等：same mutating request twice
      - 孤儿操作：delete/reference non-existent IDs
    加到 checklist 模板里，特定类型的任务自动附加对抗性探测 check items。`,
    ccReference: 'verificationAgent.ts "ADVERSARIAL PROBES"',
    status: 'done',
    implementIn: 'autopilot/src/task.ts buildDecomposePrompt() + 新建 templates/adversarial.ts',
  },

  // ──────────────────────────────────────────
  // P1-3: 任务依赖关系
  // ──────────────────────────────────────────
  {
    id: 'P1-3',
    priority: 'P1',
    category: '任务系统',
    title: '任务 blocks/blockedBy 依赖',
    description: `CC 的 TaskSchema 有 blocks 和 blockedBy 字段。
    autopilot 目前只有 subtask 层级，没有平级依赖。
    加上后可以防止并行执行有依赖的任务。`,
    ccReference: 'utils/tasks.ts TaskSchema blocks/blockedBy',
    status: 'done',
    implementIn: 'autopilot/src/task.ts Task interface',
  },

  // ──────────────────────────────────────────
  // P1-4: 验证 Nudge 机制
  // ──────────────────────────────────────────
  {
    id: 'P1-4',
    priority: 'P1',
    category: '验证机制',
    title: '完成多任务未验证 → 自动提醒',
    description: `CC 的 nudge：完成 3+ 任务但没有一个是 verification → 自动提醒。
    autopilot 的 task 完成流程应该检查：
      如果连续 N 个 subtask done 但都没跑 verification → 自动 escalate 给 council。`,
    ccReference: 'TodoWriteTool.ts verificationNudgeNeeded 逻辑',
    status: 'done',
    implementIn: 'autopilot/src/task.ts evaluateTask()',
  },

  // ──────────────────────────────────────────
  // P1-5: Bash 命令基础安全检查
  // ──────────────────────────────────────────
  {
    id: 'P1-5',
    priority: 'P1',
    category: '限制机制',
    title: 'Bash 命令安全验证（基础版）',
    description: `CC 有 18+ 验证器，我们不需要全做，但至少要有：
      1. 危险命令拦截：rm -rf /, git push --force, git reset --hard
      2. 注入检测：$() backtick 在非预期位置
      3. 敏感文件保护：不能 cat/write .env, credentials, secrets
    不需要 ML 分类器，规则匹配就够。`,
    ccReference: 'bashSecurity.ts 18 validators + destructiveCommandWarning.ts',
    status: 'done',
    implementIn: '新建 autopilot/src/bashGuard.ts',
  },

  // ──────────────────────────────────────────
  // P1-6: 权限快速通道
  // ──────────────────────────────────────────
  {
    id: 'P1-6',
    priority: 'P1',
    category: '决策机制',
    title: '低风险操作自动放行，不上议会',
    description: `CC 的 SAFE_YOLO_ALLOWLISTED_TOOLS：read, search, glob, todo 等直接放行。
    autopilot 不是每个操作都需要 council 投票：
      - 读文件 → 自动放行
      - 搜索 → 自动放行
      - 写测试文件 → 自动放行
      - 修改生产代码 → 上议会
      - 删除/git push → 上议会
    分三级：auto-allow / classifier / council-vote`,
    ccReference: 'classifierDecision.ts SAFE_YOLO_ALLOWLISTED_TOOLS',
    status: 'done',
    implementIn: 'autopilot/src/toolGate.ts',
  },

  // ============================================================
  // P2 — 以后做，锦上添花
  // ============================================================

  // ──────────────────────────────────────────
  // P2-1: Continue vs Spawn 决策
  // ──────────────────────────────────────────
  {
    id: 'P2-1',
    priority: 'P2',
    category: '编排机制',
    title: 'Worker 复用 vs 新建决策表',
    description: `CC Coordinator 的决策表：
      - 研究了要改的文件 → continue（context 重叠高）
      - 研究范围广但实现范围窄 → spawn fresh（避免噪音）
      - 修正失败 → continue（有错误上下文）
      - 验证别人写的代码 → spawn fresh（新鲜视角）
      - 完全错误的方向 → spawn fresh（避免锚定）
    autopilot 的 hub.ts 应该有类似逻辑。`,
    ccReference: 'coordinatorMode.ts "Choose continue vs. spawn by context overlap" 决策表',
    status: 'done',
    implementIn: 'autopilot/src/hub.ts',
  },

  // ──────────────────────────────────────────
  // P2-2: 反自我合理化检测
  // ──────────────────────────────────────────
  {
    id: 'P2-2',
    priority: 'P2',
    category: '验证机制',
    title: '检测并阻止 executor 自我合理化',
    description: `CC verification agent 列出了常见的自我合理化借口：
      - "Code looks correct" → 不算，必须跑
      - "Tests already pass" → 不算，独立验证
      - "This is probably fine" → 不算，probably ≠ verified
      - "Would take too long" → 不是你决定的
    executor 的汇报里如果出现这些模式 → 自动拒绝，要求重新验证。`,
    ccReference: 'verificationAgent.ts "RECOGNIZE YOUR OWN RATIONALIZATIONS"',
    status: 'done',
    implementIn: 'autopilot/src/reviewer.ts',
  },

  // ──────────────────────────────────────────
  // P2-3: PARTIAL 判定
  // ──────────────────────────────────────────
  {
    id: 'P2-3',
    priority: 'P2',
    category: '验证机制',
    title: 'PASS/FAIL 之外加 PARTIAL',
    description: `CC 的三档判定：PASS / FAIL / PARTIAL。
    PARTIAL 仅用于环境限制（没有测试框架、工具不可用、服务起不来）。
    不是"我不确定"，是"客观上跑不了这个检查"。
    autopilot 的 checklist 应该支持 partial。`,
    ccReference: 'verificationAgent.ts "PARTIAL is for environmental limitations only"',
    status: 'done',
    implementIn: 'autopilot/src/task.ts CheckItem interface + markCheckPartial()',
  },

  // ──────────────────────────────────────────
  // P2-4: Prompt 缓存边界
  // ──────────────────────────────────────────
  {
    id: 'P2-4',
    priority: 'P2',
    category: '性能优化',
    title: 'System prompt 分静态/动态两段',
    description: `CC 用 __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ 分割：
      - 前半段：全局不变（可缓存）
      - 后半段：session/用户相关（不缓存）
    autopilot 的 executor prompt 也可以这样优化，减少 token 消耗。`,
    ccReference: 'prompts.ts __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
    status: 'done',
    implementIn: 'autopilot/src/selfProgram.ts buildExecutorPrompt() + PROMPT_CACHE_BOUNDARY',
  },

  // ──────────────────────────────────────────
  // P2-5: 文件系统安全
  // ──────────────────────────────────────────
  {
    id: 'P2-5',
    priority: 'P2',
    category: '限制机制',
    title: '敏感文件/目录保护',
    description: `CC 的 DANGEROUS_FILES 和 DANGEROUS_DIRECTORIES：
      文件：.gitconfig, .bashrc, .zshrc, .mcp.json, .claude.json
      目录：.git, .vscode, .idea, .claude
    autopilot 也应该维护一个保护列表，executor 不能读写这些。`,
    ccReference: 'utils/permissions/filesystem.ts DANGEROUS_FILES + DANGEROUS_DIRECTORIES',
    status: 'done',
    implementIn: 'autopilot/src/toolGate.ts DANGEROUS_FILES + DANGEROUS_DIRECTORIES + isDangerousPath()',
  },

  // ──────────────────────────────────────────
  // P2-6: 并发安全（文件锁）
  // ──────────────────────────────────────────
  {
    id: 'P2-6',
    priority: 'P2',
    category: '任务系统',
    title: '多 executor 并发时的文件锁',
    description: `CC 用 file lock + 30 次重试（5ms-100ms）防止并发写冲突。
    autopilot 多任务并行时，results.tsv 和 task 状态文件需要锁。`,
    ccReference: 'utils/tasks.ts LOCK_OPTIONS retries: 30, minTimeout: 5, maxTimeout: 100',
    status: 'done',
    implementIn: 'autopilot/src/fileLock.ts acquireLock() + releaseLock() + withLock()',
  },
]

// ============================================================
// 统计
// ============================================================

export function getChecklistStats(): string {
  const byPriority = { P0: 0, P1: 0, P2: 0 }
  const done = { P0: 0, P1: 0, P2: 0 }

  for (const item of CHECKLIST) {
    byPriority[item.priority]++
    if (item.status === 'done') done[item.priority]++
  }

  return `Checklist: ${CHECKLIST.filter(i => i.status === 'done').length}/${CHECKLIST.length} done
  P0: ${done.P0}/${byPriority.P0} (必须有)
  P1: ${done.P1}/${byPriority.P1} (下一步)
  P2: ${done.P2}/${byPriority.P2} (以后做)`
}

export function renderChecklist(): string {
  let out = '# autopilot 改进清单（从 CC 学到的）\n\n'

  const groups: Record<string, ChecklistItem[]> = {}
  for (const item of CHECKLIST) {
    const key = `${item.priority}`
    if (!groups[key]) groups[key] = []
    groups[key].push(item)
  }

  const labels: Record<string, string> = {
    P0: 'P0 — 必须有，没有就是裸奔',
    P1: 'P1 — 下一步做，显著提升质量',
    P2: 'P2 — 以后做，锦上添花',
  }

  for (const p of ['P0', 'P1', 'P2']) {
    const items = groups[p] ?? []
    out += `## ${labels[p]}\n\n`

    for (const item of items) {
      const icon = item.status === 'done' ? '[x]' : '[ ]'
      out += `### ${icon} ${item.id}: ${item.title}\n`
      out += `**分类:** ${item.category}\n`
      out += `**改哪里:** \`${item.implementIn}\`\n`
      out += `**CC 参考:** \`${item.ccReference}\`\n\n`
      out += `${item.description}\n\n`
    }
  }

  return out
}
