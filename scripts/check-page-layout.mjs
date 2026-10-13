/**
 * Measure the rendered violin page, because a picture is not a check.
 *
 * Twice in one session a layout defect was diagnosed from a screenshot and diagnosed wrongly — the
 * chip whose label had been squeezed out, and the "control wider than its card" that was really the
 * page being widened by a flex item that refused to shrink. Both are one line of arithmetic on
 * `getBoundingClientRect`, which is what this script does:
 *
 * 1. **nothing crosses its card** — every `select`, `input` and `button` inside a violin card ends at
 *    or before that card's right edge, and starts at or after its left edge;
 * 2. **the page does not scroll sideways** — `documentElement.scrollWidth` is not wider than the
 *    window, which is the symptom a person sees first and the cause of (1) when it trips;
 * 3. **a chip keeps its label** — every `[data-pchip-label]` has a non-zero box, i.e. the task name
 *    survived the flex row it sits in.
 *
 * It renders the **built** bundle (`plugin/lib/client.js`) in headless Chromium against a payload
 * captured from a live Host, with React cut from the shell's own bundle by
 * `scripts/page-harness/extract-react.mjs` and the shell's design tokens stubbed in CSS. It needs
 * `/usr/bin/chromium`; without it the check **skips with a printed reason** rather than passing.
 *
 *   node scripts/check-page-layout.mjs [payload.json]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const payloadPath = process.argv[2] ?? join(repo, 'plugin/tests/fixtures/fleet-view.live.json')
const bundle = join(repo, 'plugin/lib/client.js')
// Everything the harness needs is committed beside the gate or generated from the shell bundle.
// A dependency on a gitignored directory would be one a fresh clone cannot satisfy, and the gates
// used to have several; they now write to a temp directory and read only tracked fixtures.
const harness = join(repo, 'scripts/page-harness')
const react = join(harness, 'react-from-shell.js')
const tokens = readFileSync(join(harness, 'tokens.css'), 'utf8')
const page = join(harness, 'layout-page.html')
const profile = join(harness, '.chrome-profile')

if (!existsSync('/usr/bin/chromium')) {
  console.log('SKIP: /usr/bin/chromium is not installed, so the page was not measured')
  process.exit(0)
}
if (!existsSync(bundle)) {
  console.error(`FAIL: ${bundle} is missing; run \`npm run build\` in plugin/ first`)
  process.exit(1)
}
if (!existsSync(react)) {
  console.error(
    `FAIL: ${react} is missing; run \`node scripts/page-harness/extract-react.mjs\` first (it cuts React out of the shell bundle this machine already has)`,
  )
  process.exit(1)
}

const payload = readFileSync(payloadPath, 'utf8')
const source = readFileSync(bundle, 'utf8')

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${tokens}</style></head>
<body><div id="root"></div>
<script src="./react-from-shell.js"></script>
<script>window.__PAYLOAD__ = ${payload};
window.__ModuleLoader__ = { load: (r) => { window.__reg = r } };</script>
<script>${source}</script>
<script>
;(function () {
  const React = window.__REACT__
  const Tooltip = (p) => React.createElement('span', null, [p.children])
  const mod = window.__reg.factory((id) => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Tooltip }
    throw new Error('unexpected require ' + id)
  })
  // A stub must answer **every** service the bundle declares, not just the one this gate reads: a
  // missing one makes the page return early, and the gate then measures an empty document and calls
  // it a pass. This bundle declares \`slots\` alone — the page reads its data over HTTP — so the
  // stub below answers exactly that, and an added service would be caught by the inject assertion
  // in \`plugin/tests/client-exec.spec.ts\` rather than silently measured as an empty page.
  const slotRegistrations = { 'settings.section': [] }
  const slots = {
    inject: (_name, cb) => cb(),
    register: (options, r) => {
      const seat = options && options.name
      if (seat === 'settings.section') slotRegistrations['settings.section'].push(r)
      return () => {}
    },
  }
  mod.apply({ get: (n) => (n === 'slots' ? slots : undefined) })
  const render = slotRegistrations['settings.section'][0]
  if (!render) throw new Error('the bundle registered no settings.section seat, so there is no page to measure')
  window.fetch = () => Promise.resolve({ ok: true, status: 200, statusText: '', json: async () => window.__PAYLOAD__ })
  window.__REACT_DOM__.createRoot(document.getElementById('root')).render(React.createElement(render))
  // Open every violin: a closed card hides the bodies, which is where the controls are.
  setTimeout(() => { for (const h of document.querySelectorAll('[data-pviolin-header]')) h.click() }, 300)
  setTimeout(() => {
    // A measurement is only meaningful against a real viewport: --dump-dom lays the page out in a
    // 0px window, where every box is pre-layout and "the card ends at 24" means nothing. The width
    // below is the window the numbers were taken in, and the check reports it.
    const out = { problems: [], width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }
    const round = (n) => Math.round(n * 10) / 10
    // What each check actually had in front of it. A check that found nothing to look at has not
    // passed: it measured an empty set, and "no violations" is then a statement about the selector
    // rather than about the page. These counts are what the script refuses on, below.
    out.counts = { cards: 0, controls: 0, chipLabels: 0, headerButtons: 0 }
    for (const card of document.querySelectorAll('[data-pviolin]')) {
      out.counts.cards += 1
      const box = card.getBoundingClientRect()
      const id = card.getAttribute('data-pviolin')
      out.counts.headerButtons += card.querySelectorAll('[data-pviolin-header]').length
      for (const control of card.querySelectorAll('select, input, button')) {
        const c = control.getBoundingClientRect()
        if (c.width === 0 && c.height === 0) continue
        out.counts.controls += 1
        if (c.right > box.right + 1) out.problems.push(id + ': <' + control.tagName.toLowerCase() + '> ends at ' + round(c.right) + ', card ends at ' + round(box.right))
        if (c.left < box.left - 1) out.problems.push(id + ': <' + control.tagName.toLowerCase() + '> starts at ' + round(c.left) + ', card starts at ' + round(box.left))
      }
    }
    for (const label of document.querySelectorAll('[data-pchip-label]')) {
      out.counts.chipLabels += 1
      const box = label.getBoundingClientRect()
      if (box.width < 4 || box.height < 4) out.problems.push('chip label "' + label.textContent + '" has no box (' + round(box.width) + 'x' + round(box.height) + ')')
    }
    if (out.scrollWidth > out.width + 1) {
      out.problems.push('the page scrolls sideways: content is ' + out.scrollWidth + 'px in a ' + out.width + 'px window')
      // Name the widest offenders: a count says something is wrong, this says what.
      const chain = []
      const widestEl = [...document.querySelectorAll('*')].sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0]
      for (let el = widestEl; el !== null && el !== document.body; el = el.parentElement) {
        const cs = getComputedStyle(el)
        chain.push(el.tagName.toLowerCase() + ' w=' + round(el.getBoundingClientRect().width) + ' minW=' + cs.minWidth + ' maxW=' + cs.maxWidth + ' ovf=' + cs.overflowX + ' disp=' + cs.display + ' flex=' + cs.flex + ' ws=' + cs.whiteSpace)
      }
      out.chain = chain
      const widest = [...document.querySelectorAll('*')]
        .map((el) => ({ el, box: el.getBoundingClientRect() }))
        .filter((entry) => entry.box.width > out.width)
        .sort((a, b) => b.box.width - a.box.width)
        .slice(0, 5)
      for (const entry of widest) {
        const path = []
        for (let el = entry.el; el !== null && el !== document.body && path.length < 5; el = el.parentElement) {
          const marks = ['data-pviolin', 'data-pviolin-task', 'data-pfleet-band', 'style'].map((a) => (a === 'style' ? '' : el.getAttribute(a))).filter(Boolean)
          path.push(el.tagName.toLowerCase() + (marks.length > 0 ? '[' + marks.join(',') + ']' : ''))
        }
        out.problems.push('  widest: <' + entry.el.tagName.toLowerCase() + '> ' + round(entry.box.width) + 'px :: ' + path.join(' < ') + ' :: "' + String(entry.el.textContent ?? '').slice(0, 40) + '"')
      }
    }
    // Refuse to report on an unlaid page: when the window has no width, or the page root did not lay
    // out, every box below is pre-layout and the numbers are air rather than evidence.
    const rootBox = document.getElementById('root').getBoundingClientRect()
    if (window.innerWidth < 320 || rootBox.width < 100) {
      out.unlaid = true
      out.rootWidth = round(rootBox.width)
    }
    document.body.setAttribute('data-layout-report', JSON.stringify(out))
  }, 800)
})()
</script></body></html>`

writeFileSync(page, html)
/**
 * Measure over the DevTools protocol rather than a dumped DOM.
 *
 * `--dump-dom` lays this page out in a 0px window on this machine, which is how three "fixes" in one
 * session were aimed at numbers that were never a layout. Over the protocol the viewport is explicit
 * (`Emulation.setDeviceMetricsOverride`), the page is given time to paint, and the report the page
 * writes onto `<body>` is read back with `Runtime.evaluate`. The script refuses to report if the page
 * root measured nothing, so a harness fault can never be mistaken for a page defect.
 */
