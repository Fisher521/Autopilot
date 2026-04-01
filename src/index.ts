#!/usr/bin/env node

/**
 * Autopilot CLI — autonomous AI loop engine
 *
 * Commands:
 *   init    — create autopilot.config.json in current project
 *   run     — start the optimization loop
 *   status  — show current state and results summary
 *   check   — verify CLI dependencies are available
 *
 * Requirements:
 *   - Claude Code CLI (claude) — CC Max subscription, no API key needed
 *   - Codex CLI (codex) — optional, for adversarial review
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadConfig, initConfig, detectCLIs } from './config.js'
import { createSelfProgram, renderStatus, type SelfProgram } from './selfProgram.js'
import { runLoop } from './loop.js'
import { buildLoopConfig } from './runner.js'
import { initResultsFile, summarizeResults } from './tracker.js'

const program = new Command()

program
  .name('autopilot')
  .description('Autonomous AI loop engine — multi-AI council + policy-driven execution')
  .version('0.1.0')

// ============================================================
// init — create config file
// ============================================================

program
  .command('init')
  .description('Initialize autopilot in the current project')
  .argument('[goal]', 'Project goal (what to optimize)')
  .action(async (goal?: string) => {
    const cwd = process.cwd()

    if (!goal) {
      console.log(chalk.yellow('Usage: autopilot init "your goal here"'))
      console.log(chalk.gray('Example: autopilot init "Improve page load time to under 2 seconds"'))
      process.exit(1)
    }

    const result = initConfig(cwd, goal)
    console.log(chalk.green(result))

    // Check available CLIs
    console.log('\nChecking available AI CLIs...')
    const clis = detectCLIs()
    for (const cli of clis) {
      const icon = cli.available ? chalk.green('✓') : chalk.red('✗')
      const note = cli.available ? '' : chalk.gray(' (optional)')
      console.log(`  ${icon} ${cli.command}${note}`)
    }

    const hasClaude = clis.find(c => c.id === 'claude')?.available
    if (!hasClaude) {
      console.log(chalk.yellow('\nWarning: Claude Code CLI not found.'))
      console.log(chalk.gray('Install it: https://claude.ai/code'))
      console.log(chalk.gray('Autopilot requires Claude Code CLI to execute tasks.'))
    } else {
      console.log(chalk.green('\nReady! Run `autopilot run` to start.'))
    }
  })

// ============================================================
// run — start the loop
// ============================================================

program
  .command('run')
  .description('Start the autopilot optimization loop')
  .option('-v, --verbose', 'Verbose output')
  .option('-n, --max-rounds <n>', 'Override max rounds for current policy', parseInt)
  .action(async (opts) => {
    const config = loadConfig()

    if (!config.goal) {
      console.log(chalk.red('No goal configured. Run `autopilot init "your goal"` first.'))
      process.exit(1)
    }

    if (opts.verbose) config.verbose = true

    // Init results file
    const resultsPath = join(config.projectDir, config.resultsFile)
    initResultsFile(resultsPath)

    // Load or create state
    const statePath = join(config.projectDir, config.stateFile)
    let state: SelfProgram

    if (existsSync(statePath)) {
      try {
        const raw = JSON.parse(readFileSync(statePath, 'utf-8'))
        state = {
          ...raw,
          currentPolicy: {
            ...raw.currentPolicy,
            setAt: new Date(raw.currentPolicy.setAt),
          },
          policyHistory: raw.policyHistory.map((p: any) => ({
            ...p,
            setAt: new Date(p.setAt),
          })),
          escalations: raw.escalations.map((e: any) => ({
            ...e,
            timestamp: new Date(e.timestamp),
          })),
        }
        console.log(chalk.gray(`Resuming from saved state (round ${state.roundsOnCurrentPolicy}, policy: ${state.currentPolicy.type})`))
      } catch {
        state = createSelfProgram(config.goal, config.startPolicy)
      }
    } else {
      state = createSelfProgram(config.goal, config.startPolicy)
    }

    if (opts.maxRounds) {
      state.currentPolicy.maxRounds = opts.maxRounds
    }

    console.log(chalk.bold(`\nAutopilot: ${config.goal}`))
    console.log(chalk.gray(`Policy: ${state.currentPolicy.type} | Dir: ${config.projectDir}`))
    console.log()

    // Build loop config and run
    const loopConfig = buildLoopConfig(state, config)

    try {
      const result = await runLoop(loopConfig)

      // Save state
      writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8')

      // Report
      console.log(chalk.bold('\n--- Loop Complete ---'))
      console.log(`Rounds: ${result.rounds}`)
      console.log(`Kept: ${result.kept} | Discarded: ${result.discarded}`)

      if (result.escalated) {
        console.log(chalk.yellow(`\nEscalated: ${result.escalationReason}`))
        console.log(chalk.gray('The council needs to decide the next policy.'))
        console.log(chalk.gray('Edit autopilot.config.json or run `autopilot run` after adjusting.'))
      }
    } catch (err: any) {
      console.error(chalk.red(`\nError: ${err.message}`))

      // Save state even on error
      writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8')
      process.exit(1)
    }
  })

// ============================================================
// status — show current state
// ============================================================

program
  .command('status')
  .description('Show current autopilot state and results summary')
  .action(async () => {
    const config = loadConfig()

    if (!config.goal) {
      console.log(chalk.gray('Not initialized. Run `autopilot init "your goal"` first.'))
      process.exit(0)
    }

    // State
    const statePath = join(config.projectDir, config.stateFile)
    if (existsSync(statePath)) {
      try {
        const raw = JSON.parse(readFileSync(statePath, 'utf-8'))
        const state = createSelfProgram(raw.goal ?? config.goal, raw.currentPolicy?.type)
        Object.assign(state, raw)
        console.log(renderStatus(state))
      } catch {
        console.log(chalk.gray('No saved state.'))
      }
    } else {
      console.log(`Goal: ${config.goal}`)
      console.log(chalk.gray('Not started yet. Run `autopilot run` to begin.'))
    }

    // Results
    const resultsPath = join(config.projectDir, config.resultsFile)
    if (existsSync(resultsPath)) {
      console.log(chalk.bold('\n--- Results ---'))
      console.log(summarizeResults(resultsPath))
    }
  })

// ============================================================
// check — verify dependencies
// ============================================================

program
  .command('check')
  .description('Check that required CLI tools are available')
  .action(async () => {
    console.log('Checking AI CLI dependencies...\n')
    const clis = detectCLIs()

    for (const cli of clis) {
      const icon = cli.available ? chalk.green('✓') : chalk.red('✗')
      const status = cli.available ? 'available' : 'not found'
      console.log(`  ${icon} ${cli.command} — ${status}`)
    }

    const hasClaude = clis.find(c => c.id === 'claude')?.available
    if (!hasClaude) {
      console.log(chalk.yellow('\nClaude Code CLI is required.'))
      console.log(chalk.gray('Get it at: https://claude.ai/code'))
      process.exit(1)
    }

    const hasCodex = clis.find(c => c.id === 'codex')?.available
    if (!hasCodex) {
      console.log(chalk.gray('\nCodex CLI not found (optional — used for adversarial review).'))
    }

    console.log(chalk.green('\nAll required dependencies available.'))
  })

// ============================================================
// Parse and run
// ============================================================

program.parse()
