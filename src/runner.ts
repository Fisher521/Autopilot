/**
 * Runner — bridge between loop.ts and CLI tools (claude / codex)
 *
 * Core idea: CC Max subscribers have unlimited CLI usage but no API.
 * This module spawns CLI processes to execute tasks and collect results.
 *
 * Key functions:
 *   - executeViaCLI: spawn claude --print with a prompt, return output
 *   - extractMetricsViaCLI: run metric extraction commands
 *   - checkConstraintsViaCLI: run constraint check commands
 *   - reviewViaCLI: spawn codex for adversarial review
 */

import { spawn } from 'node:child_process'
import type { AutopilotConfig, VoterConfig } from './config.js'
import type { Metric, Constraint } from './selfProgram.js'

// ============================================================
// Core: spawn a CLI and capture output
// ============================================================

export interface CLIResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
}

/**
 * Spawn a CLI command and capture full output
 *
 * This is the foundation — claude --print and codex both go through here.
 */
export function spawnCLI(
  command: string,
  args: string[],
  options?: {
    cwd?: string
    timeoutMs?: number
    env?: Record<string, string>
    stdin?: string
  },
): Promise<CLIResult> {
  return new Promise((resolve) => {
    const start = Date.now()
    const timeout = options?.timeoutMs ?? 900_000 // 15 min default

    const proc = spawn(command, args, {
      cwd: options?.cwd,
      env: { ...process.env, ...options?.env },
      stdio: [options?.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      shell: false,
    })

    if (options?.stdin && proc.stdin) {
      proc.stdin.write(options.stdin)
      proc.stdin.end()
    }

    let stdout = ''
    let stderr = ''

    proc.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      resolve({
        stdout,
        stderr: stderr + '\n[TIMEOUT after ' + timeout + 'ms]',
        exitCode: 124,
        durationMs: Date.now() - start,
      })
    }, timeout)

    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        durationMs: Date.now() - start,
      })
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({
        stdout,
        stderr: err.message,
        exitCode: 127,
        durationMs: Date.now() - start,
      })
    })
  })
}

// ============================================================
// Execute a task via Claude Code CLI
// ============================================================

/**
 * Run a prompt through an agent's CLI
 *
 * For Claude Code: claude --print --dangerously-skip-permissions "prompt"
 * For Codex: codex --quiet "prompt"
 */
export async function executeViaCLI(
  voter: VoterConfig,
  prompt: string,
  cwd: string,
  timeoutMs?: number,
): Promise<CLIResult> {
  if (!voter.command) {
    throw new Error(`Voter "${voter.name}" has no CLI command configured`)
  }

  // Pass prompt via stdin instead of args to avoid shell escaping issues
  const args = (voter.args ?? ['{prompt}']).filter(a => a !== '{prompt}')

  return spawnCLI(voter.command, args, { cwd, stdin: prompt, timeoutMs })
}

// ============================================================
// Extract metrics by running shell commands
// ============================================================

export async function extractMetricsViaCLI(
  metrics: Metric[],
  cwd: string,
): Promise<Record<string, number>> {
  const results: Record<string, number> = {}

  for (const metric of metrics) {
    if (!metric.extractCommand) continue

    const result = await spawnCLI('sh', ['-c', metric.extractCommand], { cwd, timeoutMs: 30_000 })

    if (metric.direction === 'pass-fail') {
      // pass-fail: only care about exit code, normalize to 0 or 1
      results[metric.name] = result.exitCode === 0 ? 1 : 0
    } else if (result.exitCode === 0) {
      const value = parseFloat(result.stdout.trim())
      if (!isNaN(value)) {
        results[metric.name] = value
      }
    }
  }

  return results
}

// ============================================================
// Check constraints by running shell commands
// ============================================================

export async function checkConstraintsViaCLI(
  constraints: Constraint[],
  cwd: string,
): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {}

  for (const constraint of constraints) {
    if (!constraint.checkCommand) continue

    const result = await spawnCLI('sh', ['-c', constraint.checkCommand], { cwd, timeoutMs: 30_000 })
    results[constraint.description] = result.exitCode === 0
  }

  return results
}

