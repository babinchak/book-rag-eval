import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildCanonicalBookDocument,
  buildCanonicalSpineDocument,
  CANONICAL_DOCUMENT_SCHEMA_VERSION,
  CANONICAL_PARSER_VERSION
} from '../src/shared/canonicalDocument'

const XHTML = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head>
    <title>Ignored title</title>
    <style>.hidden { display: none }</style>
  </head>
  <body>
    <section>
      <h1 id="chapter-one">Chapter &amp; One</h1>
      <p>Alpha&nbsp;beta <em>gamma</em>.</p>
      <blockquote>Quoted <strong>claim</strong>.</blockquote>
      <ul><li>First item</li><li>Second item</li></ul>
      <table id="comparison">
        <caption>Comparison</caption>
        <tr><th>View</th><th>Value</th></tr>
        <tr><td>A</td><td>10</td></tr>
      </table>
      <aside epub:type="footnote" id="fn-1">A useful footnote.</aside>
      <figure id="diagram">
        <img src="../images/diagram.png" alt="A logical diagram" />
        <figcaption>Figure one</figcaption>
      </figure>
      <script>ignored()</script>
    </section>
  </body>
</html>`

test('builds deterministic canonical nodes with stable offsets and relationships', () => {
  const first = buildCanonicalSpineDocument('book-1', 0, {
    href: 'OPS/text/chapter-1.xhtml',
    rawHtml: XHTML
  })
  const second = buildCanonicalSpineDocument('book-1', 0, {
    href: 'OPS/text/chapter-1.xhtml',
    rawHtml: XHTML
  })

  assert.deepEqual(first, second)
  assert.deepEqual(
    first.nodes.map((node) => node.kind),
    ['heading', 'paragraph', 'blockquote', 'list', 'list', 'table', 'footnote', 'image']
  )
  assert.equal(first.nodes[0].text, 'Chapter & One')
  assert.equal(first.nodes[1].text, 'Alpha beta gamma.')
  assert.equal(first.nodes[5].text, 'Comparison\nView | Value\nA | 10')
  assert.deepEqual(first.nodes[5].table, {
    caption: 'Comparison',
    rows: [
      ['View', 'Value'],
      ['A', '10']
    ]
  })
  assert.deepEqual(first.nodes[7].image, {
    alt: 'A logical diagram',
    caption: 'Figure one'
  })
  assert.deepEqual(first.nodes[7].source.assets, [
    {
      kind: 'image',
      rawHref: '../images/diagram.png',
      resolvedHref: 'OPS/images/diagram.png'
    }
  ])

  for (const [index, node] of first.nodes.entries()) {
    assert.equal(first.text.slice(node.textStart, node.textEnd), node.text)
    assert.equal(node.ordinal, index)
    assert.equal(node.previousNodeId, first.nodes[index - 1]?.id ?? null)
    assert.equal(node.nextNodeId, first.nodes[index + 1]?.id ?? null)
  }
})

test('tracks the active heading hierarchy on every node', () => {
  const spine = buildCanonicalSpineDocument('book-1', 0, {
    href: 'text.xhtml',
    rawHtml:
      '<html><body><h1>Part</h1><p>Opening.</p><h2>Section</h2><p>Detail.</p><h1>Next</h1><p>Reset.</p></body></html>'
  })

  assert.deepEqual(
    spine.nodes.map((node) => node.headingPath.map((heading) => heading.text)),
    [['Part'], ['Part'], ['Part', 'Section'], ['Part', 'Section'], ['Next'], ['Next']]
  )
})

test('book identity changes with source content but not repeated parsing', () => {
  const source = [{ href: 'chapter.xhtml', rawHtml: '<p>Same text.</p>' }]
  const first = buildCanonicalBookDocument('book-1', source)
  const second = buildCanonicalBookDocument('book-1', source)
  const changed = buildCanonicalBookDocument('book-1', [
    { href: 'chapter.xhtml', rawHtml: '<p>Changed text.</p>' }
  ])

  assert.equal(first.schemaVersion, CANONICAL_DOCUMENT_SCHEMA_VERSION)
  assert.equal(first.parserVersion, CANONICAL_PARSER_VERSION)
  assert.equal(first.sourceHash, second.sourceHash)
  assert.notEqual(first.sourceHash, changed.sourceHash)
  assert.deepEqual(first, second)
})
