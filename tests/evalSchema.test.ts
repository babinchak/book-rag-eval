import assert from 'node:assert/strict'
import test from 'node:test'
import { EVAL_SCHEMA_VERSION, parseEvalSet } from '../src/shared/evalSchema'

test('migrates legacy eval sets into the canonical schema', () => {
  const migrated = parseEvalSet(
    {
      id: 'pilot',
      bookId: 'book-1',
      createdAt: 10,
      updatedAt: 20,
      cases: [
        {
          id: 'case-1',
          question: 'What is claimed?',
          searchQuery: 'central claim',
          goldSpans: [
            {
              bookId: 'book-1',
              nodeId: 'node-1',
              spineHref: 'chapter.xhtml',
              textStart: 5,
              textEnd: 20
            }
          ]
        }
      ]
    },
    'book-1'
  )

  assert.equal(migrated.schemaVersion, EVAL_SCHEMA_VERSION)
  assert.equal(migrated.cases[0].canonicalSearchQuery, 'central claim')
  assert.equal(migrated.cases[0].scope, 'within_book')
  assert.equal(migrated.cases[0].answerability, 'answerable')
  assert.equal(migrated.cases[0].split, 'dev')
  assert.equal(migrated.cases[0].provenance.kind, 'imported')
  assert.deepEqual(migrated.cases[0].goldEvidence, [
    {
      id: 'evidence-1',
      requirementId: 'required-1',
      kind: 'text',
      bookId: 'book-1',
      nodeId: 'node-1',
      spineHref: 'chapter.xhtml',
      textStart: 5,
      textEnd: 20
    }
  ])
})

test('supports required evidence groups, alternatives, and cross-book evidence', () => {
  const parsed = parseEvalSet({
    schemaVersion: EVAL_SCHEMA_VERSION,
    id: 'library-comparison',
    bookId: 'book-1',
    createdAt: 10,
    updatedAt: 10,
    cases: [
      {
        id: 'comparison',
        question: 'How do the two accounts differ?',
        canonicalSearchQuery: 'comparison of the two accounts',
        searchQuery: 'ignored compatibility value',
        scope: 'library',
        answerability: 'answerable',
        difficulty: 'hard',
        split: 'test',
        tags: ['cross-book', 'multi-hop'],
        provenance: { kind: 'human', reviewedBy: 'reviewer' },
        goldEvidence: [
          {
            id: 'a-primary',
            requirementId: 'account-a',
            kind: 'text',
            bookId: 'book-1',
            nodeId: 'node-a',
            spineHref: 'a.xhtml',
            textStart: 0,
            textEnd: 10
          },
          {
            id: 'a-alternative',
            requirementId: 'account-a',
            kind: 'table',
            bookId: 'book-1',
            nodeId: 'table-a',
            spineHref: 'table.xhtml'
          },
          {
            id: 'b-primary',
            requirementId: 'account-b',
            kind: 'image',
            bookId: 'book-2',
            nodeId: 'figure-b',
            spineHref: 'figure.xhtml'
          }
        ],
        goldSpans: []
      }
    ]
  })

  const evalCase = parsed.cases[0]
  assert.equal(evalCase.scope, 'library')
  assert.equal(new Set(evalCase.goldEvidence.map((item) => item.requirementId)).size, 2)
  assert.deepEqual(evalCase.goldSpans, [
    {
      bookId: 'book-1',
      nodeId: 'node-a',
      spineHref: 'a.xhtml',
      textStart: 0,
      textEnd: 10
    }
  ])
})

test('accepts intentionally unanswerable cases without evidence', () => {
  const parsed = parseEvalSet({
    schemaVersion: EVAL_SCHEMA_VERSION,
    id: 'abstention',
    bookId: 'book-1',
    createdAt: 0,
    updatedAt: 0,
    cases: [
      {
        id: 'not-in-book',
        question: 'What does the author say about a nonexistent topic?',
        canonicalSearchQuery: 'nonexistent topic',
        searchQuery: 'nonexistent topic',
        scope: 'within_book',
        answerability: 'unanswerable',
        goldEvidence: [],
        goldSpans: [],
        tags: ['unanswerable'],
        difficulty: 'medium',
        split: 'dev',
        provenance: { kind: 'human' }
      }
    ]
  })

  assert.equal(parsed.cases[0].answerability, 'unanswerable')
  assert.equal(parsed.cases[0].goldEvidence.length, 0)
})

test('rejects malformed evidence instead of silently weakening the benchmark', () => {
  assert.throws(
    () =>
      parseEvalSet({
        schemaVersion: EVAL_SCHEMA_VERSION,
        id: 'bad',
        bookId: 'book-1',
        createdAt: 0,
        updatedAt: 0,
        cases: [
          {
            id: 'bad-case',
            question: 'Bad evidence?',
            canonicalSearchQuery: 'bad evidence',
            searchQuery: 'bad evidence',
            scope: 'within_book',
            answerability: 'answerable',
            goldEvidence: [],
            goldSpans: [],
            tags: [],
            difficulty: 'easy',
            split: 'dev',
            provenance: { kind: 'human' }
          }
        ]
      }),
    /answerable cases require gold evidence/
  )
})
