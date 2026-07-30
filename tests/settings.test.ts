import assert from 'node:assert/strict'
import test from 'node:test'
import { getOpenaiKey, hasOpenaiKey } from '../src/main/settings'

test('headless credential lookup uses the environment without requiring Electron app storage', async () => {
  const previousKey = process.env.OPENAI_API_KEY
  try {
    delete process.env.OPENAI_API_KEY
    assert.equal(await getOpenaiKey(), null)
    assert.equal(await hasOpenaiKey(), false)

    process.env.OPENAI_API_KEY = 'test-key-from-environment'
    assert.equal(await getOpenaiKey(), 'test-key-from-environment')
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  }
})
