import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFailureDetail } from '../src/index.mjs'

/**
 * The order the two V8 spellings are recognised in is the whole defence.
 *
 * V8 describes a `JSON.parse` failure either by offset -- `Expected ',' or '}'
 * after property value in JSON at position 37` -- or by quoting the input back
 * -- `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. Looking
 * for the offset first is what leaks: a capture file whose own text reads `at
 * position 1` is quoted by V8, the offset search finds that text inside the
 * quoted span, and the slice hands the capture back out. Recognising the
 * quoting shape first is the fix, and these tests fail if it is reverted.
 *
 * The canary is `AKIAIOSFODNN7EXAMPLE`, the access key id AWS publishes in its
 * own documentation. It is not a credential; it is the shape of one, and the
 * shape a scanner watching this tool's output would flag.
 */

const CANARY = 'AKIAIOSFODNN7EXAMPLE'
const UNPARSEABLE = 'the document could not be parsed as JSON'

/** The detail for a document V8 actually refused -- never a hand-written message. */
function detailFor(document) {
  try {
    JSON.parse(document)
  } catch (error) {
    return parseFailureDetail(error)
  }
  throw new Error(`${JSON.stringify(document)} parsed, so it pins nothing`)
}

/** No run of four characters or more from the document survives into the detail. */
function assertNoRunOf(document, detail, label) {
  for (let length = 4; length <= document.length; length += 1) {
    const prefix = document.slice(0, length)
    assert.equal(detail.includes(prefix), false, `${label}: the detail carries ${JSON.stringify(prefix)}`)
  }
}

test('a capture whose own text reads "at position 1" is not sliced back out', () => {
  const document = 'at position 1'
  const detail = detailFor(document)

  assert.equal(detail.includes('"'), false, 'a double quote in the detail means a quoted span survived')
  assert.equal(detail.includes(document), false, 'the capture came back inside its own diagnostic')
  assert.equal(detail, "unexpected token 'a' at the start of the document")
})

test('a capture that is nothing but a credential is not quoted back', () => {
  const detail = detailFor(CANARY)

  assert.equal(detail.includes(CANARY), false)
  assertNoRunOf(CANARY, detail, 'credential-shaped capture')
  assert.equal(detail, "unexpected token 'A' at the start of the document")
})

test('a long capture is not quoted back by its ten-character prefix either', () => {
  const document = `${CANARY} and a great deal of trailing content nobody should read back`
  const detail = detailFor(document)

  assertNoRunOf(document, detail, 'long capture')
  assert.equal(detail, "unexpected token 'A' at the start of the document")
})

test('a credential further into the capture is not quoted back by the windowed spelling', () => {
  const document = `{"pages": 1, "token": ${CANARY}}`
  const detail = detailFor(document)

  assert.equal(detail.includes('"'), false)
  assert.equal(detail.includes(CANARY.slice(0, 4)), false)
  assert.equal(detail, "unexpected token 'A' inside the document")
})

test('a quoted span holding a newline is still recognised as a quoted span', () => {
  // Without the `s` flag the quoting shape does not match a span with a line
  // break in it, the offset branch is reached, and the generic sentence is all
  // that is left -- or worse, the span is sliced out.
  const detail = detailFor('}x\n')

  assert.equal(detail, "unexpected token '}' at the start of the document")
  assert.notEqual(detail, UNPARSEABLE, 'the newline case fell through to the generic sentence')
})

test('the safe positional spelling keeps its position, line and column', () => {
  // A helper that answered the generic sentence for everything would pass every
  // leak test above while destroying every diagnostic. This is the other half.
  const detail = detailFor('{"schemaVersion": "1" "pages": []}')

  assert.match(detail, /at position \d+ \(line \d+ column \d+\)$/)
  assert.equal(detail, "Expected ',' or '}' after property value in JSON at position 22 (line 1 column 23)")
})

test('an empty capture still says the input ended', () => {
  assert.equal(detailFor(''), 'Unexpected end of JSON input')
})

test('a wording this helper was never taught is refused rather than guessed at', () => {
  assert.equal(
    parseFailureDetail(new Error(`Unexpected token 'A', "${CANARY}" is not valid JSON at position 0`)),
    UNPARSEABLE,
    'a double quote surviving to the end means the snippet survived with it',
  )
  assert.equal(parseFailureDetail(new Error('something new from a future V8')), UNPARSEABLE)
  assert.equal(parseFailureDetail(undefined), UNPARSEABLE)
})
