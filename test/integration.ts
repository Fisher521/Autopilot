/**
 * 集成测试 — 跑一遍核心流程验证 P0 限制机制
 *
 * 测试场景：
 * 1. toolGate: policy 白名单 + 角色限制 + bash 安全 + 受保护资源
 * 2. selfProgram: escalation 门槛 + policy 切换权限
 * 3. task: 证据验证 + 评估权限
 * 4. council: 加权投票
 * 5. loop: 完整循环
 */

import { checkToolAccess, checkResourceAccess, checkBashCommand, gate, validateEscalation, validateCheckEvidence, getAvailableTools, assessRisk, isDangerousPath } from '../src/toolGate.js'
import { createSelfProgram, switchPolicy, escalate, tickRound, scoreExperiment, buildExecutorPrompt, PROMPT_CACHE_BOUNDARY, validateBlockerAnalysis, type BlockerAnalysis } from '../src/selfProgram.js'
import { createTask, approveTask, applyTaskPlan, startTask, submitForChecking, runChecklist, evaluateTask, renderTaskTree, addDependency, checkVerificationNudge, markVerified, attachAdversarialProbes, markCheckPartial, type TaskType } from '../src/task.js'
import { resolveVotes, updateTrustScores, getVoters } from '../src/council.js'
import { contextOverlap, shouldContinueOrSpawn, registerWorker, selectWorker, _resetWorkers, type Worker, type SpawnContext } from '../src/hub.js'
import { acquireLock, releaseLock, withLock, getLockInfo, getAllLocks, forceReleaseLock, _resetLocks } from '../src/fileLock.js'

let passed = 0
let failed = 0

