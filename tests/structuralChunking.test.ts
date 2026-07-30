import assert from 'node:assert/strict'
import test from 'node:test'
import { chunkStructuralTokens } from '../src/main/chunking'
import { countChunkTokens } from '../src/main/tokenChunking'
import { buildCanonicalBookDocument } from '../src/shared/canonicalDocument'

test('structural token chunks follow headings and enforce a hard token maximum', () => {
  const longParagraph = Array.from(
    { length: 500 },
    (_, index) => `claim${index} follows from experience and reason`
  ).join(' ')
  const document = buildCanonicalBookDocument('book-1', [
    {
      href: 'OPS/chapter.xhtml',
      rawHtml:
        `<html><body><h1>First section</h1><p>${longParagraph}</p>` +
        `<h1>Second section</h1><p>${longParagraph}</p></body></html>`
    }
  ])
  const spine = document.spine[0]
  const chunks = chunkStructuralTokens(
    spine,
    {
      targetSize: 128,
      maxSize: 160,
      encoding: 'cl100k_base'
    },
    'structural-test'
  )

  assert.ok(chunks.length > 2)
  assert.ok(chunks.every((chunk) => countChunkTokens(chunk.text) <= 160))
  assert.ok(chunks.every((chunk) => chunk.tokenCount === countChunkTokens(chunk.text)))
  const secondHeading = spine.text.indexOf('Second section')
  assert.ok(chunks.some((chunk) => chunk.textStart === secondHeading))
})
