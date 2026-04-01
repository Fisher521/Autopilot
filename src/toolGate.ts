/**
 * 工具门禁 — 物理级别的权限控制
 *
 * CC 的做法：不是靠 prompt 说"请不要"，是物理移除工具。
 * verification agent → disallowedTools: [Edit, Write, Notebook, Agent]
 * coordinator → 只有 [Agent, TaskStop, SendMessage]
 *
 * autopilot 的做法：
 * 1. 每种 Policy 绑定工具白名单（research 只能 read/search）
 * 2. 每种角色有额外限制（verifier 不能 write）
 * 3. 受保护资源不可修改（policy/checklist/metrics）
 * 4. 危险命令拦截（rm -rf, force push）
 */

import type { PolicyType } from './selfProgram.js'

// ============================================================
// Tool 定义
// ============================================================

export type Tool =
  | 'read'           // 读文件
  | 'write'          // 写文件
  | 'edit'           // 编辑文件
  | 'search'         // 搜索（grep/glob）
  | 'fetch'          // 网络请求（curl/fetch）
  | 'bash'           // Shell 命令
  | 'bash-readonly'  // 只读 Shell（ls, cat, echo, test）
  | 'git'            // Git 操作
  | 'git-safe'       // 安全 Git（add, commit, status, diff, log）
  | 'results'        // 读写 results.tsv
  | 'notify'         // 发通知
  | 'escalate'       // 上报给议会

export type Role = 'executor' | 'verifier' | 'reviewer' | 'council' | 'human'

// ============================================================
// P0-1: Policy → 工具白名单
// ============================================================

const POLICY_TOOLS: Record<PolicyType, Set<Tool>> = {
  research: new Set([
    'read', 'search', 'fetch', 'bash-readonly', 'results', 'notify', 'escalate',
  ]),
  analyze: new Set([
    'read', 'search', 'fetch', 'bash-readonly', 'results', 'notify', 'escalate',
  ]),
  explore: new Set([
    'read', 'write', 'edit', 'search', 'fetch', 'bash', 'git-safe', 'results', 'notify', 'escalate',
  ]),
  exploit: new Set([
    'read', 'write', 'edit', 'search', 'fetch', 'bash', 'git-safe', 'results', 'notify', 'escalate',
  ]),
  consolidate: new Set([
    'read', 'write', 'edit', 'search', 'fetch', 'bash', 'git', 'results', 'notify', 'escalate',
  ]),
}

// P0-5: 角色额外限制
const ROLE_DISALLOWED: Record<Role, Set<Tool>> = {
  executor: new Set([]),                                    // 按 policy 走
  verifier: new Set(['write', 'edit', 'bash', 'git']),      // 只读！
  reviewer: new Set(['write', 'edit', 'bash', 'git']),      // 只读！
  council: new Set([]),                                      // council 能做一切
  human: new Set([]),                                        // 人能做一切
}

/**
 * 检查某个角色在某个 policy 下能否使用某个工具
 *
 * 返回 { allowed, reason }
 */
export function checkToolAccess(
  tool: Tool,
  policy: PolicyType,
  role: Role,
): { allowed: boolean; reason?: string } {
  // 人和 council 不受限制
  if (role === 'human' || role === 'council') {
    return { allowed: true }
  }

  // 角色黑名单优先
  if (ROLE_DISALLOWED[role].has(tool)) {
    return {
      allowed: false,
      reason: `Role "${role}" cannot use tool "${tool}". This is a physical restriction, not a suggestion.`,
    }
  }

  // Policy 白名单
  const allowed = POLICY_TOOLS[policy]
  if (!allowed.has(tool)) {
    return {
      allowed: false,
      reason: `Policy "${policy}" does not allow tool "${tool}". Allowed: [${[...allowed].join(', ')}]`,
    }
  }

  return { allowed: true }
}

/**
 * 获取某个角色在某个 policy 下的可用工具列表
 */
export function getAvailableTools(policy: PolicyType, role: Role): Tool[] {
  if (role === 'human' || role === 'council') {
    const all = new Set<Tool>()
    for (const set of Object.values(POLICY_TOOLS)) {
      for (const t of set) all.add(t)
    }
    return [...all]
  }

  const policyTools = POLICY_TOOLS[policy]
  const disallowed = ROLE_DISALLOWED[role]

  return [...policyTools].filter(t => !disallowed.has(t))
}

// ============================================================
// P0-2: 受保护资源 — executor 不能修改
// ============================================================

