import { Tiktoken } from 'js-tiktoken/lite'
import cl100kBase from 'js-tiktoken/ranks/cl100k_base'

export const DEFAULT_TOKEN_ENCODING = 'cl100k_base' as const

const tokenizer = new Tiktoken(cl100kBase)

function encode(text: string): number[] {
  // Treat strings that happen to resemble special tokens as ordinary book
  // content. EPUB prose is untrusted input, not a model prompt template.
  return tokenizer.encode(text, [], [])
}

export function countChunkTokens(text: string): number {
  return encode(text).length
}

export interface TokenChunkSpan {
  start: number
  end: number
  tokenCount: number
}

/**
 * Split text using cl100k_base token windows while returning UTF-16 character
 * offsets. The offsets continue to address exact substrings in the reader and
 * eval gold spans, including for non-ASCII text.
 *
 * Tiktoken tokens are byte sequences and a token boundary can fall inside a
 * multi-byte Unicode code point. We therefore move a proposed boundary inward
 * until decoding produces an exact substring of the original text.
 */
export function chunkTokenSpans(text: string, size: number, overlap: number): TokenChunkSpan[] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error('token chunk size must be a positive integer')
  }
  if (!Number.isInteger(overlap) || overlap < 0) {
    throw new Error('token chunk overlap must be a non-negative integer')
  }
  if (overlap >= size) {
    throw new Error('token chunk overlap must be smaller than size')
  }
  if (text.length === 0) return []

  const tokens = encode(text)
  if (tokens.length === 0) return []

  const spans: TokenChunkSpan[] = []
  let startToken = 0
  let startChar = 0

  while (startToken < tokens.length) {
    let endToken = Math.min(startToken + size, tokens.length)
    let chunkText = ''
    let tokenCount = 0

    // Find the largest safe Unicode boundary whose standalone encoding still
    // fits the configured token budget.
    while (endToken > startToken) {
      const candidate = tokenizer.decode(tokens.slice(startToken, endToken))
      const isExactSubstring = text.startsWith(candidate, startChar)
      if (isExactSubstring) {
        const candidateCount = encode(candidate).length
        if (candidateCount <= size) {
          chunkText = candidate
          tokenCount = candidateCount
          break
        }
      }
      endToken -= 1
    }

    if (endToken <= startToken || chunkText.length === 0) {
      throw new Error(
        `could not find a Unicode-safe token boundary within size ${size}; increase the chunk size`
      )
    }

    const endChar = startChar + chunkText.length
    spans.push({ start: startChar, end: endChar, tokenCount })

    if (endToken === tokens.length) break

    if (overlap === 0) {
      startToken = endToken
      startChar = endChar
      continue
    }

    // Start with the requested token overlap. Moving forward can only reduce
    // overlap and is occasionally necessary when the boundary bisects a
    // multi-byte Unicode character or retokenizes differently in isolation.
    let nextStartToken = Math.max(startToken + 1, endToken - overlap)
    let overlapText = ''
    while (nextStartToken < endToken) {
      const candidate = tokenizer.decode(tokens.slice(nextStartToken, endToken))
      if (
        candidate.length > 0 &&
        chunkText.endsWith(candidate) &&
        encode(candidate).length <= overlap
      ) {
        overlapText = candidate
        break
      }
      nextStartToken += 1
    }

    if (overlapText.length === 0) {
      startToken = endToken
      startChar = endChar
    } else {
      startToken = nextStartToken
      startChar = endChar - overlapText.length
    }
  }

  return spans
}
