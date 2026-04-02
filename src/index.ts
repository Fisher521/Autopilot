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
import { detectProjectInfo, generateProposal, formatProposal } from './discover.js'
import { handleEscalation } from './councilRunner.js'
import { switchPolicy, type PolicyType } from './selfProgram.js'

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
  .option('--skip-discover', 'Skip auto-discovery, create minimal config')
  .action(async (goal: string | undefined, opts: { skipDiscover?: boolean }) => {
    const cwd = process.cwd()

    if (!goal) {
      console.log(chalk.yellow('Usage: autopilot init "your goal here"'))
      console.log(chalk.gray('Example: autopilot init "Improve page load time to under 2 seconds"'))
      process.exit(1)
    }

    // 1. Check CLIs
    const clis = detectCLIs()
    const hasClaude = clis.find(c => c.id === 'claude')?.available

    console.log('Checking AI CLIs...')
    for (const cli of clis) {
      const icon = cli.available ? chalk.green('✓') : chalk.red('✗')
      console.log(`  ${icon} ${cli.command}`)
    }

    if (!hasClaude) {
      console.log(chalk.red('\nClaude Code CLI required. Install: https://claude.ai/code'))
      process.exit(1)
    }

    // 2. Detect project
    console.log('\nAnalyzing project...')
    const info = detectProjectInfo(cwd)

    if (info.hasCode) {
      console.log(chalk.green(`  Found: ${info.techStack.join(', ') || 'code project'}`))
      if (info.dataSource) console.log(chalk.green(`  Data: ${info.dataSource}`))
      if (info.hasTests) console.log(chalk.green(`  Tests: detected`))
    } else {
      console.log(chalk.gray('  New project (no code detected)'))
    }

    // 3. Generate proposal
    if (info.hasCode && !opts.skipDiscover) {
      console.log('\nClaude is analyzing your project and proposing metrics...')

      const config = loadConfig(cwd)
      const claudeVoter = config.voters.find(v => v.provider === 'claude')

      if (claudeVoter) {
        const proposal = await generateProposal(goal, cwd, claudeVoter)

        // Show proposal
        console.log('\n' + formatProposal(proposal))

        // Save config with proposed metrics/constraints
        const configResult = initConfig(cwd, goal)

        // Update config file with proposal data
        const configPath = join(cwd, 'autopilot.config.json')
        if (existsSync(configPath)) {
          const existing = JSON.parse(readFileSync(configPath, 'utf-8'))
          existing.goal = goal
          existing.startPolicy = proposal.startPolicy
          if (proposal.metrics.length > 0) {
            existing.metrics = proposal.metrics
          }
          if (proposal.constraints.length > 0) {
            existing.constraints = proposal.constraints
          }
          existing._proposal = {
            reasoning: proposal.reasoning,
            techStack: proposal.projectInfo.techStack,
            generatedAt: new Date().toISOString(),
            status: 'pending_council_approval',
          }
          writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
        }

        console.log(chalk.yellow('\nProposal saved. Council should review before running.'))
        console.log(chalk.gray('Review: autopilot.config.json'))
        console.log(chalk.gray('Then: autopilot run'))
      }
    } else {
      // Minimal config for new project
      const result = initConfig(cwd, goal)
      console.log(chalk.green('\n' + result))
      console.log(chalk.gray('Metrics will be discovered during research phase.'))
      console.log(chalk.green('Run `autopilot run` to start.'))
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

    // Main loop — runs until council says stop or max retries
    let totalRounds = 0
    let totalKept = 0
    let totalDiscarded = 0
    const MAX_COUNCIL_ROUNDS = 5  // max policy switches per run

    for (let councilRound = 0; councilRound < MAX_COUNCIL_ROUNDS; councilRound++) {
      const loopConfig = buildLoopConfig(state, config)

      try {
        const result = await runLoop(loopConfig)
        totalRounds += result.rounds
        totalKept += result.kept
        totalDiscarded += result.discarded

        // Save state after each loop
        writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8')

        if (!result.escalated) {
          // Loop ended without escalation — done
          break
        }

        // Escalation — convene the council
        console.log(chalk.yellow(`\nEscalation: ${result.escalationReason}`))
        console.log(chalk.bold('Convening council...'))

        const lastEscalation = state.escalations[state.escalations.length - 1]
        if (!lastEscalation) break

        const decision = await handleEscalation(
          lastEscalation,
          state.currentPolicy.type,
          state.roundsOnCurrentPolicy,
          config,
        )

        if (decision.action === 'stop') {
          console.log(chalk.red('Council decided: STOP'))
          break
        }

        if (decision.action === 'switch-policy' && decision.newPolicy) {
          console.log(chalk.green(`Council decided: switch to ${decision.newPolicy}`))
          state = switchPolicy(
            state,
            decision.newPolicy as PolicyType,
            'council',
            {
              instructions: decision.instructions,
              maxRounds: decision.maxRounds,
            },
          )
          // Continue outer loop — will run again with new policy
        } else {
          // Continue with same policy (reset rounds)
          state.roundsOnCurrentPolicy = 0
          state.escalations = []
        }

        // Save updated state
        writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8')

      } catch (err: any) {
        console.error(chalk.red(`\nError: ${err.message}`))
        writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8')
        process.exit(1)
      }
    }

    // Final report
    console.log(chalk.bold('\n--- Run Complete ---'))
    console.log(`Total rounds: ${totalRounds}`)
    console.log(`Kept: ${totalKept} | Discarded: ${totalDiscarded}`)
    console.log(`Final policy: ${state.currentPolicy.type}`)
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
