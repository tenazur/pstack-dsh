/**
 * The keyboard probe: every event handler in the violin page, and whether the element under it can
 * be operated from the keyboard by construction.
 *
 * ## Why this is a static probe and not a rendering test
 *
 * `tests/client.spec.ts` already mounts the page through a stand-in React runtime, and that is where
 * behaviour is asserted. What it cannot assert cheaply is the *shape* of each element: the stand-in
 * runtime returns `{type, props}` objects and never consults a DOM, so "is this control a `<button>`"
 * is not a question it answers. The question this probe answers is exactly that one, and it is a
 * question about the source, so it is asked of the source — parsed with the real TypeScript compiler
 * (`typescript` is already a devDependency; no new dependency is introduced).
 *
 * ## The rule
 *
 * An element that carries `onClick`, `onKeyDown` or `onChange` must be a `<button>`, `<select>`,
 * `<input>`, `<a href>` or `<textarea>` — those are focusable and keyboard-operable with no help.
 * Any other tag (`div`, `span`, `li`, …) needs an explicit `role`, a `tabIndex` and its own key
 * handling, and the probe reports it as a defect. `onBlur`/`onFocus` are deliberately **not** in the
 * rule: they are not activations, and a `<select>` or `<input>` carries the ones this page uses.
 *
 * ## Modes
 *
 *   node plugin/specs/page-keyboard.probe.mjs [--file <path>] [--quiet]
 *
 * Exit code: 0 when every handler sits on a keyboard-operable element, 1 when any does not, 2 when
 * the file could not be read or parsed. `--file` exists so the failure mode is demonstrable: point
 * it at a mutated copy carrying a handler on a `<span>` and the probe must exit 1.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')

/**
 * `typescript` is loaded through `createRequire` rather than `import`, because the compiler is a
 * CommonJS package and this file is ESM.
 */
const require = createRequire(import.meta.url)
const ts = require('typescript')

/** Elements that are focusable and keyboard-operable by construction. */
const NATIVE_INTERACTIVE = new Set(['button', 'select', 'input', 'textarea', 'option', 'a', 'summary', 'details'])

/** Elements that are decorative containers; a handler on one of these is the defect. */
const NON_INTERACTIVE = new Set(['div', 'span', 'li', 'ul', 'ol', 'p', 'label', 'h1', 'h2', 'h3', 'h4', 'section', 'article', 'nav'])

/** The handler props the rule cares about: things a keyboard user must be able to trigger. */
const ACTIVATION_PROPS = ['onClick', 'onKeyDown', 'onKeyPress', 'onChange']

/** The props that would make a non-interactive element legitimate, if all are present. */
const APOLOGIES = ['role', 'tabIndex', 'onKeyDown']

/** Parse `argv` into `{ file, quiet }`. */
function parseArgs(argv) {
  let file = join(pluginDir, 'src', 'client', 'client.ts')
  let quiet = false
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file') {
      file = resolve(argv[i + 1] ?? '')
      i += 1
    } else if (argv[i] === '--quiet') {
      quiet = true
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('usage: node plugin/specs/page-keyboard.probe.mjs [--file <path>] [--quiet]')
      process.exit(0)
    }
  }
  return { file, quiet }
}

/**
 * The tag name of a `React.createElement` call, when it is a string literal.
 *
 * Returns `null` for a component (`React.createElement(Tooltip, …)`) or a computed tag. A component
 * is not an element this probe can judge statically, so it is skipped rather than guessed at — which
 * is why `hover()`'s wrapper never appears in the table.
 */
function literalTag(call, sf) {
  const first = call.arguments[0]
  if (first === undefined) return null
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text
  return null
}

/** True when the call is `React.createElement(...)` (also matching a bare `createElement(...)`). */
function isCreateElement(call, sf) {
  const callee = call.expression
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'createElement'
  return ts.isIdentifier(callee) && callee.text === 'createElement'
}

