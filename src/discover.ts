/**
 * Project Discovery — auto-detect tech stack, data sources, and propose metrics
 *
 * Two modes:
 *   1. Existing project (has code) → Claude reads code, proposes metrics
 *   2. New project (no code) → return empty proposal, caller handles guided setup
 *
 * Output is a Proposal that goes to council for approval before becoming config.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { executeViaCLI } from './runner.js'
import type { VoterConfig } from './config.js'
import type { Metric, Constraint, PolicyType } from './selfProgram.js'

// ============================================================
// Types
// ============================================================

export interface ProjectInfo {
  hasCode: boolean
  packageJson?: Record<string, any>
  techStack: string[]
  dataSource?: string        // supabase, postgres, mysql, firebase, none
  framework?: string         // next, vite, express, etc.
  hasTests: boolean
  hasCICD: boolean
  languages: string[]
  entryPoints: string[]      // key files found
}

export interface ConfigProposal {
  goal: string
  startPolicy: PolicyType
  metrics: Metric[]
  constraints: Constraint[]
  reasoning: string          // why these metrics/constraints
  projectInfo: ProjectInfo
}

// ============================================================
// Detect project info by reading files (no AI needed)
// ============================================================

export function detectProjectInfo(projectDir: string): ProjectInfo {
  const info: ProjectInfo = {
    hasCode: false,
    techStack: [],
    hasTests: false,
    hasCICD: false,
    languages: [],
    entryPoints: [],
  }

  // Check package.json
  const pkgPath = join(projectDir, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      info.packageJson = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      info.hasCode = true
      const deps = {
        ...info.packageJson?.dependencies,
        ...info.packageJson?.devDependencies,
      }

      // Framework detection
      if (deps['next']) { info.framework = 'next'; info.techStack.push('Next.js') }
      else if (deps['vite']) { info.framework = 'vite'; info.techStack.push('Vite') }
      else if (deps['express']) { info.framework = 'express'; info.techStack.push('Express') }
      else if (deps['hono']) { info.framework = 'hono'; info.techStack.push('Hono') }

      // Data source detection
      if (deps['@supabase/supabase-js'] || deps['@supabase/ssr']) {
        info.dataSource = 'supabase'; info.techStack.push('Supabase')
      } else if (deps['pg'] || deps['postgres'] || deps['@prisma/client']) {
        info.dataSource = 'postgres'; info.techStack.push('PostgreSQL')
      } else if (deps['firebase'] || deps['firebase-admin']) {
        info.dataSource = 'firebase'; info.techStack.push('Firebase')
      } else if (deps['mongoose'] || deps['mongodb']) {
        info.dataSource = 'mongodb'; info.techStack.push('MongoDB')
      }

      // Other tech
      if (deps['tailwindcss']) info.techStack.push('Tailwind')
      if (deps['typescript']) info.techStack.push('TypeScript')
      if (deps['react']) info.techStack.push('React')
      if (deps['vue']) info.techStack.push('Vue')

      // Test detection
      if (deps['jest'] || deps['vitest'] || deps['mocha'] || deps['@testing-library/react']) {
        info.hasTests = true
      }
      if (info.packageJson?.scripts?.test && info.packageJson.scripts.test !== 'echo "Error: no test specified" && exit 1') {
        info.hasTests = true
      }

      info.languages.push('TypeScript/JavaScript')
    } catch { /* ignore parse errors */ }
  }

  // Check for Python
  if (existsSync(join(projectDir, 'requirements.txt')) || existsSync(join(projectDir, 'pyproject.toml'))) {
    info.hasCode = true
    info.languages.push('Python')
  }

  // Check for Go
  if (existsSync(join(projectDir, 'go.mod'))) {
    info.hasCode = true
    info.languages.push('Go')
  }

  // CI/CD
  if (existsSync(join(projectDir, '.github/workflows'))) info.hasCICD = true
  if (existsSync(join(projectDir, 'vercel.json'))) info.techStack.push('Vercel')

  // Key entry points
  const candidates = [
    'src/App.tsx', 'src/main.tsx', 'app/page.tsx', 'app/layout.tsx',
    'pages/index.tsx', 'index.ts', 'src/index.ts', 'main.py', 'app.py',
  ]
  for (const c of candidates) {
    if (existsSync(join(projectDir, c))) info.entryPoints.push(c)
  }

  // If no package.json but has files, still count as having code
  if (!info.hasCode) {
    try {
      const files = readdirSync(projectDir)
      info.hasCode = files.some(f =>
        f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.py') || f.endsWith('.go')
      )
    } catch { /* ignore */ }
  }

  return info
}

// ============================================================
// Generate config proposal via Claude (for existing projects)
// ============================================================

