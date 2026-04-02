/**
 * Council Runner — wire council voting into the autopilot loop
 *
 * This is the bridge between council.ts (voting logic) and runner.ts (CLI execution).
 *
 * When the loop escalates, this module:
 *   1. Collects votes from all AI council members via their CLIs
 *   2. Waits for human vote (with timeout)
 *   3. Resolves the vote using council.ts weighted voting
 *   4. Returns the decision
 *
 * Council members:
 *   - Human (you) — weight 3.0, veto power, votes via config or skip (timeout)
 *   - Claude Code — weight 1.0, votes by analyzing the escalation
 *   - Codex — weight 1.0, votes as devil's advocate (adversarial review)
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AutopilotConfig, VoterConfig } from './config.js'
import type { Vote, DecisionContext, DecisionResult } from './council.js'
import { resolveVotes, getVoters, registerVoter } from './council.js'
import { executeViaCLI } from './runner.js'
import { buildVotePrompt, buildPolicyVotePrompt } from './council.js'
import type { Escalation } from './selfProgram.js'
import { buildEscalationContext } from './council.js'

// ============================================================
// Collect a vote from an AI agent via CLI
// ============================================================

async function collectAIVote(
  voter: VoterConfig,
  context: DecisionContext,
  cwd: string,
): Promise<Vote | null> {
  if (!voter.command) return null

  // Always use buildVotePrompt — it requires explicit approve/reject/needs-info
  // buildPolicyVotePrompt outputs a different format (policy choice, no action field)
  // which causes votes to default to abstain
  const prompt = buildVotePrompt(context)

  try {
    const result = await executeViaCLI(voter, prompt, cwd)

    if (result.exitCode !== 0) {
      console.log(`  [council] ${voter.name} failed to respond (exit ${result.exitCode})`)
      return null
    }

    // Parse JSON vote from output
    const jsonMatch = result.stdout.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      console.log(`  [council] ${voter.name} response not parseable`)
      return null
    }

    const parsed = JSON.parse(jsonMatch[0])

    return {
      voterId: voter.id,
      // AI cannot abstain — force to approve if invalid action
      action: ['approve', 'reject', 'needs-info'].includes(parsed.action)
        ? parsed.action
        : 'approve',
      score: parsed.score,
      reasoning: parsed.reasoning ?? '',
      synthesis: parsed.synthesis,
      info: parsed.info,
      suggestion: parsed.suggestion,
      confidence: parsed.confidence ?? 0.5,
      timestamp: new Date(),
    }
  } catch (err: any) {
    console.log(`  [council] ${voter.name} error: ${err.message}`)
    // AI failed to respond — default to approve (continue), not silence
    return {
      voterId: voter.id,
      action: 'approve' as const,
      reasoning: `${voter.name} failed to respond, defaulting to approve.`,
      confidence: 0.3,
      timestamp: new Date(),
    }
  }
}

// ============================================================
// Collect human vote (non-interactive — read from file or timeout)
// ============================================================

function collectHumanVote(
  config: AutopilotConfig,
): Vote {
  // Human does NOT vote in real-time. AI council decides autonomously.
  // Decision is recorded and sent to human for post-hoc review via CLI/IM.
  const humanVoter = config.voters.find(v => v.type === 'human')

  return {
    voterId: humanVoter?.id ?? 'human',
    action: 'abstain',
    reasoning: 'AI council decides autonomously. Human reviews post-hoc.',
    confidence: 0,
    timestamp: new Date(),
  }
}

// ============================================================
// Run a full council vote
// ============================================================

export async function runCouncilVote(
  context: DecisionContext,
  config: AutopilotConfig,
): Promise<DecisionResult> {
  console.log(`\n--- Council Vote: ${context.type} ---`)
  console.log(`${context.description}\n`)

  // Sync voters from config to council.ts
  for (const v of config.voters) {
    registerVoter({
      id: v.id,
      name: v.name,
      type: v.type,
      provider: v.provider,
      weight: v.weight,
      trustScore: v.trustScore,
      capabilities: v.capabilities,
    })
  }

  const votes: Vote[] = []

  // 1. Collect AI votes in parallel
  const aiVoters = config.voters.filter(v => v.type === 'agent' && v.command)
  console.log(`Collecting votes from ${aiVoters.length} AI member(s)...`)

  const aiVotePromises = aiVoters.map(async (voter) => {
    console.log(`  [council] Asking ${voter.name}...`)
    const vote = await collectAIVote(voter, context, config.projectDir)
    if (vote) {
      console.log(`  [council] ${voter.name}: ${vote.action} (score: ${vote.score ?? 'N/A'}, confidence: ${vote.confidence})`)
    }
    return vote
  })

  const aiResults = await Promise.all(aiVotePromises)
  for (const vote of aiResults) {
    if (vote) votes.push(vote)
  }

  // 2. Human does not participate in real-time — will review post-hoc
  const humanVote = collectHumanVote(config)
  votes.push(humanVote)

  // 3. Resolve
  const result = resolveVotes(context, votes, true)

  console.log(`\n  Decision: ${result.decision}`)
  console.log(`  Weighted score: ${result.weightedScore}`)
  console.log(`  Reasoning: ${result.reasoning}`)
  if (result.humanOverride) {
    console.log(`  (Human override applied)`)
  }
  console.log(`--- End Vote ---\n`)

  // Record decision for human post-hoc review
  const record = {
    timestamp: new Date().toISOString(),
    type: context.type,
    description: context.description,
    decision: result.decision,
    weightedScore: result.weightedScore,
    reasoning: result.reasoning,
    votes: result.votes.map(v => ({
      voter: v.voterId,
      action: v.action,
      score: v.score,
      confidence: v.confidence,
      reasoning: v.reasoning?.slice(0, 200),
    })),
    humanReview: 'pending',
  }

  try {
    const logPath = join(config.projectDir, 'council-decisions.jsonl')
    appendFileSync(logPath, JSON.stringify(record) + '\n', 'utf-8')
  } catch { /* ignore write errors */ }

  return result
}