const port = 9333
const chrome = spawn('/usr/bin/chromium', [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--hide-scrollbars',
  `--remote-debugging-port=${String(port)}`,
  '--user-data-dir=' + profile,
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const stop = (code, message) => {
  chrome.kill('SIGKILL')
  if (message !== undefined) console.error(message)
  process.exit(code)
}

try {
  let target = null
  for (let attempt = 0; attempt < 40 && target === null; attempt += 1) {
    await sleep(250)
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`)
      const list = await response.json()
      target = list.find((entry) => entry.type === 'page') ?? null
    } catch {
      target = null
    }
  }
  if (target === null) stop(1, 'FAIL: chromium did not expose a debugging target')

  const socket = new WebSocket(target.webSocketDebuggerUrl)
  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    const waiter = pending.get(message.id)
    if (waiter !== undefined) {
      pending.delete(message.id)
      waiter(message)
    }
  })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(undefined))
    socket.addEventListener('error', () => reject(new Error('the debugging socket refused the connection')))
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++
      pending.set(id, resolve)
      socket.send(JSON.stringify({ id, method, params }))
    })

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 720,
    height: 1600,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await send('Page.navigate', { url: 'file://' + page })
  await sleep(1800)

  const answer = await send('Runtime.evaluate', {
    expression: 'document.body.getAttribute("data-layout-report")',
    returnByValue: true,
  })
  const raw = answer.result?.result?.value
  if (typeof raw !== 'string') stop(1, 'FAIL: the page produced no report; it did not finish rendering')

  const report = JSON.parse(raw)
  if (report.unlaid === true) {
    stop(
      1,
      `FAIL: the page never laid out (window ${String(report.width)}px, page root ${String(report.rootWidth)}px), so no measurement was taken. ` +
        'This is a fault in the harness, not in the page.',
    )
  }
  if (process.env.DSH_LAYOUT_CHAIN === '1' && report.chain !== undefined) {
    console.log('widest element ancestry:')
    for (const line of report.chain) console.log('  ' + line)
  }
  for (const problem of report.problems) console.log('  ✖ ' + problem)
  if (report.problems.length > 0) stop(1, `LAYOUT: ${String(report.problems.length)} problem(s)`)
  // A check whose selector matched nothing has measured an empty set, and "no violations" then says
  // something about the selector, not the page. That is a vacuous pass: it is how a rename in the
  // bundle turns this gate green forever. Name every empty subject and refuse, rather than reporting
  // OK on a page that was never looked at.
  const counts = report.counts ?? {}
  const expected = [
    { key: 'cards', what: 'violin cards ([data-pviolin])' },
    { key: 'headerButtons', what: 'card header buttons ([data-pviolin-header])' },
    { key: 'controls', what: 'controls inside a card (select, input, button)' },
    { key: 'chipLabels', what: 'chip labels ([data-pchip-label])' },
  ]
  const empty = expected.filter((entry) => !(Number(counts[entry.key]) > 0))
  if (counts.cards === undefined) {
    stop(
      1,
      'FAIL: the page reported no element counts, so nothing proves the checks had a subject. ' +
        'This is a fault in the harness, not in the page.',
    )
  }
  if (empty.length > 0) {
    for (const entry of empty) console.log('  ✖ nothing matched: ' + entry.what)
    stop(
      1,
      `FAIL: ${String(empty.length)} of ${String(expected.length)} checks had nothing to measure (` +
        empty.map((entry) => entry.key).join(', ') +
        '), so a pass would be vacuous. Measured: ' +
        expected.map((entry) => entry.key + '=' + String(counts[entry.key])).join(', ') +
        '. A rename or a bundle that renders no cards is the usual cause.',
    )
  }
  stop(
    0,
    `LAYOUT OK: no control crosses its card, every chip keeps its label, the page does not scroll sideways (${String(report.width)}px; measured ` +
      expected.map((entry) => entry.key + '=' + String(counts[entry.key])).join(', ') +
      ')',
  )
} catch (error) {
  stop(1, `FAIL: the layout harness broke: ${error instanceof Error ? error.message : String(error)}`)
}
