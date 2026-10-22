import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { DEFAULT_ALERT_CONFIG } from '../src/pure.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(__dirname, '..', 'lib', 'client.js')

/**
 * Pull the `_MEM_ALERT_DEFAULTS = { ... }` object literal out of the client
 * source. The literal is a plain JSON-shaped object of numbers, so we extract
 * the balanced braces and evaluate it in a fresh VM context. This avoids
 * executing the whole client (which needs `window.__ModuleLoader__`, react,
 * etc.) just to read one constant.
 */
function extractClientAlertDefaults(): Record<string, number> {
  const src = readFileSync(CLIENT_PATH, 'utf8')
  const marker = 'var _MEM_ALERT_DEFAULTS = {'
  const start = src.indexOf(marker)
  assert.notEqual(start, -1, `client.js must define ${marker.trim()}`)
  const objStart = start + marker.length - 1 // index of '{'

  // Balanced-brace scan to find the matching '}' that closes the literal.
  let depth = 0
  let end = -1
  let inString: string | null = null
  for (let i = objStart; i < src.length; i++) {
    const ch = src[i]
    if (inString) {
      if (ch === '\\') { i++; continue }
      if (ch === inString) inString = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  assert.notEqual(end, -1, 'could not find end of _MEM_ALERT_DEFAULTS literal')

  const literal = src.slice(objStart, end + 1)
  const context = vm.createContext({})
  const value = vm.runInContext(`(${literal})`, context)
  assert.ok(value && typeof value === 'object', 'extracted defaults should be an object')
  // Normalize into a MAIN-realm plain object: the VM-evaluated object carries a
  // different realm's Object.prototype, which node:assert deepStrictEqual would
  // otherwise flag as a mismatch even though the entries are identical.
  return Object.assign({}, value as Record<string, number>)
}

test('client _MEM_ALERT_DEFAULTS matches the canonical host DEFAULT_ALERT_CONFIG', () => {
  const client = extractClientAlertDefaults()
  // Every canonical key must be present in the client mirror with the same value.
  assert.deepEqual(client, DEFAULT_ALERT_CONFIG as unknown as Record<string, number>)
})

test('DEFAULT_ALERT_CONFIG has exactly the expected keys', () => {
  const keys = Object.keys(DEFAULT_ALERT_CONFIG).sort()
  assert.deepEqual(keys, [
    'gcThresholdError',
    'gcThresholdInfo',
    'gcThresholdWarning',
    'memGrowthAlertPerMin',
    'memPollBase',
    'memPollMin',
    'memThresholdCritical',
    'memThresholdError',
    'memThresholdInfo',
    'memThresholdWarning',
  ])
})