// ============================================================
// Handle escalation — convert escalation to council decision
// ============================================================

export async function handleEscalation(
  escalation: Escalation,
  currentPolicy: string,
  roundsCompleted: number,
  config: AutopilotConfig,
): Promise<{
  action: 'continue' | 'switch-policy' | 'stop'
  newPolicy?: string
  instructions?: string
  maxRounds?: number
}> {
  const context = buildEscalationContext(
    { type: escalation.type, description: escalation.description, context: escalation.context },
    currentPolicy,
    roundsCompleted,
  )

  const result = await runCouncilVote(context, config)

  // Interpret council decision
  if (result.decision === 'reject') {
    return { action: 'stop' }
  }

  if (result.decision === 'needs-info') {
    // Council needs more info — continue with research
    return {
      action: 'switch-policy',
      newPolicy: 'research',
      instructions: result.reasoning,
    }
  }

  // Check if any voter suggested a policy change
  for (const vote of result.votes) {
    if (vote.suggestion) {
      try {
        const parsed = JSON.parse(vote.suggestion)
        if (parsed.policy) {
          return {
            action: 'switch-policy',
            newPolicy: parsed.policy,
            instructions: parsed.instructions,
            maxRounds: parsed.maxRounds,
          }
        }
      } catch {
        // Not JSON — treat suggestion as instructions
        if (['research', 'analyze', 'explore', 'exploit', 'consolidate'].includes(vote.suggestion)) {
          return {
            action: 'switch-policy',
            newPolicy: vote.suggestion,
          }
        }
      }
    }
  }

  // No explicit policy suggestion — auto-advance to next phase
  // research → explore → exploit → consolidate
  const POLICY_PROGRESSION: Record<string, string> = {
    'research': 'explore',
    'analyze': 'explore',
    'explore': 'exploit',
    'exploit': 'consolidate',
    'consolidate': 'consolidate', // stay — final phase
  }

  const nextPolicy = POLICY_PROGRESSION[currentPolicy]
  if (nextPolicy && nextPolicy !== currentPolicy) {
    return {
      action: 'switch-policy',
      newPolicy: nextPolicy,
    }
  }

  // Already at final phase — continue
  return { action: 'continue' }
}