/** The handler props present on an `React.createElement` props object, in source order. */
function handlersOn(call, sf) {
  const props = call.arguments[1]
  if (props === undefined || !ts.isObjectLiteralExpression(props)) return []
  const found = []
  for (const property of props.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const name = property.name.getText(sf).replace(/^['"]|['"]$/g, '')
    if (ACTIVATION_PROPS.includes(name)) found.push(name)
  }
  return found
}

/** True when the props object carries every prop in {@link APOLOGIES}. */
function hasApologies(call, sf) {
  const props = call.arguments[1]
  if (props === undefined || !ts.isObjectLiteralExpression(props)) return false
  const names = props.properties
    .filter(ts.isPropertyAssignment)
    .map((property) => property.name.getText(sf).replace(/^['"]|['"]$/g, ''))
  return APOLOGIES.every((needed) => names.includes(needed))
}

/** The `key:` / `data-*` prop, used to make a row identifiable in the table. */
function markerOf(call, sf) {
  const props = call.arguments[1]
  if (props === undefined || !ts.isObjectLiteralExpression(props)) return ''
  for (const property of props.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const name = property.name.getText(sf).replace(/^['"]|['"]$/g, '')
    if (name === 'key' || name.startsWith('data-')) {
      return `${name}=${property.initializer.getText(sf).replace(/\s+/g, ' ').slice(0, 34)}`
    }
  }
  return ''
}

/**
 * Every `React.createElement` call in the file that carries an activation handler.
 *
 * @returns rows of `{ line, tag, handlers, marker, ok, why }`.
 */
function scanHandlers(source, fileName) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
  const rows = []
  const visit = (node) => {
    if (ts.isCallExpression(node) && isCreateElement(node, sf)) {
      const handlers = handlersOn(node, sf)
      if (handlers.length > 0) {
        const tag = literalTag(node, sf)
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
        const component = tag === null
        const native = tag !== null && NATIVE_INTERACTIVE.has(tag)
        const known = tag !== null && (NATIVE_INTERACTIVE.has(tag) || NON_INTERACTIVE.has(tag))
        const apologised = !native && hasApologies(node, sf)
        let ok
        let why
        if (component) {
          ok = true
          why = 'component (its own internals are out of this probe’s reach)'
        } else if (native) {
          ok = true
          why = 'keyboard-operable by construction'
        } else if (apologised) {
          ok = true
          why = 'has role + tabIndex + onKeyDown'
        } else if (known) {
          ok = false
          why = 'needs role, tabIndex and key handling'
        } else {
          ok = false
          why = 'unknown tag; cannot be shown keyboard-operable'
        }
        rows.push({ line, tag: tag ?? '(component)', handlers, marker: markerOf(node, sf), ok, why })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { rows, parseErrors: sf.parseDiagnostics ?? [] }
}

/** Pad a cell to a width, for a plain-text table. */
const pad = (value, width) => String(value).padEnd(width)

/** Print the table and return the exit code. */
function report(rows, file, quiet) {
  const headers = ['LINE', 'ELEMENT', 'HANDLERS', 'MARKER', 'VERDICT', 'NOTE']
  const table = rows.map((row) => [
    String(row.line),
    `<${row.tag}>`,
    row.handlers.join(','),
    row.marker,
    row.ok ? 'ok' : 'DEFECT',
    row.why,
  ])
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...table.map((line) => String(line[i]).length), 0),
  )
  const render = (cells) => cells.map((cell, i) => pad(cell, widths[i])).join('  ').trimEnd()

  const defects = rows.filter((row) => !row.ok)
  const natives = rows.filter((row) => row.ok && row.tag !== '(component)').length
  const components = rows.filter((row) => row.tag === '(component)').length

  if (!quiet) {
    console.log(`page-keyboard probe — ${file}`)
    console.log('')
    console.log(render(headers))
    console.log(render(widths.map((width) => '-'.repeat(width))))
    for (const line of table) console.log(render(line))
    console.log('')
  }

  console.log(`handler sites: ${String(rows.length)}`)
  console.log(`native interactive: ${String(natives)}`)
  console.log(`components (skipped): ${String(components)}`)
  console.log(`non-interactive with a handler: ${String(defects.length)}`)

  if (defects.length > 0) {
    console.log('')
    console.log('DEFECTS — a handler sits on an element that cannot be operated from the keyboard:')
    for (const defect of defects) {
      console.log(
        `  ${file}:${String(defect.line)} <${defect.tag}> carries ${defect.handlers.join(', ')} — ${defect.why}`,
      )
    }
    console.log('')
    console.log('exit 1: every defect above needs role + tabIndex + key handling, or must become a <button>.')
    return 1
  }

  console.log('')
  console.log('exit 0: every activation handler sits on a keyboard-operable element.')
  return 0
}

const { file, quiet } = parseArgs(process.argv.slice(2))
let source
try {
  source = readFileSync(file, 'utf8')
} catch (failure) {
  console.error(`probe: cannot read ${file}: ${failure instanceof Error ? failure.message : String(failure)}`)
  process.exit(2)
}

const { rows, parseErrors } = scanHandlers(source, file)
if (parseErrors.length > 0) {
  console.error(`probe: ${file} has ${String(parseErrors.length)} parse error(s); the verdict would be a guess`)
  for (const diagnostic of parseErrors.slice(0, 5)) {
    console.error(`  ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`)
  }
  process.exit(2)
}
if (rows.length === 0) {
  console.error(
    `probe: found no handler at all in ${file} — the page cannot have become handler-free, so this is a broken scan, not a clean file`,
  )
  process.exit(2)
}

process.exit(report(rows, file, quiet))
