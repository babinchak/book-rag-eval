import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { parseEvalSet } from '../src/shared/evalSchema'
import { parseExperimentConfig } from '../src/shared/experimentSchema'
import { parse as parseYaml } from 'yaml'

test('committed pilot benchmark data and experiment config validate', async () => {
  const evalSet = parseEvalSet(
    JSON.parse(
      await fs.readFile(
        resolve('benchmarks/evals/nietzsche-genealogy-pilot-v1.json'),
        'utf8'
      )
    )
  )
  const experiment = parseExperimentConfig(
    parseYaml(await fs.readFile(resolve('experiments/nietzsche-pilot.yaml'), 'utf8'))
  )

  assert.equal(evalSet.schemaVersion, 2)
  assert.equal(evalSet.cases.length, 9)
  assert.ok(evalSet.cases.every((evalCase) => evalCase.goldEvidence.length > 0))
  assert.equal(experiment.books[0].bookId, evalSet.bookId)
  assert.equal(
    experiment.books[0].evalSetPath,
    '../benchmarks/evals/nietzsche-genealogy-pilot-v1.json'
  )
})