function assert(condition: boolean, name: string) {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}`)
  }
}

function assertThrows(fn: () => void, name: string) {
  try {
    fn()
    failed++
    console.log(`  ✗ ${name} (should have thrown)`)
  } catch (e: any) {
    passed++
    console.log(`  ✓ ${name} → ${e.message.slice(0, 60)}...`)
  }
}

// ============================================================
console.log('\n=== 1. Tool Gate: Policy 白名单 ===')
// ============================================================

// research policy → 不能 write
assert(!checkToolAccess('write', 'research', 'executor').allowed, 'research: executor cannot write')
assert(!checkToolAccess('edit', 'research', 'executor').allowed, 'research: executor cannot edit')
assert(!checkToolAccess('bash', 'research', 'executor').allowed, 'research: executor cannot bash')
assert(checkToolAccess('read', 'research', 'executor').allowed, 'research: executor can read')
assert(checkToolAccess('search', 'research', 'executor').allowed, 'research: executor can search')
assert(checkToolAccess('escalate', 'research', 'executor').allowed, 'research: executor can escalate')

// explore policy → 能 write 但不能 git (只有 git-safe)
assert(checkToolAccess('write', 'explore', 'executor').allowed, 'explore: executor can write')
assert(checkToolAccess('bash', 'explore', 'executor').allowed, 'explore: executor can bash')
assert(!checkToolAccess('git', 'explore', 'executor').allowed, 'explore: executor cannot full git')
assert(checkToolAccess('git-safe', 'explore', 'executor').allowed, 'explore: executor can git-safe')

// consolidate → 全开
assert(checkToolAccess('git', 'consolidate', 'executor').allowed, 'consolidate: executor can full git')

// council/human 不受限
assert(checkToolAccess('git', 'research', 'council').allowed, 'council: always allowed')
assert(checkToolAccess('bash', 'research', 'human').allowed, 'human: always allowed')

// ============================================================
console.log('\n=== 2. Tool Gate: 角色限制 (P0-5) ===')
// ============================================================

// verifier 不能写
assert(!checkToolAccess('write', 'explore', 'verifier').allowed, 'verifier: cannot write even in explore')
assert(!checkToolAccess('edit', 'explore', 'verifier').allowed, 'verifier: cannot edit')
assert(!checkToolAccess('bash', 'explore', 'verifier').allowed, 'verifier: cannot bash')
assert(checkToolAccess('read', 'explore', 'verifier').allowed, 'verifier: can read')
assert(checkToolAccess('search', 'explore', 'verifier').allowed, 'verifier: can search')

// reviewer 也不能写
assert(!checkToolAccess('write', 'consolidate', 'reviewer').allowed, 'reviewer: cannot write even in consolidate')

// ============================================================
console.log('\n=== 3. Tool Gate: Bash 安全 (P1-5) ===')
// ============================================================

assert(!checkBashCommand('rm -rf /').safe, 'blocks rm -rf /')
assert(!checkBashCommand('git push --force origin main').safe, 'blocks git force push')
assert(!checkBashCommand('git reset --hard HEAD~3').safe, 'blocks git reset --hard')
assert(!checkBashCommand('git commit --no-verify').safe, 'blocks --no-verify')
assert(!checkBashCommand('sudo apt install foo').safe, 'blocks sudo')
assert(!checkBashCommand('cat .env').safe, 'blocks .env access')
assert(!checkBashCommand('cat credentials.json').safe, 'blocks credentials access')
assert(checkBashCommand('ls -la').safe, 'allows ls')
assert(checkBashCommand('git status').safe, 'allows git status')
assert(checkBashCommand('npm test').safe, 'allows npm test')
assert(checkBashCommand('git commit --amend').level === 'warn', 'warns on git amend')

// ============================================================
console.log('\n=== 4. Tool Gate: 受保护资源 (P0-2) ===')
// ============================================================

assert(!checkResourceAccess('policy', 'exec-1', 'executor').allowed, 'executor cannot modify policy')
assert(!checkResourceAccess('metrics', 'exec-1', 'executor').allowed, 'executor cannot modify metrics')
assert(!checkResourceAccess('evaluation', 'exec-1', 'executor').allowed, 'executor cannot modify evaluation')
assert(checkResourceAccess('policy', 'council', 'council').allowed, 'council can modify policy')
assert(checkResourceAccess('policy', 'human-1', 'human').allowed, 'human can modify policy')

// ============================================================
console.log('\n=== 5. Tool Gate: 综合门禁 ===')
// ============================================================

const gateResult = gate({
  tool: 'write', policy: 'research', role: 'executor', callerId: 'test',
})
assert(!gateResult.allowed, 'gate blocks write in research policy')

const gateResult2 = gate({
  tool: 'bash', policy: 'explore', role: 'executor', callerId: 'test',
  bashCommand: 'git push --force origin main',
})
assert(!gateResult2.allowed, 'gate blocks dangerous bash even in explore')

const gateResult3 = gate({
  tool: 'read', policy: 'research', role: 'executor', callerId: 'test',
})
assert(gateResult3.allowed, 'gate allows read in research')

// ============================================================
console.log('\n=== 6. Escalation 门槛 (P0-3) ===')
// ============================================================

const program = createSelfProgram('test goal')

// 没 attempts → throw
assertThrows(
  () => escalate(program, 'direction-unclear', 'I am stuck'),
  'escalate without attempts throws',
)

// 有 attempts → OK
const esc = escalate(program, 'direction-unclear', 'tried but failed', [
  { action: 'tried approach A', result: 'failed with error X' },
])
assert(esc.attempts.length === 1, 'escalation with attempts succeeds')

// policy-expired 不需要 attempts
const esc2 = escalate(program, 'policy-expired', 'max rounds reached')
assert(esc2.type === 'policy-expired', 'policy-expired auto-escalation works')

// ============================================================
console.log('\n=== 7. Policy 切换权限 (P0-2) ===')
// ============================================================

// executor 不能切换 policy
assertThrows(
  () => switchPolicy(program, 'explore', 'executor'),
  'executor cannot switch policy',
)

// council 可以
const newProgram = switchPolicy(program, 'explore', 'council')
assert(newProgram.currentPolicy.type === 'explore', 'council can switch to explore')

// human 可以
const newProgram2 = switchPolicy(newProgram, 'exploit', 'human')
assert(newProgram2.currentPolicy.type === 'exploit', 'human can switch to exploit')

// ============================================================
console.log('\n=== 8. Evidence 验证 (P0-4) ===')
// ============================================================

assert(!validateCheckEvidence(undefined).valid, 'no evidence → invalid')
assert(!validateCheckEvidence({ command: '', output: 'ok', exitCode: 0, timestamp: new Date() }).valid, 'empty command → invalid')
assert(!validateCheckEvidence({ command: 'test', output: '', exitCode: 0, timestamp: new Date() }).valid, 'empty output → invalid')
assert(!validateCheckEvidence({ command: 'test', output: 'code looks correct', exitCode: 0, timestamp: new Date() }).valid, 'rationalization detected → invalid')
assert(!validateCheckEvidence({ command: 'test', output: 'this should work fine, probably fine', exitCode: 0, timestamp: new Date() }).valid, 'probably fine → invalid')
assert(validateCheckEvidence({ command: 'npm test', output: 'PASS 5/5 tests', exitCode: 0, timestamp: new Date() }).valid, 'real evidence → valid')

// ============================================================
console.log('\n=== 9. Task 生命周期 ===')
// ============================================================

const task = createTask('Build login page', 'Implement login form with validation', 'council')
assert(task.status === 'draft', 'task created as draft')

approveTask(task.id)
assert(task.status === 'approved', 'task approved')

const plan = {
  taskId: task.id,
  subtasks: [
    {
      title: 'Create form component',
      description: 'Build the HTML form',
      checklist: [
        { description: 'Form renders', checkCommand: 'echo "PASS: form renders"', type: 'auto' as const, required: true },
        { description: 'Validation works', checkCommand: 'echo "PASS: validation ok"', type: 'auto' as const, required: true },
      ],
      priority: 'p0' as const,
    },
  ],
  reasoning: 'Simple single-component task',
  proposedBy: 'council',
}
const subtasks = applyTaskPlan(plan)
assert(subtasks.length === 1, 'task decomposed into 1 subtask')
assert(task.status === 'decomposed', 'parent status is decomposed')

const sub = subtasks[0]
startTask(sub.id, 'executor-1')
assert(sub.status === 'in-progress', 'subtask started')

submitForChecking(sub.id)
assert(sub.status === 'checking', 'subtask submitted for checking')

// Run checklist with evidence
const checkResult = await runChecklist(sub.id, async (cmd) => ({
  passed: true,
  output: `$ ${cmd}\nPASS: all checks passed`,
  exitCode: 0,
}))
assert(checkResult.allPassed, 'checklist all passed')
assert(checkResult.results[0].evidence !== undefined, 'evidence collected')
assert(checkResult.results[0].evidence!.output.includes('PASS'), 'evidence has real output')

// Executor 不能评估自己
assertThrows(
  () => evaluateTask(sub.id, {
    score: 10, verdict: 'accept', feedback: 'I did great',
    evaluatedBy: 'executor-1', evaluatedAt: new Date(),
  }, 'executor'),
  'executor cannot evaluate own work',
)

// Council 可以评估
evaluateTask(sub.id, {
  score: 8, verdict: 'accept', feedback: 'Good implementation',
  evaluatedBy: 'council', evaluatedAt: new Date(),
}, 'council')
assert(sub.status === 'done', 'subtask done after council evaluation')

console.log('\n=== Task Tree ===')
console.log(renderTaskTree())

// ============================================================
console.log('\n=== 10. Council 投票 ===')
// ============================================================

const context = {
  id: 'test-1',
  type: 'keep-or-discard' as const,
  description: 'Keep this experiment?',
  metrics: { accuracy: 0.95 },
  urgency: 'medium' as const,
}

// 人投 reject → veto
const result1 = resolveVotes(context, [
  { voterId: 'human', action: 'reject', reasoning: 'Not good enough', confidence: 1, timestamp: new Date() },
  { voterId: 'cc', action: 'approve', score: 8, reasoning: 'Looks good', confidence: 0.9, timestamp: new Date() },
])
assert(result1.decision === 'reject', 'human veto overrides AI approve')
assert(result1.humanOverride === true, 'marked as human override')

// 人不投 → AI 加权
const result2 = resolveVotes(context, [
  { voterId: 'cc', action: 'approve', score: 8, reasoning: 'Good', confidence: 0.9, timestamp: new Date() },
  { voterId: 'codex', action: 'approve', score: 7, reasoning: 'OK', confidence: 0.8, timestamp: new Date() },
  { voterId: 'openclaw', action: 'reject', score: 3, reasoning: 'Bad perf', confidence: 0.6, timestamp: new Date() },
])
assert(result2.decision === 'approve', 'AI weighted vote: approve wins')

// 信任分更新
const votersBefore = getVoters()
const ccBefore = votersBefore.find(v => v.id === 'cc')!.trustScore
updateTrustScores(
  [{ voterId: 'cc', action: 'approve', score: 8, reasoning: 'Good', confidence: 0.9, timestamp: new Date() }],
  'good',
)
const ccAfter = getVoters().find(v => v.id === 'cc')!.trustScore
assert(ccAfter > ccBefore, `CC trust increased: ${ccBefore} → ${ccAfter}`)

// ============================================================
console.log('\n=== 11. Executor Prompt 包含工具限制 ===')
// ============================================================

const researchProgram = createSelfProgram('test', 'research')
const prompt = buildExecutorPrompt(researchProgram)
assert(prompt.includes('EXECUTOR'), 'prompt has executor role')
assert(prompt.includes('RESEARCH'), 'prompt has policy type')
assert(prompt.includes('ANALYZE FIRST'), 'prompt mentions analyze first before fix')
assert(prompt.includes('attempts'), 'prompt mentions attempts requirement')

// ============================================================
console.log('\n=== 12. P1-1: Synthesis 要求 ===')
// ============================================================

const synthContext = {
  id: 'synth-1',
  type: 'keep-or-discard' as const,
  description: 'Keep this?',
  urgency: 'medium' as const,
}

// AI 没 synthesis + requireSynthesis=true → rejected
const synthResult = resolveVotes(synthContext, [
  { voterId: 'cc', action: 'approve', score: 8, reasoning: 'Looks good', confidence: 0.9, timestamp: new Date() },
], true)
assert(synthResult.decision === 'needs-info', 'AI vote without synthesis rejected when required')
assert(synthResult.reasoning.includes('missing synthesis'), 'reason mentions missing synthesis')

// AI 有 synthesis → OK
const synthResult2 = resolveVotes(synthContext, [
  { voterId: 'cc', action: 'approve', score: 8, reasoning: 'Good', synthesis: 'Found issue in src/auth.ts:42, null check missing on user.id access', confidence: 0.9, timestamp: new Date() },
], true)
assert(synthResult2.decision === 'approve', 'AI vote with synthesis accepted')

// ============================================================
console.log('\n=== 13. P1-2: 对抗性探测 ===')
// ============================================================

const backendTask = createTask('Build API endpoint', 'POST /api/users', 'council', { taskType: 'backend' })
approveTask(backendTask.id)
const probes = attachAdversarialProbes(backendTask.id)
assert(probes.length > 0, `backend task got ${probes.length} adversarial probes`)
assert(probes.some(p => p.description.includes('Concurrent')), 'has concurrency probe')
assert(probes.some(p => p.description.includes('Boundary')), 'has boundary probe')
assert(probes.some(p => p.description.includes('Idempotency')), 'has idempotency probe')

const cliTask = createTask('Build CLI tool', 'autopilot init', 'council', { taskType: 'cli' })
const cliProbes = attachAdversarialProbes(cliTask.id)
assert(cliProbes.some(p => p.description.includes('Empty input')), 'CLI has empty input probe')

const otherTask = createTask('Write docs', 'README', 'council', { taskType: 'other' })
const otherProbes = attachAdversarialProbes(otherTask.id)
assert(otherProbes.length === 0, 'other type has no probes')

// ============================================================
console.log('\n=== 14. P1-3: 任务依赖 ===')
// ============================================================

const taskA = createTask('Setup DB', 'Create tables', 'council')
const taskB = createTask('Build API', 'Needs DB first', 'council')
approveTask(taskA.id)
approveTask(taskB.id)
addDependency(taskB.id, taskA.id)
assert(taskB.blockedBy.includes(taskA.id), 'taskB blocked by taskA')
assert(taskA.blocks.includes(taskB.id), 'taskA blocks taskB')

// 尝试启动被阻塞的任务 → throw
assertThrows(
  () => startTask(taskB.id, 'exec-1'),
  'cannot start blocked task',
)

// 完成 taskA 后可以启动 taskB
startTask(taskA.id, 'exec-1')
submitForChecking(taskA.id)
await runChecklist(taskA.id, async () => ({ passed: true, output: 'OK', exitCode: 0 }))
evaluateTask(taskA.id, { score: 8, verdict: 'accept', feedback: 'Good', evaluatedBy: 'council', evaluatedAt: new Date() }, 'council')
assert(taskA.status === 'done', 'taskA is done')

startTask(taskB.id, 'exec-1')  // should not throw now
assert(taskB.status === 'in-progress', 'taskB can start after dependency resolved')

// ============================================================
console.log('\n=== 15. P1-4: Verification Nudge ===')
// ============================================================

// taskA was just completed and is a top-level task, need at least 2 done unverified
// taskA is done. Let's also make another top-level done task.
const taskC = createTask('Quick fix', 'Minor patch', 'council')
approveTask(taskC.id)
startTask(taskC.id, 'exec-1')
submitForChecking(taskC.id)
await runChecklist(taskC.id, async () => ({ passed: true, output: 'OK', exitCode: 0 }))
evaluateTask(taskC.id, { score: 7, verdict: 'accept', feedback: 'OK', evaluatedBy: 'council', evaluatedAt: new Date() }, 'council')

const nudge = checkVerificationNudge(2)
assert(nudge.nudge === true, `nudge triggered: ${nudge.unverifiedCount} unverified`)

// 标记一个 verified
markVerified(sub.id)
assert(sub.verified === true, 'task marked as verified')

// ============================================================
console.log('\n=== 16. P1-6: 风险分级 ===')
// ============================================================

assert(assessRisk('read') === 'auto-allow', 'read → auto-allow')
assert(assessRisk('search') === 'auto-allow', 'search → auto-allow')
assert(assessRisk('bash-readonly') === 'auto-allow', 'bash-readonly → auto-allow')
assert(assessRisk('git-safe') === 'log-only', 'git-safe → log-only')
assert(assessRisk('git') === 'council-vote', 'full git → council-vote')
assert(assessRisk('write') === 'council-vote', 'write → council-vote')
assert(assessRisk('bash', 'ls -la') === 'auto-allow', 'bash ls → auto-allow')
assert(assessRisk('bash', 'npm test') === 'log-only', 'bash npm test → log-only')
assert(assessRisk('bash', 'rm -rf build/') === 'council-vote', 'bash rm → council-vote')
assert(assessRisk('fetch', 'curl https://api.example.com') === 'log-only', 'GET fetch → log-only')
assert(assessRisk('fetch', 'curl -X DELETE https://api.example.com/users/1') === 'council-vote', 'DELETE fetch → council-vote')

// ============================================================
console.log('\n=== 17. P2-1: Worker Continue vs Spawn ===')
// ============================================================

_resetWorkers()

const workerA: Worker = {
  id: 'w1', name: 'Worker A', provider: 'claude',
  status: 'idle', contextFiles: ['src/auth.ts', 'src/user.ts', 'src/db.ts'],
  errorHistory: [], roundsCompleted: 5, createdAt: new Date(),
}
registerWorker(workerA)

// High overlap → continue
const overlap1 = contextOverlap(workerA, ['src/auth.ts', 'src/user.ts'])
assert(overlap1 > 0.5, `high overlap: ${overlap1.toFixed(2)}`)

const spawn1 = shouldContinueOrSpawn(workerA, {
  taskFiles: ['src/auth.ts', 'src/user.ts'], taskType: 'implement',
  isVerification: false,
})
assert(spawn1.decision === 'continue', 'high overlap → continue')

// Verification → always spawn fresh
const spawn2 = shouldContinueOrSpawn(workerA, {
  taskFiles: ['src/auth.ts'], taskType: 'verify',
  isVerification: true,
})
assert(spawn2.decision === 'spawn-fresh', 'verification → spawn-fresh')

// Wrong direction → spawn fresh
const spawn3 = shouldContinueOrSpawn(workerA, {
  taskFiles: ['src/auth.ts'], taskType: 'implement',
  previousOutcome: 'wrong-direction', isVerification: false,
})
assert(spawn3.decision === 'spawn-fresh', 'wrong direction → spawn-fresh')

// Failure with error context → continue
const workerFailed: Worker = {
  ...workerA, id: 'w2', errorHistory: ['TypeError: null ref at auth.ts:42'],
}
registerWorker(workerFailed)
const spawn4 = shouldContinueOrSpawn(workerFailed, {
  taskFiles: ['src/auth.ts'], taskType: 'fix',
  previousOutcome: 'failure', isVerification: false,
})
assert(spawn4.decision === 'continue', 'failure with errors → continue')

// Low overlap → spawn fresh
const spawn5 = shouldContinueOrSpawn(workerA, {
  taskFiles: ['src/payments.ts', 'src/stripe.ts', 'src/billing.ts'],
  taskType: 'implement', isVerification: false,
})
assert(spawn5.decision === 'spawn-fresh', 'low overlap → spawn-fresh')

// Broad research + narrow task → spawn fresh
const broadWorker: Worker = {
  id: 'w3', name: 'Broad', provider: 'claude', status: 'idle',
  contextFiles: Array.from({ length: 15 }, (_, i) => `src/file${i}.ts`),
  errorHistory: [], roundsCompleted: 10, createdAt: new Date(),
}
registerWorker(broadWorker)
const spawn6 = shouldContinueOrSpawn(broadWorker, {
  taskFiles: ['src/tiny.ts'], taskType: 'implement',
  isVerification: false,
})
assert(spawn6.decision === 'spawn-fresh', 'broad context + narrow task → spawn-fresh')

// selectWorker picks best match
const selected = selectWorker({
  taskFiles: ['src/auth.ts', 'src/user.ts'], taskType: 'implement',
  isVerification: false,
})
assert(selected !== null, 'selectWorker finds a match')
assert(selected!.reason.decision === 'continue', 'selectWorker picks continue worker')

// selectWorker returns null for verification
const selectedVerify = selectWorker({
  taskFiles: ['src/auth.ts'], taskType: 'verify',
  isVerification: true,
})
assert(selectedVerify === null, 'selectWorker returns null for verification')

// ============================================================
console.log('\n=== 18. P2-3: PARTIAL Verdict ===')
// ============================================================

const partialTask = createTask('Test partial', 'Has env-limited check', 'council')
approveTask(partialTask.id)
partialTask.checklist = [
  { id: 'chk-p1', description: 'Unit tests pass', checkCommand: 'echo "PASS"', type: 'auto', required: true },
  { id: 'chk-p2', description: 'E2E tests pass', checkCommand: 'echo "PASS"', type: 'auto', required: true },
]

// Mark one as partial (valid reason)
markCheckPartial(partialTask.id, 'chk-p2', 'No test framework available in CI environment', 'verifier')
const partialItem = partialTask.checklist.find(c => c.id === 'chk-p2')!
assert(partialItem.verdict === 'partial', 'check marked as partial')
assert(partialItem.partialReason!.includes('CI environment'), 'partial has reason')

// Invalid partial reason → throws
assertThrows(
  () => markCheckPartial(partialTask.id, 'chk-p1', 'I am not sure if it works', 'verifier'),
  'invalid partial reason rejected',
)

// Run checklist — partial items skipped, don't block allPassed
startTask(partialTask.id, 'exec-1')
submitForChecking(partialTask.id)
const partialResults = await runChecklist(partialTask.id, async () => ({
  passed: true, output: 'PASS: all good', exitCode: 0,
}))
assert(partialResults.allPassed, 'allPassed true when partial items skipped')
const partialResult = partialResults.results.find(r => r.item === 'E2E tests pass')!
assert(partialResult.verdict === 'partial', 'partial check in results')

// ============================================================
console.log('\n=== 19. P2-4: Prompt Cache Boundary ===')
// ============================================================

const cacheProgram = createSelfProgram('test cache', 'research')
const cachePrompt = buildExecutorPrompt(cacheProgram)
assert(cachePrompt.includes(PROMPT_CACHE_BOUNDARY), 'prompt contains cache boundary marker')

// Static part is before boundary
const parts = cachePrompt.split(PROMPT_CACHE_BOUNDARY)
assert(parts.length === 2, 'prompt splits into 2 parts at boundary')
assert(parts[0].includes('EXECUTOR'), 'static part has role definition')
assert(parts[0].includes('What You CANNOT Do'), 'static part has rules')
assert(parts[1].includes('RESEARCH'), 'dynamic part has current policy')
assert(parts[1].includes('test cache'), 'dynamic part has current goal')

// ============================================================
console.log('\n=== 20. P2-5: Dangerous Files/Dirs ===')
// ============================================================

// Sensitive files — blocked for read and write
assert(isDangerousPath('.env', 'read').dangerous, '.env blocked for read')
assert(isDangerousPath('.env.production', 'write').dangerous, '.env.production blocked for write')
assert(isDangerousPath('config/credentials.json', 'read').dangerous, 'credentials.json blocked')

// Dangerous files — blocked for write only
assert(isDangerousPath('.gitconfig', 'write').dangerous, '.gitconfig blocked for write')
assert(!isDangerousPath('.gitconfig', 'read').dangerous, '.gitconfig OK for read')
assert(isDangerousPath('.bashrc', 'write').dangerous, '.bashrc blocked for write')
assert(isDangerousPath('.zshrc', 'write').dangerous, '.zshrc blocked for write')
assert(isDangerousPath('package-lock.json', 'write').dangerous, 'package-lock.json blocked for write')

// Dangerous directories — blocked for write
assert(isDangerousPath('.git/config', 'write').dangerous, '.git/ blocked for write')
assert(!isDangerousPath('.git/config', 'read').dangerous, '.git/ OK for read')
assert(isDangerousPath('.vscode/settings.json', 'write').dangerous, '.vscode/ blocked for write')
assert(isDangerousPath('.claude/settings.json', 'write').dangerous, '.claude/ blocked for write')
assert(isDangerousPath('.github/workflows/ci.yml', 'write').dangerous, '.github/workflows/ blocked')

// Safe files
assert(!isDangerousPath('src/app.ts', 'write').dangerous, 'src/app.ts OK for write')
assert(!isDangerousPath('README.md', 'write').dangerous, 'README.md OK for write')

// Gate integration — executor blocked from writing dangerous files
const dangerGate = gate({
  tool: 'write', policy: 'explore', role: 'executor', callerId: 'test',
  filePath: '.git/config',
})
assert(!dangerGate.allowed, 'gate blocks writing to .git/')

// Council not blocked
const councilGate = gate({
  tool: 'write', policy: 'explore', role: 'council', callerId: 'council',
  filePath: '.git/config',
})
assert(councilGate.allowed, 'council can write .git/')

// ============================================================
console.log('\n=== 21. P2-6: File Locks ===')
// ============================================================

_resetLocks()

// Basic acquire/release
const lockOk = await acquireLock('results.tsv', 'exec-1')
assert(lockOk, 'acquired lock on results.tsv')
assert(getLockInfo('results.tsv')?.holder === 'exec-1', 'lock holder is exec-1')

// Same holder re-enter → OK
const reenter = await acquireLock('results.tsv', 'exec-1')
assert(reenter, 'same holder can re-enter lock')

// Different holder → fails (with minimal retries for speed)
const lockFail = await acquireLock('results.tsv', 'exec-2', { retries: 2, minTimeout: 1, maxTimeout: 2, staleTimeout: 10000 })
assert(!lockFail, 'different holder cannot acquire')

// Release
const released = releaseLock('results.tsv', 'exec-1')
assert(released, 'lock released')
assert(getLockInfo('results.tsv') === undefined, 'lock info cleared')

// Wrong holder cannot release
await acquireLock('task.json', 'exec-1')
const wrongRelease = releaseLock('task.json', 'exec-2')
assert(!wrongRelease, 'wrong holder cannot release')
forceReleaseLock('task.json')
assert(getLockInfo('task.json') === undefined, 'force release works')

// withLock pattern
let lockValue = 0
await withLock('counter', 'exec-1', async () => {
  lockValue = 42
})
assert(lockValue === 42, 'withLock executes function')
assert(getLockInfo('counter') === undefined, 'withLock releases after completion')

// withLock releases on error too
try {
  await withLock('error-resource', 'exec-1', async () => {
    throw new Error('boom')
  })
} catch { /* expected */ }
assert(getLockInfo('error-resource') === undefined, 'withLock releases on error')

// Stale lock auto-recovery
_resetLocks()
// Manually inject a stale lock
await acquireLock('stale-resource', 'dead-worker')
// Hack the timestamp to make it stale
const staleInfo = getLockInfo('stale-resource')!
;(staleInfo as any).acquiredAt = Date.now() - 20000  // 20s ago
const staleAcquire = await acquireLock('stale-resource', 'exec-new', { retries: 1, minTimeout: 1, maxTimeout: 1, staleTimeout: 10000 })
assert(staleAcquire, 'stale lock auto-recovered')
assert(getLockInfo('stale-resource')?.holder === 'exec-new', 'new holder after stale recovery')

// ============================================================
console.log('\n=== 22. BlockerAnalysis 验证 ===')
// ============================================================

// 合格的分析
const goodAnalysis: BlockerAnalysis = {
  what: 'npm install fails with EACCES permission denied on /usr/lib/node_modules',
  why: 'Global npm directory requires root access, but we run as non-root user',
  impact: 'Cannot install dependencies, blocks all subsequent build steps',
  possibleFixes: [
    { approach: 'Use --prefix to install locally', pros: 'No root needed', cons: 'Path setup required' },
    { approach: 'Change npm global dir to user space', pros: 'Permanent fix', cons: 'Affects other projects' },
  ],
  chosen: { approach: 'Use --prefix to install locally', reasoning: 'Non-invasive, scoped to this project' },
  analyzedAt: new Date(),
}
assert(validateBlockerAnalysis(goodAnalysis).valid, 'good analysis passes validation')

// what 太短
const shortWhat: BlockerAnalysis = { ...goodAnalysis, what: 'error' }
assert(!validateBlockerAnalysis(shortWhat).valid, 'short "what" rejected')

// why 太短
const shortWhy: BlockerAnalysis = { ...goodAnalysis, why: 'dunno' }
assert(!validateBlockerAnalysis(shortWhy).valid, 'short "why" rejected')

// why 是 what 的复读
const copyWhy: BlockerAnalysis = { ...goodAnalysis, why: goodAnalysis.what }
assert(!validateBlockerAnalysis(copyWhy).valid, '"why" copying "what" rejected')

// 没有 possibleFixes
const noFixes: BlockerAnalysis = { ...goodAnalysis, possibleFixes: [] }
assert(!validateBlockerAnalysis(noFixes).valid, 'no possible fixes rejected')

// ============================================================
console.log('\n=== 23. Blocked Escalation 需要分析 ===')
// ============================================================

const blockerProgram = createSelfProgram('test blocker')

// blocked 类型没有 analysis → throw
assertThrows(
  () => escalate(blockerProgram, 'blocked', 'something failed',
    [{ action: 'tried X', result: 'failed' }]),
  'blocked escalation without analysis throws',
)

// blocked 类型有敷衍分析 → throw
assertThrows(
  () => escalate(blockerProgram, 'blocked', 'something failed',
    [{ action: 'tried X', result: 'failed' }],
    {},
    shortWhat),
  'blocked escalation with bad analysis throws',
)

// blocked 类型有合格分析 → OK
const blockedEsc = escalate(blockerProgram, 'blocked', 'npm install failed',
  [{ action: 'tried local install', result: 'still permission error' }],
  { error: 'EACCES' },
  goodAnalysis,
)
assert(blockedEsc.type === 'blocked', 'blocked escalation with good analysis succeeds')
assert(blockedEsc.analysis !== undefined, 'escalation has analysis attached')
assert(blockedEsc.analysis!.possibleFixes.length === 2, 'analysis has 2 fixes')

// 其他类型不需要 analysis（保持兼容）
const otherEsc = escalate(blockerProgram, 'unexpected-result', 'weird output',
  [{ action: 'checked logs', result: 'no clue' }])
assert(otherEsc.type === 'unexpected-result', 'non-blocked escalation still works without analysis')

// ============================================================
console.log('\n=== 24. Executor Prompt 包含分析流程 ===')
// ============================================================

const analyzePrompt = buildExecutorPrompt(createSelfProgram('test analyze'))
assert(analyzePrompt.includes('ANALYZE FIRST'), 'prompt has analyze-first principle')
assert(analyzePrompt.includes('Step 1: ANALYZE'), 'prompt has step 1')
assert(analyzePrompt.includes('Step 4: FIX'), 'prompt has step 4')
assert(analyzePrompt.includes('NEVER skip to Step 4'), 'prompt warns against skipping analysis')
assert(analyzePrompt.includes('NEVER blindly retry'), 'prompt warns against blind retry')

// ============================================================
console.log('\n=== 25. Checklist 全完成 ===')
// ============================================================

import { getChecklistStats, CHECKLIST } from '../src/checklist.js'
const stats = getChecklistStats()
const allDone = CHECKLIST.every(item => item.status === 'done')
assert(allDone, `all checklist items done: ${stats}`)

// ============================================================
// Summary
// ============================================================

console.log(`\n${'='.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`)
console.log(`${'='.repeat(50)}`)

if (failed > 0) {
  process.exit(1)
}
