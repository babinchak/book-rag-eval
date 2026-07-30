import assert from 'node:assert/strict'
import test from 'node:test'
import { chunkTokenSpans, countChunkTokens } from '../src/main/tokenChunking'

test('counts cl100k_base tokens', () => {
  assert.equal(countChunkTokens('hello world'), 2)
})

test('creates exact token-limited windows without overlap', () => {
  const text =
    'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen'
  const spans = chunkTokenSpans(text, 5, 0)

  assert.ok(spans.length > 1)
  assert.equal(spans[0].start, 0)
  assert.equal(spans.at(-1)?.end, text.length)

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]
    const chunk = text.slice(span.start, span.end)
    assert.equal(span.tokenCount, countChunkTokens(chunk))
    assert.ok(span.tokenCount <= 5)
    if (i > 0) assert.equal(span.start, spans[i - 1].end)
  }
})

test('creates overlapping windows that still respect the token limit', () => {
  const text = `${'philosophy ethics knowledge reason virtue justice '.repeat(20)}end`
  const spans = chunkTokenSpans(text, 12, 3)

  assert.ok(spans.length > 2)
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]
    assert.ok(span.end > span.start)
    assert.ok(span.tokenCount <= 12)
    assert.equal(span.tokenCount, countChunkTokens(text.slice(span.start, span.end)))
    if (i > 0) {
      const previous = spans[i - 1]
      assert.ok(span.start < previous.end)
      assert.ok(span.start > previous.start)
      const overlap = text.slice(span.start, previous.end)
      assert.ok(countChunkTokens(overlap) <= 3)
    }
  }
})

test('preserves exact Unicode substrings and offsets', () => {
  const text = 'Philosophy 🤔 café 中文 naïve — τέλος. '.repeat(20)
  const spans = chunkTokenSpans(text, 10, 2)

  assert.equal(spans[0].start, 0)
  assert.equal(spans.at(-1)?.end, text.length)
  for (const span of spans) {
    const chunk = text.slice(span.start, span.end)
    assert.ok(!chunk.includes('\uFFFD'))
    assert.equal(span.tokenCount, countChunkTokens(chunk))
    assert.ok(span.tokenCount <= 10)
  }
})

test('validates size and overlap', () => {
  assert.throws(() => chunkTokenSpans('text', 0, 0), /positive integer/)
  assert.throws(() => chunkTokenSpans('text', 10, -1), /non-negative integer/)
  assert.throws(() => chunkTokenSpans('text', 10, 10), /smaller than size/)
})
