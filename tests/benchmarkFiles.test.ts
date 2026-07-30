import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { parseEvalSet } from '../src/shared/evalSchema'
import { parseExperimentConfig } from '../src/shared/experimentSchema'
import { parseCorpusManifest } from '../src/shared/corpusSchema'
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
  const corpus = parseCorpusManifest(
    JSON.parse(
      await fs.readFile(resolve('benchmarks/corpora/six-book-smoke.json'), 'utf8')
    )
  )
  const authoringPacket = JSON.parse(
    await fs.readFile(
      resolve('benchmarks/authoring/six-book-smoke-candidates-v1.json'),
      'utf8'
    )
  ) as {
    corpusId: string
    candidatesPerBook: number
    books: Array<{ bookId: string; sourceHash: string }>
    candidates: Array<{ bookId: string; sourceHash: string; reviewStatus: string }>
  }

  assert.equal(evalSet.schemaVersion, 2)
  assert.equal(evalSet.cases.length, 9)
  assert.ok(evalSet.cases.every((evalCase) => evalCase.goldEvidence.length > 0))
  assert.equal(experiment.books[0].bookId, evalSet.bookId)
  assert.equal(
    experiment.books[0].evalSetPath,
    '../benchmarks/evals/nietzsche-genealogy-pilot-v1.json'
  )
  assert.equal(corpus.books.length, 6)
  assert.ok(corpus.books.some((book) => book.tags.includes('figures')))
  assert.equal(authoringPacket.corpusId, corpus.id)
  assert.equal(authoringPacket.candidatesPerBook, 25)
  assert.equal(authoringPacket.candidates.length, 150)
  const sourceHashByBook = new Map(
    authoringPacket.books.map((book) => [book.bookId, book.sourceHash])
  )
  assert.ok(
    authoringPacket.candidates.every(
      (candidate) =>
        candidate.reviewStatus === 'pending' &&
        candidate.sourceHash === sourceHashByBook.get(candidate.bookId)
    )
  )
})