export type ProtectedResource =
  | 'policy'           // selfProgram.ts switchPolicy
  | 'checklist-def'    // task.ts checklist 定义
  | 'metrics'          // selfProgram.ts metrics/weights
  | 'constraints'      // selfProgram.ts constraints
  | 'evaluation'       // task.ts evaluateTask
  | 'trust-scores'     // council.ts updateTrustScores

const RESOURCE_ALLOWED_ROLES: Record<ProtectedResource, Set<Role>> = {
  'policy':         new Set(['council', 'human']),
  'checklist-def':  new Set(['council', 'human']),
  'metrics':        new Set(['council', 'human']),
  'constraints':    new Set(['council', 'human']),
  'evaluation':     new Set(['council', 'human']),
  'trust-scores':   new Set(['council', 'human']),
}

/**
 * 检查某个角色能否修改某个受保护资源
 */
export function checkResourceAccess(
  resource: ProtectedResource,
  callerId: string,
  callerRole: Role,
): { allowed: boolean; reason?: string } {
  const allowed = RESOURCE_ALLOWED_ROLES[resource]
  if (allowed.has(callerRole)) {
    return { allowed: true }
  }

  return {
    allowed: false,
    reason: `"${callerId}" (role: ${callerRole}) cannot modify "${resource}". Only [${[...allowed].join(', ')}] can.`,
  }
}

// ============================================================
// P0-5 / P1-5: Bash 命令安全检查（基础版）
// ============================================================

interface BashCheckResult {
  safe: boolean
  level: 'allow' | 'warn' | 'block'
  reason?: string
}

/** 直接拦截的命令模式 */
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // 毁灭性操作
  { pattern: /rm\s+(-[rR]f?\s+|.*--no-preserve-root)[\/"~]/, reason: 'Destructive rm on root/home' },
  { pattern: /rm\s+-[rR]f\s+\./, reason: 'Destructive rm in current directory' },
  { pattern: /mkfs\./, reason: 'Filesystem format command' },
  { pattern: /dd\s+.*of=\/dev\//, reason: 'Direct disk write' },

  // Git 危险操作
  { pattern: /git\s+push\s+.*(-f|--force)\b/, reason: 'Git force push' },
  { pattern: /git\s+reset\s+--hard/, reason: 'Git reset --hard discards changes' },
  { pattern: /git\s+clean\s+-[rR]?f/, reason: 'Git clean removes untracked files' },
  { pattern: /git\s+(commit|push|merge)\s+.*--no-verify/, reason: 'Skipping git hooks' },

  // 权限提升
  { pattern: /sudo\s/, reason: 'Sudo command' },
  { pattern: /chmod\s+777/, reason: 'World-writable permissions' },

  // 自修改
  { pattern: />\s*.*autopilot\/src\/(selfProgram|council|checklist|toolGate)\.ts/, reason: 'Attempt to overwrite autopilot core files' },
]

/** 需要警告但不拦截的命令 */
const WARN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /git\s+commit\s+--amend/, reason: 'Amending last commit' },
  { pattern: /git\s+stash\s+(drop|clear)/, reason: 'Dropping stashed changes' },
  { pattern: /git\s+branch\s+-D/, reason: 'Force deleting branch' },
  { pattern: /npm\s+(publish|unpublish)/, reason: 'Publishing to npm' },
  { pattern: /curl\s+.*-X\s*(DELETE|PUT|POST)/, reason: 'Mutating HTTP request' },
]

/** 敏感文件 — 不可读写 */
const SENSITIVE_FILE_PATTERNS = [
  /\.env(\.\w+)?$/,
  /credentials\.(json|yml|yaml)$/,
  /\.aws\/credentials$/,
  /id_rsa|id_ed25519$/,
  /\.ssh\/config$/,
  /secret[s]?\.(json|yml|yaml|txt)$/,
  /token[s]?\.(json|txt)$/,
]

/**
 * P2-5: 危险文件 — executor 不能写入
 *
 * CC 的 DANGEROUS_FILES：系统配置文件，改了可能导致环境损坏
 */
const DANGEROUS_FILES = new Set([
  '.gitconfig',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.mcp.json',
  '.claude.json',
  '.claude/settings.json',
  'package-lock.json',     // 不应该手动改
  'yarn.lock',             // 不应该手动改
  'pnpm-lock.yaml',        // 不应该手动改
])

/**
 * P2-5: 危险目录 — executor 不能写入其中的文件
 *
 * CC 的 DANGEROUS_DIRECTORIES：版本控制、IDE 配置、工具配置
 */
const DANGEROUS_DIRECTORIES = [
  '.git/',
  '.git\\',
  '.vscode/',
  '.idea/',
  '.claude/',
  '.github/workflows/',    // CI 配置需要 council 审批
  'node_modules/',
]