// ============================================================
// Review via a second AI (adversarial)
// ============================================================

export async function reviewViaCLI(
  reviewer: VoterConfig,
  diff: string,
  cwd: string,
): Promise<{ review: string; exitCode: number }> {
  const prompt = `Review this code change. Be critical — find problems, edge cases, and suggest improvements.
Focus on: correctness, security, performance, maintainability.

\`\`\`diff
${diff}
\`\`\`

Output your review as structured JSON:
{
  "action": "approve" | "reject" | "needs-info",
  "score": 0-10,
  "confidence": 0-1,
  "reasoning": "...",
  "issues": ["issue1", "issue2"],
  "suggestion": "..."
}`

  const result = await executeViaCLI(reviewer, prompt, cwd)

  return {
    review: result.stdout,
    exitCode: result.exitCode,
  }
}

// ============================================================
// Check if a CLI tool is available
// ============================================================

export async function isCLIAvailable(command: string): Promise<boolean> {
  const result = await spawnCLI('which', [command], { timeoutMs: 5_000 })
  return result.exitCode === 0
}

// ============================================================
// Build LoopConfig from AutopilotConfig
// ============================================================

import type { LoopConfig } from './loop.js'
import type { SelfProgram } from './selfProgram.js'
import { recordRound } from './tracker.js'
import { join } from 'node:path'
import { buildExecutorPrompt } from './selfProgram.js'

export function buildLoopConfig(
  program: SelfProgram,
  config: AutopilotConfig,
): LoopConfig {
  const claudeVoter = config.voters.find(v => v.provider === 'claude')
  if (!claudeVoter) {
    throw new Error('No Claude voter configured — need at least one AI executor')
  }

  const resultsPath = join(config.projectDir, config.resultsFile)

  return {
    program,

    // Execute via Claude Code CLI
    execute: async (instructions: string, round: number) => {
      const prompt = buildExecutorPrompt(program)
      const fullPrompt = `${prompt}\n\n## Round ${round}\n${instructions}`

      if (config.verbose) {
        console.log(`\n[round ${round}] Executing via ${claudeVoter.name}...`)
      }

      const result = await executeViaCLI(claudeVoter, fullPrompt, config.projectDir, config.cliTimeout * 1000)

      if (result.exitCode !== 0) {
        throw new Error(`CLI exited with code ${result.exitCode}: ${result.stderr}`)
      }

      return result.stdout
    },

    // Extract metrics by running their commands
    extractMetrics: async (metrics: Metric[]) => {
      return extractMetricsViaCLI(metrics, config.projectDir)
    },

    // Check constraints by running their commands
    checkConstraints: async (constraints: Constraint[]) => {
      return checkConstraintsViaCLI(constraints, config.projectDir)
    },

    // Keep — record to results.tsv
    onKeep: async (round: number, score: number, details: string[]) => {
      if (config.verbose) {
        console.log(`  [round ${round}] ✓ KEEP (score: ${score.toFixed(2)})`)
      }
      await recordRound(resultsPath, {
        round,
        policy: program.currentPolicy.type,
        score,
        kept: true,
        details: details.join('; '),
        timestamp: new Date(),
      })
    },

    // Discard — record to results.tsv
    onDiscard: async (round: number, reason: string) => {
      if (config.verbose) {
        console.log(`  [round ${round}] ✗ DISCARD: ${reason}`)
      }
      await recordRound(resultsPath, {
        round,
        policy: program.currentPolicy.type,
        score: 0,
        kept: false,
        details: reason,
        timestamp: new Date(),
      })
    },

    // Escalate — log and pause
    onEscalate: async (escalation) => {
      console.log(`\n⚡ ESCALATION: [${escalation.type}] ${escalation.description}`)
      if (escalation.analysis) {
        console.log(`  Analysis: ${escalation.analysis.what}`)
        console.log(`  Root cause: ${escalation.analysis.why}`)
      }
    },

    // Round end notification
    onRoundEnd: async (round: number, status: string) => {
      if (config.verbose) {
        console.log(`  [round ${round}] ${status}`)
      }
    },

    maxConsecutiveFailures: config.maxConsecutiveFailures,
  }
}
