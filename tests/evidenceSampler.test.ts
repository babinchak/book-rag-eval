import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCanonicalBookDocument } from '../src/shared/canonicalDocument'
import {
  isLikelyCorpusBoilerplate,
  sampleEvidenceCandidates
} from '../src/headless/evidenceSampler'

test('samples deterministic strategy-independent evidence with special content coverage', () => {
  const paragraphs = Array.from(
    { length: 12 },
    (_, index) =>
      `<p>Paragraph ${index} explains a sufficiently detailed philosophical claim about freedom, responsibility, evidence, experience, and human judgment in several connected words.</p>`
  ).join('')
  const document = buildCanonicalBookDocument('book-1', [
    {
      href: 'OPS/chapter.xhtml',
      rawHtml:
        `<html><body><h1>Reason</h1>${paragraphs}` +
        '<blockquote>This extended quotation presents a sufficiently detailed challenge to the ordinary account of reason, experience, responsibility, and judgment in philosophical inquiry.</blockquote>' +
        '<table><caption>Faculties</caption><tr><th>Name</th><th>Role</th></tr><tr><td>Reason</td><td>Inference</td></tr></table>' +
        '<figure><img src="reason.png" alt="A diagram connecting sensation, memory, and reason"/><figcaption>Faculties of mind</figcaption></figure>' +
        '</body></html>'
    }
  ])

  const first = sampleEvidenceCandidates(document, 8)
  const second = sampleEvidenceCandidates(document, 8)
  assert.deepEqual(first, second)
  assert.equal(first.length, 8)
  assert.ok(first.some((candidate) => candidate.kind === 'table'))
  assert.ok(first.some((candidate) => candidate.kind === 'image'))
  assert.ok(first.some((candidate) => candidate.kind === 'blockquote'))
  assert.ok(first.every((candidate) => candidate.nodeId && candidate.spineHref))
})

test('identifies distribution boilerplate without rejecting book prose', () => {
  assert.equal(
    isLikelyCorpusBoilerplate(
      'If you received this electronic work and do not agree to the terms, you may obtain a refund.'
    ),
    true
  )
  assert.equal(
    isLikelyCorpusBoilerplate(
      'Freedom requires responsibility and careful judgment in every deliberate action.'
    ),
    false
  )
})