/**
 * P2-5: 检查文件路径是否危险
 */
export function isDangerousPath(filePath: string, operation: 'read' | 'write'): {
  dangerous: boolean
  reason?: string
} {
  const normalized = filePath.replace(/\\/g, '/')
  const basename = normalized.split('/').pop() ?? ''

  // 敏感文件 — 读写都不行
  for (const pattern of SENSITIVE_FILE_PATTERNS) {
    if (pattern.test(normalized)) {
      return { dangerous: true, reason: `Sensitive file: ${basename}` }
    }
  }

  // 以下只限制写入，读取允许
  if (operation === 'read') {
    return { dangerous: false }
  }

  // 危险文件 — 不能写
  if (DANGEROUS_FILES.has(basename)) {
    return { dangerous: true, reason: `Dangerous file: ${basename} — modifying this may break the environment` }
  }

  // 危险目录 — 不能写入其中的文件
  for (const dir of DANGEROUS_DIRECTORIES) {
    if (normalized.includes(dir)) {
      return { dangerous: true, reason: `Dangerous directory: ${dir} — executor cannot modify files here` }
    }
  }

  return { dangerous: false }
}

/**
 * 检查 bash 命令是否安全
 */
export function checkBashCommand(command: string): BashCheckResult {
  // 1. 拦截
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, level: 'block', reason }
    }
  }

  // 2. 敏感文件检查
  for (const filePattern of SENSITIVE_FILE_PATTERNS) {
    if (filePattern.test(command)) {
      return { safe: false, level: 'block', reason: `Accessing sensitive file: ${command.match(filePattern)?.[0]}` }
    }
  }

  // 3. 警告
  for (const { pattern, reason } of WARN_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: true, level: 'warn', reason }
    }
  }

  return { safe: true, level: 'allow' }
}

// ============================================================
// P0-3: Escalation 门槛 — 必须附已尝试步骤
// ============================================================

export interface EscalationAttempt {
  action: string        // 尝试了什么
  result: string        // 结果是什么
  timestamp: Date
}

export interface ValidatedEscalation {
  valid: boolean
  reason?: string
}

/**
 * 验证 escalation 是否有效
 *
 * CC 原则："not as a first response to friction"
 * 必须先尝试自己解决，附上尝试步骤。
 *
 * 例外：policy-expired 是自动触发的，不需要 attempts
 */
export function validateEscalation(
  type: string,
  attempts: EscalationAttempt[],
): ValidatedEscalation {
  // 自动触发的不需要 attempts
  const AUTO_ESCALATION_TYPES = ['policy-expired']
  if (AUTO_ESCALATION_TYPES.includes(type)) {
    return { valid: true }
  }

  // 其他类型必须有至少 1 次尝试
  if (attempts.length === 0) {
    return {
      valid: false,
      reason: `Escalation rejected: no prior attempts. You must try to resolve the issue before escalating. Describe what you tried and what happened.`,
    }
  }

  return { valid: true }
}

// ============================================================
// P0-4: Checklist 证据要求
// ============================================================

export interface CheckEvidence {
  command: string        // 跑了什么命令
  output: string         // 实际输出（copy-paste，不是 paraphrase）
  exitCode: number       // 退出码
  timestamp: Date
}

/**
 * 验证 check evidence 是否有效
 *
 * CC 原则："A check without a Command run block is not a PASS — it's a skip"
 */
export function validateCheckEvidence(evidence?: CheckEvidence): {
  valid: boolean
  reason?: string
} {
  if (!evidence) {
    return {
      valid: false,
      reason: 'No evidence provided. A check without command output is not a PASS — it\'s a skip.',
    }
  }

  if (!evidence.command.trim()) {
    return {
      valid: false,
      reason: 'Empty command. You must run an actual command to verify.',
    }
  }

  if (!evidence.output.trim()) {
    return {
      valid: false,
      reason: 'Empty output. Copy-paste actual terminal output, not a paraphrase.',
    }
  }

  // 检测自我合理化模式
  const RATIONALIZATION_PATTERNS = [
    /code looks correct/i,
    /looks? good/i,
    /should work/i,
    /probably fine/i,
    /seems correct/i,
    /based on (?:my |the )?reading/i,
  ]

  for (const pattern of RATIONALIZATION_PATTERNS) {
    if (pattern.test(evidence.output)) {
      return {
        valid: false,
        reason: `Rationalization detected: "${evidence.output.match(pattern)?.[0]}". Reading code is not verification. Run the command.`,
      }
    }
  }

  return { valid: true }
}

// ============================================================
// P1-6: 操作风险分级 — 不是每个操作都要上议会
// ============================================================

