import { resolve } from 'node:path'
import { exportRun, planExperiment, runExperiment } from './experimentRunner'

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
    '  npm run rag-eval -- export <run.json> --format jsonl|csv'
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

  throw new Error(`Unknown command: ${command}\n\n${usage()}`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`)
  process.exitCode = 1
})
