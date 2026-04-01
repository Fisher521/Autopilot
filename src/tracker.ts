/**
 * Tracker — results.tsv read/write with file locking
 *
 * Each round produces one row:
 *   round | policy | score | kept | details | timestamp
 *
 * Uses fileLock to prevent concurrent write corruption.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { withLock } from './fileLock.js'

// ============================================================
// Types
// ============================================================

export interface RoundResult {
  round: number
  policy: string
  score: number
  kept: boolean
  details: string
  timestamp: Date
}

// ============================================================
// TSV header
// ============================================================

const HEADER = 'round\tpolicy\tscore\tkept\tdetails\ttimestamp'

// ============================================================
// Init results file
// ============================================================

export function initResultsFile(filePath: string): void {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, HEADER + '\n', 'utf-8')
  }
}

// ============================================================
// Append a round result (with lock)
// ============================================================

export async function recordRound(
  filePath: string,
  result: RoundResult,
): Promise<void> {
  await withLock(filePath, 'tracker', async () => {
    if (!existsSync(filePath)) {
      writeFileSync(filePath, HEADER + '\n', 'utf-8')
    }

    const escapedDetails = result.details.replace(/\t/g, ' ').replace(/\n/g, ' | ')
    const line = [
      result.round,
      result.policy,
      result.score.toFixed(4),
      result.kept ? 'keep' : 'discard',
      escapedDetails,
      result.timestamp.toISOString(),
    ].join('\t')

    appendFileSync(filePath, line + '\n', 'utf-8')
  })
}

// ============================================================
// Read all results
// ============================================================

export function readResults(filePath: string): RoundResult[] {
  if (!existsSync(filePath)) return []

  const content = readFileSync(filePath, 'utf-8')
  const lines = content.trim().split('\n').slice(1) // skip header

  return lines.filter(l => l.trim()).map(line => {
    const [round, policy, score, kept, details, timestamp] = line.split('\t')
    return {
      round: parseInt(round, 10),
      policy,
      score: parseFloat(score),
      kept: kept === 'keep',
      details,
      timestamp: new Date(timestamp),
    }
  })
}

// ============================================================
// Summary stats
// ============================================================

export function summarizeResults(filePath: string): string {
  const results = readResults(filePath)
  if (results.length === 0) return 'No results yet.'

  const kept = results.filter(r => r.kept)
  const discarded = results.filter(r => !r.kept)
  const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length
  const bestRound = results.reduce((best, r) => r.score > best.score ? r : best, results[0])

  const byPolicy: Record<string, number> = {}
  for (const r of results) {
    byPolicy[r.policy] = (byPolicy[r.policy] ?? 0) + 1
  }

  let out = `Rounds: ${results.length} (${kept.length} kept, ${discarded.length} discarded)\n`
  out += `Avg score: ${avgScore.toFixed(4)}\n`
  out += `Best: round ${bestRound.round} (${bestRound.score.toFixed(4)}, ${bestRound.policy})\n`
  out += `By policy: ${Object.entries(byPolicy).map(([k, v]) => `${k}=${v}`).join(', ')}\n`

  // Trend: last 5 rounds
  const recent = results.slice(-5)
  if (recent.length >= 2) {
    const trend = recent[recent.length - 1].score - recent[0].score
    out += `Trend (last ${recent.length}): ${trend >= 0 ? '+' : ''}${trend.toFixed(4)}\n`
  }

  return out
}
