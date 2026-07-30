import { resolve } from 'node:path'
import { exportRun, planExperiment, runExperiment } from './experimentRunner'
import { exportEvalSetFile } from './benchmarkData'
import { createEvidenceReviewPacket } from './evidenceSampler'
import { writeRunReport } from './report'
import { planDraftGeneration, runDraftGeneration } from './draftGeneration'
import { compileApprovedDrafts } from './draftCompilation'

interface ParsedArgs {
  positional: string[]
  options: Map<string, string | true>
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = []
  const options = new Map<string, string | true>()
  for (let index = 0; index < args.length; index++) {
    const value = args[index]
    if (!value.startsWith('--')) {
      positional.push(value)
      continue
    }
    const [name, inlineValue] = value.split('=', 2)
    if (inlineValue !== undefined) {
      options.set(name, inlineValue)
      continue
    }
    const next = args[index + 1]
    if (next && !next.startsWith('--')) {
      options.set(name, next)
      index += 1
    } else {
      options.set(name, true)
    }
  }
  return { positional, options }
}

function optionString(args: ParsedArgs, name: string): string | undefined {
  const value = args.options.get(name)
  return typeof value === 'string' ? value : undefined
}

function usage(): string {
  return [
    'Usage:',
    '  npm run rag-eval -- plan <experiment.yaml> [--library-dir <path>]',
    '  npm run rag-eval -- run <experiment.yaml> --max-usd <amount> [--library-dir <path>]',
    '  npm run rag-eval -- resume <experiment.yaml> --max-usd <amount> [--library-dir <path>]',
    '  npm run rag-eval -- export <run.json> --format jsonl|csv',
    '  npm run rag-eval -- export-eval <book-id> <eval-set-id> <output.json> [--library-dir <path>]',
    '  npm run rag-eval -- sample-evidence <corpus.json> <output.json> --per-book <count> [--library-dir <path>]',
    '  npm run rag-eval -- report <run.json> [--output <report.md>] [--bootstrap <iterations>]',
    '  npm run rag-eval -- plan-drafts <draft-generation.yaml>',
    '  npm run rag-eval -- run-drafts <draft-generation.yaml> --max-usd <amount>',
    '  npm run rag-eval -- resume-drafts <draft-generation.yaml> --max-usd <amount>',
    '  npm run rag-eval -- compile-drafts <draft-run.json> <output-dir> --reviewed-by <name>'
  ].join('\n')
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  const target = args.positional[0]
  if (!command || !target) throw new Error(usage())

  if (command === 'plan') {
    const plan = await planExperiment(target, optionString(args, '--library-dir'))
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    return
  }

  if (command === 'run' || command === 'resume') {
    const rawMaxUsd = optionString(args, '--max-usd')
    if (rawMaxUsd === undefined) throw new Error(`${command} requires --max-usd\n\n${usage()}`)
    const maxUsd = Number(rawMaxUsd)
    const run = await runExperiment(target, maxUsd, {
      libraryDir: optionString(args, '--library-dir'),
      resume: command === 'resume'
    })
    process.stdout.write(
      `${JSON.stringify(
        {
          status: run.status,
          runPath: run.plan.runPath,
          results: run.results.length,
          actualCostUsd: run.ledger.actualCostUsd
        },
        null,
        2
      )}\n`
    )
    return
  }

  if (command === 'export') {
    const format = optionString(args, '--format')
    if (format !== 'jsonl' && format !== 'csv') {
      throw new Error('export requires --format jsonl|csv')
    }
    const outputPath = await exportRun(resolve(target), format)
    process.stdout.write(`${outputPath}\n`)
    return
  }

  if (command === 'export-eval') {
    const evalSetId = args.positional[1]
    const outputPath = args.positional[2]
    if (!evalSetId || !outputPath) throw new Error(usage())
    const exportedPath = await exportEvalSetFile(
      target,
      evalSetId,
      outputPath,
      optionString(args, '--library-dir')
    )
    process.stdout.write(`${exportedPath}\n`)
    return
  }

  if (command === 'sample-evidence') {
    const outputPath = args.positional[1]
    const rawPerBook = optionString(args, '--per-book')
    if (!outputPath || rawPerBook === undefined) throw new Error(usage())
    const sampledPath = await createEvidenceReviewPacket(
      target,
      outputPath,
      Number(rawPerBook),
      optionString(args, '--library-dir')
    )
    process.stdout.write(`${sampledPath}\n`)
    return
  }

  if (command === 'report') {
    const rawBootstrap = optionString(args, '--bootstrap')
    const paths = await writeRunReport(
      target,
      optionString(args, '--output'),
      rawBootstrap === undefined ? 2000 : Number(rawBootstrap)
    )
    process.stdout.write(`${JSON.stringify(paths, null, 2)}\n`)
    return
  }

  if (command === 'plan-drafts') {
    const plan = await planDraftGeneration(target)
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    return
  }

  if (command === 'run-drafts' || command === 'resume-drafts') {
    const rawMaxUsd = optionString(args, '--max-usd')
    if (rawMaxUsd === undefined) throw new Error(`${command} requires --max-usd\n\n${usage()}`)
    const run = await runDraftGeneration(target, Number(rawMaxUsd), {
      resume: command === 'resume-drafts'
    })
    process.stdout.write(
      `${JSON.stringify(
        {
          status: run.status,
          runPath: run.plan.runPath,
          drafts: run.drafts.length,
          failures: run.failures.length,
          actualCostUsd: run.ledger.actualCostUsd
        },
        null,
        2
      )}\n`
    )
    return
  }

  if (command === 'compile-drafts') {
    const outputDir = args.positional[1]
    const reviewedBy = optionString(args, '--reviewed-by')
    if (!outputDir || !reviewedBy) throw new Error(usage())
    const compiled = await compileApprovedDrafts(target, outputDir, reviewedBy)
    process.stdout.write(`${JSON.stringify(compiled, null, 2)}\n`)
    return
  }

  throw new Error(`Unknown command: ${command}\n\n${usage()}`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`)
  process.exitCode = 1
})