export async function generateProposal(
  goal: string,
  projectDir: string,
  claudeVoter: VoterConfig,
): Promise<ConfigProposal> {
  const info = detectProjectInfo(projectDir)

  if (!info.hasCode) {
    // New project — return minimal proposal
    return {
      goal,
      startPolicy: 'research',
      metrics: [],
      constraints: [],
      reasoning: 'New project with no code detected. Metrics and constraints will be defined after initial research phase.',
      projectInfo: info,
    }
  }

  // Existing project — ask Claude to analyze and propose
  const prompt = `You are analyzing a project to propose autopilot configuration.

## Goal
${goal}

## Project Info (auto-detected)
- Tech stack: ${info.techStack.join(', ') || 'unknown'}
- Framework: ${info.framework || 'unknown'}
- Data source: ${info.dataSource || 'none detected'}
- Languages: ${info.languages.join(', ')}
- Has tests: ${info.hasTests}
- Has CI/CD: ${info.hasCICD}
- Entry points: ${info.entryPoints.join(', ') || 'none found'}

## Your Task
Based on the goal and project info, propose:
1. **metrics** — what to measure, how to extract (shell commands that output a number)
2. **constraints** — what must not break (shell commands, exit 0 = pass)
3. **startPolicy** — research, explore, exploit, or consolidate
4. **reasoning** — why these choices

Rules:
- extractCommand must be a shell command that outputs a single number to stdout
- checkCommand must be a shell command that exits 0 (pass) or non-zero (fail)
- For Supabase projects: use \`supabase\` CLI if available
- For web projects: use \`curl\` for HTTP checks
- For projects with tests: use \`npm test\` as a constraint
- Keep it practical — only metrics you can actually extract automatically
- direction: "higher" = bigger is better, "lower" = smaller is better, "pass-fail" = binary

Output ONLY valid JSON (no markdown, no explanation outside JSON):
{
  "startPolicy": "research",
  "metrics": [
    {
      "name": "metric_name",
      "description": "what it measures",
      "extractCommand": "shell command",
      "weight": 0.5,
      "direction": "higher",
      "source": "auto"
    }
  ],
  "constraints": [
    {
      "description": "what must not break",
      "type": "hard",
      "checkCommand": "shell command",
      "source": "auto"
    }
  ],
  "reasoning": "why these choices"
}`

  const result = await executeViaCLI(claudeVoter, prompt, projectDir)

  if (result.exitCode !== 0) {
    // Claude failed — return basic proposal from detected info
    return buildFallbackProposal(goal, info)
  }

  try {
    // Extract JSON from Claude's response (may have surrounding text)
    const jsonMatch = result.stdout.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return buildFallbackProposal(goal, info)
    }

    const parsed = JSON.parse(jsonMatch[0])

    return {
      goal,
      startPolicy: parsed.startPolicy ?? 'research',
      metrics: (parsed.metrics ?? []).map((m: any) => ({
        name: m.name,
        description: m.description,
        extractCommand: m.extractCommand,
        weight: m.weight ?? 0.5,
        direction: m.direction ?? 'higher',
        source: 'auto' as const,
      })),
      constraints: (parsed.constraints ?? []).map((c: any) => ({
        description: c.description,
        type: c.type ?? 'hard',
        checkCommand: c.checkCommand,
        penalty: c.penalty,
        source: 'auto' as const,
      })),
      reasoning: parsed.reasoning ?? 'AI-generated proposal',
      projectInfo: info,
    }
  } catch {
    return buildFallbackProposal(goal, info)
  }
}

// ============================================================
// Fallback proposal when Claude fails
// ============================================================

function buildFallbackProposal(goal: string, info: ProjectInfo): ConfigProposal {
  const metrics: Metric[] = []
  const constraints: Constraint[] = []

  // Add build check if package.json exists
  if (info.packageJson?.scripts?.build) {
    constraints.push({
      description: 'Project builds without errors',
      type: 'hard',
      checkCommand: 'npm run build --if-present 2>&1 | tail -1 | grep -v error',
      source: 'auto',
    })
  }

  // Add test constraint if tests exist
  if (info.hasTests) {
    constraints.push({
      description: 'All tests pass',
      type: 'hard',
      checkCommand: 'npm test',
      source: 'auto',
    })
  }

  // Add HTTP check for web frameworks
  if (info.framework === 'next' || info.framework === 'vite') {
    metrics.push({
      name: 'build_success',
      description: 'Build completes successfully',
      extractCommand: 'npm run build > /dev/null 2>&1 && echo 1 || echo 0',
      weight: 1.0,
      direction: 'pass-fail',
      source: 'auto',
    })
  }

  return {
    goal,
    startPolicy: 'research',
    metrics,
    constraints,
    reasoning: 'Fallback proposal based on detected project structure. Claude analysis was unavailable.',
    projectInfo: info,
  }
}

// ============================================================
// Format proposal for human/council review
// ============================================================

export function formatProposal(proposal: ConfigProposal): string {
  let out = `# Autopilot Config Proposal\n\n`
  out += `**Goal:** ${proposal.goal}\n`
  out += `**Start Policy:** ${proposal.startPolicy}\n`
  out += `**Tech Stack:** ${proposal.projectInfo.techStack.join(', ') || 'unknown'}\n\n`

  out += `## Reasoning\n${proposal.reasoning}\n\n`

  if (proposal.metrics.length > 0) {
    out += `## Proposed Metrics\n`
    for (const m of proposal.metrics) {
      out += `- **${m.name}** (${m.direction}, weight ${m.weight}): ${m.description}\n`
      out += `  \`${m.extractCommand}\`\n`
    }
    out += '\n'
  } else {
    out += `## Metrics\nNone proposed yet — will be determined during research phase.\n\n`
  }

  if (proposal.constraints.length > 0) {
    out += `## Proposed Constraints\n`
    for (const c of proposal.constraints) {
      out += `- [${c.type}] ${c.description}\n`
      out += `  \`${c.checkCommand}\`\n`
    }
  } else {
    out += `## Constraints\nNone proposed yet.\n`
  }

  return out
}
