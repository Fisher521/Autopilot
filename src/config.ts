/**
 * Configuration — all settings from file + env, zero hardcoded personal info
 *
 * Load order:
 *   1. Built-in defaults
 *   2. autopilot.config.json (project-level)
 *   3. Environment variables (override everything)
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { PolicyType } from './selfProgram.js'

// ============================================================
// Types
// ============================================================

export interface VoterConfig {
  id: string
  name: string
  type: 'human' | 'agent'
  provider?: 'claude' | 'codex' | 'openclaw'
  weight: number
  trustScore: number
  /** CLI command to invoke this agent (e.g. "claude" or "codex") */
  command?: string
  /** CLI args template — {prompt} will be replaced */
  args?: string[]
  capabilities: string[]
}

export interface AutopilotConfig {
  /** Project goal — what are we optimizing? */
  goal: string
  /** Starting policy */
  startPolicy: PolicyType
  /** Target project directory (where to run) */
  projectDir: string
  /** Council voters */
  voters: VoterConfig[]
  /** Max consecutive failures before escalation */
  maxConsecutiveFailures: number
  /** Human vote timeout in seconds (0 = no timeout, AI decides) */
  humanVoteTimeout: number
  /** CLI execution timeout in seconds (default 900 = 15 min) */
  cliTimeout: number
  /** Results file path */
  resultsFile: string
  /** State file path (for persistence across runs) */
  stateFile: string
  /** Verbose logging */
  verbose: boolean
}

// ============================================================
// Defaults — no personal info, all configurable
// ============================================================

const DEFAULT_CONFIG: AutopilotConfig = {
  goal: '',
  startPolicy: 'research',
  projectDir: process.cwd(),
  cliTimeout: 900,
  voters: [
    {
      id: 'human',
      name: process.env.AUTOPILOT_USER_NAME ?? 'Human',
      type: 'human',
      weight: 3.0,
      trustScore: 1.0,
      capabilities: ['direction', 'context', 'business-logic', 'final-call'],
    },
    {
      id: 'claude',
      name: 'Claude Code',
      type: 'agent',
      provider: 'claude',
      weight: 1.0,
      trustScore: 0.85,
      command: 'claude',
      args: ['--print', '--dangerously-skip-permissions', '{prompt}'],
      capabilities: ['code-quality', 'architecture', 'security', 'implementation'],
    },
    {
      id: 'codex',
      name: 'Codex',
      type: 'agent',
      provider: 'codex',
      weight: 1.0,
      trustScore: 0.80,
      command: 'codex',
      args: ['exec', '--full-auto', '{prompt}'],
      capabilities: ['code-review', 'alternative-approaches', 'edge-cases'],
    },
  ],
  maxConsecutiveFailures: 3,
  humanVoteTimeout: 300,
  resultsFile: 'results.tsv',
  stateFile: '.autopilot-state.json',
  verbose: false,
}

// ============================================================
// Config file name
// ============================================================

const CONFIG_FILE = 'autopilot.config.json'

// ============================================================
// Load
// ============================================================

export function loadConfig(projectDir?: string): AutopilotConfig {
  const dir = projectDir ?? process.cwd()
  const config = structuredClone(DEFAULT_CONFIG)
  config.projectDir = dir

  // 1. Read config file
  const configPath = join(dir, CONFIG_FILE)
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
      Object.assign(config, raw)
    } catch (err: any) {
      console.error(`Warning: failed to parse ${CONFIG_FILE}: ${err.message}`)
    }
  }

  // 2. Env overrides
  if (process.env.AUTOPILOT_USER_NAME) {
    const human = config.voters.find(v => v.type === 'human')
    if (human) human.name = process.env.AUTOPILOT_USER_NAME
  }
  if (process.env.AUTOPILOT_GOAL) {
    config.goal = process.env.AUTOPILOT_GOAL
  }
  if (process.env.AUTOPILOT_VERBOSE === '1') {
    config.verbose = true
  }
  if (process.env.AUTOPILOT_CLAUDE_CMD) {
    const claude = config.voters.find(v => v.provider === 'claude')
    if (claude) claude.command = process.env.AUTOPILOT_CLAUDE_CMD
  }
  if (process.env.AUTOPILOT_CODEX_CMD) {
    const codex = config.voters.find(v => v.provider === 'codex')
    if (codex) codex.command = process.env.AUTOPILOT_CODEX_CMD
  }

  return config
}

// ============================================================
// Init — generate default config file
// ============================================================

export function initConfig(projectDir: string, goal: string): string {
  const configPath = join(projectDir, CONFIG_FILE)

  if (existsSync(configPath)) {
    return `${CONFIG_FILE} already exists at ${configPath}`
  }

  const config = {
    goal,
    startPolicy: 'research',
    maxConsecutiveFailures: 3,
    humanVoteTimeout: 300,
    verbose: false,
    voters: [
      {
        id: 'human',
        name: 'Human',
        type: 'human',
        weight: 3.0,
        trustScore: 1.0,
        capabilities: ['direction', 'context', 'business-logic', 'final-call'],
      },
      {
        id: 'claude',
        name: 'Claude Code',
        type: 'agent',
        provider: 'claude',
        weight: 1.0,
        trustScore: 0.85,
        command: 'claude',
        args: ['--print', '--dangerously-skip-permissions', '{prompt}'],
        capabilities: ['code-quality', 'architecture', 'security', 'implementation'],
      },
      {
        id: 'codex',
        name: 'Codex',
        type: 'agent',
        provider: 'codex',
        weight: 1.0,
        trustScore: 0.80,
        command: 'codex',
        args: ['exec', '--full-auto', '{prompt}'],
        capabilities: ['code-review', 'alternative-approaches', 'edge-cases'],
      },
    ],
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
  return `Created ${configPath}`
}

// ============================================================
// Detect available CLIs
// ============================================================

export function detectCLIs(): Array<{ id: string; command: string; available: boolean }> {
  const results: Array<{ id: string; command: string; available: boolean }> = []

  for (const cli of [
    { id: 'claude', command: 'claude' },
    { id: 'codex', command: 'codex' },
  ]) {
    const r = spawnSync('which', [cli.command], { stdio: 'ignore' })
    results.push({ ...cli, available: r.status === 0 })
  }

  return results
}