export type RiskLevel = 'auto-allow' | 'log-only' | 'council-vote'

/**
 * P1-6: 判断操作的风险级别
 *
 * CC 的 SAFE_YOLO_ALLOWLISTED_TOOLS：read/search/glob 自动放行。
 * autopilot 三级：
 *   auto-allow → 直接执行，不打扰议会
 *   log-only   → 执行但记录，异步通知议会
 *   council-vote → 必须等议会投票
 */
export function assessRisk(tool: Tool, bashCommand?: string): RiskLevel {
  // 只读操作 → 自动放行
  const AUTO_ALLOW: Set<Tool> = new Set([
    'read', 'search', 'bash-readonly', 'notify', 'escalate', 'results',
  ])
  if (AUTO_ALLOW.has(tool)) {
    return 'auto-allow'
  }

  // fetch → 看是不是 mutating
  if (tool === 'fetch') {
    if (bashCommand && /(-X\s*(DELETE|PUT|PATCH|POST)|--data)/.test(bashCommand)) {
      return 'council-vote'
    }
    return 'log-only'
  }

  // git-safe (add/commit/status/diff) → log-only
  if (tool === 'git-safe') {
    return 'log-only'
  }

  // 写文件 → 看写什么
  if (tool === 'write' || tool === 'edit') {
    // 测试文件 → log-only
    if (bashCommand && /\.(test|spec|__test__)\.(ts|js|py)$/.test(bashCommand)) {
      return 'log-only'
    }
    return 'council-vote'
  }

  // bash → 看命令内容
  if (tool === 'bash' && bashCommand) {
    // 只读 bash 命令
    if (/^(ls|cat|head|tail|wc|echo|pwd|which|type|file|stat)\b/.test(bashCommand.trim())) {
      return 'auto-allow'
    }
    // 测试/构建
    if (/^(npm test|npm run test|pytest|jest|make test|go test)\b/.test(bashCommand.trim())) {
      return 'log-only'
    }
    return 'council-vote'
  }

  // git (full) → 总是 council
  if (tool === 'git') {
    return 'council-vote'
  }

  return 'council-vote'
}

// ============================================================
// 综合门禁 — 一站式检查
// ============================================================

export interface GateRequest {
  tool: Tool
  policy: PolicyType
  role: Role
  callerId: string
  bashCommand?: string               // 如果是 bash 工具
  filePath?: string                  // P2-5: 如果是文件操作
  protectedResource?: ProtectedResource  // 如果要修改受保护资源
}

export interface GateResult {
  allowed: boolean
  level: 'allow' | 'warn' | 'block'
  risk: RiskLevel                     // P1-6: 操作需要哪级审批
  reasons: string[]
}

/**
 * 一站式门禁检查 — 所有限制在这里汇聚
 */
export function gate(request: GateRequest): GateResult {
  const reasons: string[] = []

  // 1. 工具白名单
  const toolCheck = checkToolAccess(request.tool, request.policy, request.role)
  if (!toolCheck.allowed) {
    return { allowed: false, level: 'block', risk: 'council-vote', reasons: [toolCheck.reason!] }
  }

  // 2. 受保护资源
  if (request.protectedResource) {
    const resourceCheck = checkResourceAccess(
      request.protectedResource,
      request.callerId,
      request.role,
    )
    if (!resourceCheck.allowed) {
      return { allowed: false, level: 'block', risk: 'council-vote', reasons: [resourceCheck.reason!] }
    }
  }

  // 3. P2-5: 文件路径安全
  if (request.filePath && request.role !== 'human' && request.role !== 'council') {
    const fileOp = (request.tool === 'read' || request.tool === 'search') ? 'read' : 'write'
    const pathCheck = isDangerousPath(request.filePath, fileOp)
    if (pathCheck.dangerous) {
      return { allowed: false, level: 'block', risk: 'council-vote', reasons: [pathCheck.reason!] }
    }
  }

  // 4. Bash 安全
  if (request.bashCommand && (request.tool === 'bash' || request.tool === 'bash-readonly')) {
    const bashCheck = checkBashCommand(request.bashCommand)
    if (!bashCheck.safe) {
      return { allowed: false, level: 'block', risk: 'council-vote', reasons: [bashCheck.reason!] }
    }
    if (bashCheck.level === 'warn') {
      reasons.push(`WARNING: ${bashCheck.reason}`)
    }
  }

  // 5. P1-6: 风险分级
  const risk = assessRisk(request.tool, request.bashCommand)

  return {
    allowed: true,
    level: reasons.length > 0 ? 'warn' : 'allow',
    risk,
    reasons,
  }
}
