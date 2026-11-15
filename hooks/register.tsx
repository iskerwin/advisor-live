import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Live, Trigger } from '../types'

const PANE = 'advisor-live'
// Wide enough for the longest row: "▶ before calling it done" and its count.
const COLUMNS = 34
const PANE_ARGS = { id: PANE, title: 'Advisor', backgroundColor: 'transparent', columns: COLUMNS } as const
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

// The advisor keeps one color throughout; states use the theme's own keys so
// they read on light and dark themes alike.
const VIOLET = '#a78bfa'
const MAIN = 'suggestion'
const COLOR: Record<Trigger, string> = { plan: VIOLET, error: 'error', done: 'success', other: 'subtle' }
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const ZERO: Record<Trigger, number> = { plan: 0, error: 0, done: 0, other: 0 }
const fresh: Live = {
  calls: [], counts: ZERO, repeats: 0, lastError: '', hasEdited: false,
  mainBusy: false, mainModel: '', advisorModel: null, launchPid: '',
  quietTurns: 0, turnWorked: false, turnCalled: false, turnStartedAt: 0,
}
const tick = atom({ plugin: 'advisor-live', key: 'tick' } as const, 0)
const live = atom({ plugin: 'advisor-live', key: 'live' } as const, fresh, { shape: 'live-7' })

// The calls the trace plots, one per cell at most; the totals live in
// `counts`, so they never cap.
const RECENT = 32

// A model as people say it: `claude-opus-5-5` and `opus[1m]` read `Opus 5.5`
// and `Opus`. A name the engine already wrote for people (`Fable 5.2`) stays.
export const modelName = (m: string | null): string => {
  if (m === null) return 'off'
  if (m === '') return '…'
  if (/[A-Z ]/.test(m)) return m
  const parts = m.replace(/\[.*\]$/, '').split('-').filter(p => p !== 'claude')
  const family = parts.find(p => /^[a-z]+$/.test(p))
  if (!family) return m
  const version = parts.filter(p => /^\d{1,2}$/.test(p)).join('.')
  return `${family[0]!.toUpperCase()}${family.slice(1)}${version ? ` ${version}` : ''}`
}

// The advisor after `/advisor <args>` ran, judged by the `advisorModel`
// setting before and after: the terminal's `/advisor` writes what it set there
// and removes it for `off`; a refusal writes nothing. Undefined: no change. A
// built-in's output never reaches a mod, so the setting is what there is.
export const advisorAfter = (args: string, before: unknown, after: unknown): string | null | undefined => {
  const wanted = args.trim()
  if (typeof after !== 'string' || after === '') return wanted === 'off' || before !== after ? null : undefined
  return after !== before || wanted === after ? after : undefined
}

// The advisor a launch named: `--advisor fable` or `--advisor=fable` on the
// command line that started this session.
export const advisorFromArgv = (command: string): string | undefined =>
  /(?:^|\s)--advisor(?:=|\s+)(\S+)/.exec(command)?.[1]

// A span of time in its largest whole unit: `42s`, `11m`, `3h`.
export const ago = (ms: number): string => {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  return `${Math.floor(sec / 3600)}h`
}

// A turn's running time on a clock face: `0:27`, `12:03`.
export const clockFace = (ms: number): string => {
  const sec = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}

// A braille graph of `values`, newest at the right, four dots of height per
// row, filled from the bottom against the largest. Few values get wider bars
// (up to two cells and a gap); many get a cell each, the oldest dropped.
const DOTS = [0x40 | 0x80, 0x04 | 0x20, 0x02 | 0x10, 0x01 | 0x08]
export const graph = (values: number[], width: number, height: number): string[] => {
  const top = Math.max(1, ...values)
  const step = Math.max(1, Math.min(3, Math.floor(width / Math.max(1, values.length))))
  const shown = values.slice(-Math.floor(width / step))
  const bars = shown.flatMap(v => {
    const level = v > 0 ? Math.max(1, Math.round((v / top) * height * 4)) : 0
    return step === 1 ? [level] : [...Array<number>(step - 1).fill(level), 0]
  })
  const levels = [...Array<number>(width - bars.length).fill(0), ...bars]
  return Array.from({ length: height }, (_, r) => {
    const base = (height - 1 - r) * 4
    return levels
      .map(level => {
        const bits = DOTS.reduce((b, dot, k) => (level > base + k ? b | dot : b), 0)
        return bits === 0 ? ' ' : String.fromCharCode(0x2800 + bits)
      })
      .join('')
  })
}

const LABEL: Record<Trigger, string> = {
  plan: 'before the plan locks',
  error: 'same error twice',
  done: 'before calling it done',
  other: 'checking in',
}
const SHORT: Record<Trigger, string> = { plan: 'plan', error: 'error', done: 'done', other: 'check' }
const CARDS: Trigger[] = ['plan', 'error', 'done']

// btop's default theme: each box its own muted outline, titles bright, the
// graph hot at the top, unlit meter cells nearly black.
const BOX = { link: '#5c588d', latency: '#556d59', moments: '#6c6c4b', calls: '#805252' }
const TITLE = '#eeeeee'
const UNLIT = '#3d3d3d'
const HEAT = ['#dc4c4c', '#cbc06c', '#77ca9b']
const GRAPH_ROWS = 3

// Drawing helpers: every glyph the pane draws takes one cell.
const run = (n: number, ch: string) => ch.repeat(Math.max(0, n))
const cells = (t: string) => [...t].length

// What the advisor was asked for, judged from what the turn has done so far:
// the same failure twice in a row is a loop; a step that ends the turn is the
// finish line; anything before the first file write is the plan; the rest is a
// check-in between the two.
const classify = (s: Live, endsTurn: boolean): Trigger =>
  s.repeats >= 2 ? 'error' : endsTurn ? 'done' : s.hasEdited ? 'other' : 'plan'

const total = (s: Live) => s.counts.plan + s.counts.error + s.counts.done + s.counts.other

// What stands for an advisor that calls prove is on but nothing named.
const UNNAMED = 'advisor'
const advisorLabel = (s: Live) =>
  s.advisorModel === UNNAMED ? 'Advisor' : `${modelName(s.advisorModel)} advisor`

const building = (s: Live) => `${modelName(s.mainModel)} building`
// An advisor that is set but never called through this many working turns
// is likely not running: one less capable than the main model never activates,
// and nothing else says so.
const QUIET_TURNS = 3
const isQuiet = (s: Live) => s.advisorModel !== null && s.quietTurns >= QUIET_TURNS

const status = (s: Live) => {
  if (s.advisorModel === null) return `${modelName(s.mainModel)} · advisor off`
  const advisor = advisorLabel(s)
  if (isQuiet(s)) return `${advisor} idle · ${s.quietTurns} turns`
  const last = s.calls[s.calls.length - 1]
  return last ? `${advisor} ×${total(s)} · ${LABEL[last.trigger]}` : `${advisor} on call`
}

// The pane's clock: the spinner's frames while the main loop works, a slow
// beat while calls are listed so "12s ago" and the fresh highlight move on
// after the turn, and nothing otherwise. Kept in the module: a reload starts
// it again from `session.start`.
const BUSY_MS = 140
const IDLE_MS = 5000
// How long a call stays highlighted.
const FRESH_MS = 6000
let ticker: { cancel: () => void } | undefined
let tickerMs = 0
const pace = ($: EngineInterface, s: Live) => {
  const ms = s.mainBusy ? BUSY_MS : s.calls.length > 0 ? IDLE_MS : 0
  if (ms === tickerMs) return
  ticker?.cancel()
  tickerMs = ms
  ticker = ms > 0 ? $.clock.every(ms, () => void update($, tick, n => n + 1)) : undefined
}

// `--advisor` sets the session's advisor without writing it to settings, and
// no API reads it back, so the launch's own command line is read: the shell's
// parent is the Claude Code process that ran it. Failing that, the setting.
// Read once per process: a reload starts the session again in the same
// process, after `/advisor` may have changed what the flag said.
const startingAdvisor = async ($: EngineInterface, s: Live): Promise<Pick<Live, 'advisorModel' | 'launchPid'>> => {
  let launchPid = ''
  try {
    const { stdout } = await $.process.run(
      ['/bin/sh', '-c', 'echo "$PPID"; ps -o command= -p "$PPID"'],
      { timeoutMs: 3000 },
    )
    const [pid = '', command = ''] = stdout.trim().split('\n')
    launchPid = pid
    if (pid !== '' && pid === s.launchPid) return { advisorModel: s.advisorModel, launchPid }
    const flagged = advisorFromArgv(command)
    if (flagged !== undefined) return { advisorModel: flagged === 'off' ? null : flagged, launchPid }
  } catch {}
  const set = await $.settings.read({ key: 'advisorModel' })
  return { advisorModel: typeof set === 'string' && set !== '' ? set : null, launchPid }
}

// The models of a session that ended, for the one that follows in this process.
let carried: Pick<Live, 'mainModel' | 'advisorModel' | 'launchPid'> | undefined

const start = async ($: EngineInterface) => {
  const advisor = await startingAdvisor($, await read($, live))
  const mainModel = await $.session.model()
  await update($, live, s => ({ ...s, ...advisor, mainModel }))
}

// How long `/advisor`'s write to settings may take to read back. A refusal
// writes nothing, so it waits this long and changes nothing.
const SETTLE_MS = 2000
const SETTLE_STEP_MS = 100

const recordAdvisor = async ($: EngineInterface, args: string, before: unknown) => {
  const advisorModel = () => $.settings.read({ key: 'advisorModel' })
  let advisor = advisorAfter(args, before, await advisorModel())
  for (let waited = 0; advisor === undefined && waited < SETTLE_MS; waited += SETTLE_STEP_MS) {
    await $.clock.sleep(SETTLE_STEP_MS)
    advisor = advisorAfter(args, before, await advisorModel())
  }
  if (advisor === undefined) return
  await update($, live, s => ({ ...s, advisorModel: advisor, quietTurns: 0 }))
  $.ui.status(status(await read($, live)))
}

// After `/model` or `/advisor`: the main model as `/model` shows it, and the
// advisor by what `/advisor` did to its setting, read in the background so the
// command is not held while it settles. Either switch starts the idle count
// over: it measures this pair of models.
const SWITCHES = ['model', 'advisor'] as const

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'advisor-live',
      description: 'Open the live advisor pane',
    })
    await start($)
    void $.ui.open(PANE_ARGS)
    const s = await read($, live)
    pace($, s)
    $.ui.status(status(s))
    return next(e)
  })

  // A `/clear` or `/resume` goes on in the same process under a new session,
  // with no `session.start` and the session's values gone: the models carry
  // over from the one that ended, its calls and counts do not.
  on('session.end', async ($, e, next) => {
    const { mainModel, advisorModel, launchPid } = await read($, live)
    carried = { mainModel, advisorModel, launchPid }
    return next(e)
  })
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear' || e.source === 'resume') {
      if (carried) await update($, live, () => ({ ...fresh, ...carried }))
      else await start($)
      carried = undefined
      const s = await read($, live)
      pace($, s)
      $.ui.status(status(s))
    }
    return next(e)
  })

  on('command.run', { command: 'advisor-live' }, async $ => {
    await $.ui.open(PANE_ARGS)
    return { text: 'Advisor pane opened.' }
  })

  for (const command of SWITCHES) {
    on('command.run', { command }, async ($, e, next) => {
      const before = await $.settings.read({ key: 'advisorModel' })
      const ran = await next(e)
      const mainModel = await $.session.model()
      await update($, live, s => ({ ...s, mainModel, quietTurns: mainModel === s.mainModel ? s.quietTurns : 0 }))
      $.ui.status(status(await read($, live)))
      if (command === 'advisor') void recordAdvisor($, e.args, before).catch(() => {})
      return ran
    })
  }

  // A subagent's turns start and complete inside the main one: only the main
  // loop's own count here.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // Nothing named the models yet: the session's values were lost, so read
    // them again as a start would.
    if ((await read($, live)).mainModel === '') await start($)
    const now = await $.clock.now()
    await update($, live, s => ({
      ...s, mainBusy: true, turnStartedAt: now, repeats: 0, lastError: '', hasEdited: false, turnWorked: false, turnCalled: false,
    }))
    pace($, await read($, live))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const failed = ran.isError === true
    // A subagent's edits lock the plan too, but its failures and successes
    // are its own: they neither make nor break the main loop's repeat.
    const isMain = e.agentId === undefined
    const message = failed ? `${e.tool}:${String((ran as { text?: unknown }).text ?? '').slice(0, 80)}` : ''
    await update($, live, s => ({
      ...s,
      hasEdited: s.hasEdited || (!failed && EDIT_TOOLS.has(e.tool)),
      ...(isMain && {
        turnWorked: true,
        repeats: !failed ? 0 : message === s.lastError ? s.repeats + 1 : 1,
        lastError: message,
      }),
    }))
    return ran
  })

  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    if (isMain) {
      await update($, live, s => ({ ...s, mainBusy: true, mainModel: e.model }))
      $.ui.status(building(await read($, live)))
    }
    const r = yield* next(e)

    if (isMain) {
      const used = (r.serverToolUses ?? []).filter(u => u.name === 'advisor')
      if (used.length > 0) {
        const now = await $.clock.now()
        const endsTurn = r.toolUses.length === 0 && r.stopReason === 'end_turn'
        const trigger = classify(await read($, live), endsTurn)
        await update($, live, s => ({
          ...s,
          // A call proves the advisor is on even where nothing named it.
          advisorModel: s.advisorModel ?? UNNAMED,
          quietTurns: 0,
          turnCalled: true,
          counts: { ...s.counts, [trigger]: s.counts[trigger] + used.length },
          calls: [
            ...s.calls,
            ...used.map(u => ({ id: u.id, trigger, ms: (u.endedAt ?? u.startedAt) - u.startedAt, at: u.endedAt ?? now })),
          ].slice(-RECENT),
        }))
      }
      const s = await read($, live)
      $.ui.status(used.length > 0 ? status(s) : building(s))
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await update($, live, s => ({
      ...s,
      mainBusy: false,
      quietTurns: s.turnWorked && !s.turnCalled ? s.quietTurns + 1 : s.quietTurns,
    }))
    const s = await read($, live)
    pace($, s)
    $.ui.status(status(s))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, live)
    const frame = await read($, tick)
    const now = await $.clock.now()
    const W = Math.max(24, (e.props.bodyColumns ?? COLUMNS) - 2)
    const CW = W - 4
    const last = s.calls[s.calls.length - 1]
    const isOff = s.advisorModel === null
    const quiet = isQuiet(s)
    const isFresh = last !== undefined && now - last.at < FRESH_MS
    const n = total(s)
    const shown: Trigger[] = s.counts.other > 0 ? [...CARDS, 'other'] : CARDS
    const secs = (v: number) => `${(v / 1000).toFixed(1)}s`

    // A box as btop draws one: `╭─┐title┌───┐right┌─╮`, the rows between
    // `│` bars, an optional label set into the bottom edge.
    const edge = (left: string, right: string, color: string, label = '', title = '') => {
      const head = title
      const fill = W - 2 - (head ? cells(head) + 3 : 0) - (label ? cells(label) + 3 : 0)
      const [open, close] = left === '╭' ? ['┐', '┌'] : ['┘', '└']
      return (
        <Text>
          <Text color={color}>{left}{head ? `─${open}` : ''}</Text>
          {head && <Text bold color={TITLE}>{title}</Text>}
          <Text color={color}>{head ? close : ''}{run(fill, '─')}{label ? open : ''}</Text>
          {label && <Text color={TITLE}>{label}</Text>}
          <Text color={color}>{label ? `${close}─` : ''}{right}</Text>
        </Text>
      )
    }
    const box = (title: string, color: string, rows: JSX.Element[], top = '', foot = '') => (
      <Box key={title} flexDirection="column">
        {edge('╭', '╮', color, top, title)}
        {rows.map((row, i) => (
          <Box key={String(i)}>
            <Text color={color}>│</Text>
            <Box width={W - 2} paddingX={1}>{row}</Box>
            <Text color={color}>│</Text>
          </Box>
        ))}
        {edge('╰', '╯', color, foot)}
      </Box>
    )

    // The link: main ━━▶━━ advisor. Gray while off or never called, violet
    // once it answers (bright while fresh, the pulse running while the turn
    // goes on), amber when it has gone quiet.
    const main = modelName(s.mainModel)
    const advisor = `${last && !isOff ? '◆' : '◇'} ${modelName(s.advisorModel)}`
    const link = isOff ? 'inactive' : quiet ? 'warning' : last ? VIOLET : 'subtle'
    const linkRow = (width: number) => {
      const span = Math.max(3, width - cells(main) - cells(advisor) - 2)
      const at = isFresh && s.mainBusy ? frame % span : Math.floor(span / 2)
      return (
        <Box>
          <Text bold color={MAIN}>{main}</Text>
          <Text color={link} dimColor={!isFresh && !quiet}> {run(at, '━')}▶{run(span - at - 1, '━')} </Text>
          <Text bold={!isOff} color={isOff ? 'inactive' : quiet ? 'warning' : VIOLET}>{advisor}</Text>
        </Box>
      )
    }
    const stateRow = (
      <Box justifyContent="space-between" flexGrow={1}>
        <Text color={s.mainBusy ? MAIN : 'inactive'}>
          {s.mainBusy ? `${SPIN[frame % SPIN.length]} build ${clockFace(now - s.turnStartedAt)}` : '○ idle'}
        </Text>
        {quiet ? (
          <Text color="warning">idle · {s.quietTurns} turns</Text>
        ) : last && !isOff ? (
          <Text bold={isFresh} color={isFresh ? VIOLET : 'inactive'}>{ago(now - last.at)}</Text>
        ) : null}
      </Box>
    )

    // Short of rows, or minimized to a widget: the link, the state, the counts.
    const rows = e.props.scroll?.bodyRows ?? 30
    const linkRows = 4
    const momentRows = shown.length + 2
    const graphRows = GRAPH_ROWS + 2
    const callRows = 3
    if (e.props.placement === 'widget' || rows < linkRows + momentRows + callRows) {
      return (
        <Box flexDirection="column" paddingX={1}>
          {linkRow(W)}
          {stateRow}
          <Text>
            {CARDS.map((t, i) => (
              <Text key={t}>
                {i > 0 && <Text color="inactive"> · </Text>}
                <Text color={last?.trigger === t ? COLOR[t] : 'inactive'}>{SHORT[t]} </Text>
                <Text bold color={s.counts[t] > 0 ? COLOR[t] : 'inactive'}>{s.counts[t]}</Text>
              </Text>
            ))}
          </Text>
        </Box>
      )
    }

    // The graph comes in when there is room for it and a call to plot; the
    // call list takes every row left over.
    const ms = s.calls.map(c => c.ms)
    const withGraph = n > 0 && rows >= linkRows + graphRows + momentRows + callRows + 1
    const room = rows - linkRows - momentRows - callRows - (withGraph ? graphRows : 0)
    const listed = s.calls.slice(-Math.max(0, room)).reverse()
    const avg = ms.length > 0 ? ms.reduce((a, b) => a + b, 0) / ms.length : 0
    const meter = CW - 6 - 5 - 4
    const tiny = 6
    const slowest = Math.max(1, ...listed.map(c => c.ms))

    return (
      <Box flexDirection="column" paddingX={1}>
        {box('link', BOX.link, [linkRow(CW), stateRow])}

        {withGraph &&
          box(
            'latency', BOX.latency,
            graph(ms, CW, GRAPH_ROWS).map((line, r) => <Text color={HEAT[r]}>{line}</Text>),
            `max ${secs(Math.max(...ms))}`,
            `avg ${secs(avg)}`,
          )}

        {box(
          'moments', BOX.moments,
          shown.map(t => {
            const k = s.counts[t]
            const isLit = last?.trigger === t
            const lit = n === 0 ? 0 : k === 0 ? 0 : Math.max(1, Math.round((k / n) * meter))
            return (
              <Box flexGrow={1}>
                <Box width={6}>
                  <Text bold={isLit} color={isLit ? COLOR[t] : k > 0 ? 'text' : 'inactive'}>{SHORT[t]}</Text>
                </Box>
                <Text color={COLOR[t]}>{run(lit, '■')}</Text>
                <Text color={UNLIT}>{run(meter - lit, '■')}</Text>
                <Box width={5} justifyContent="flex-end">
                  <Text color={k > 0 ? 'text' : 'inactive'}>{n === 0 ? '0' : Math.round((k / n) * 100)}%</Text>
                </Box>
                <Box flexGrow={1} justifyContent="flex-end">
                  <Text bold={k > 0} color={k > 0 ? COLOR[t] : 'inactive'}>{k}</Text>
                </Box>
              </Box>
            )
          }),
        )}

        {box(
          'calls', BOX.calls,
          [
            <Box flexGrow={1}>
              <Box width={7}><Text bold>Moment</Text></Box>
              <Box flexGrow={1} justifyContent="flex-end"><Text bold>Took</Text></Box>
              <Box width={tiny + 1} />
              <Box width={5} justifyContent="flex-end"><Text bold>Ago</Text></Box>
            </Box>,
            ...listed.map((c, i) => {
              const isNew = i === 0 && isFresh
              const lit = Math.max(1, Math.round((c.ms / slowest) * tiny))
              return (
                <Box flexGrow={1}>
                  <Box width={7}>
                    <Text inverse={isNew} color={COLOR[c.trigger]}>{SHORT[c.trigger]}</Text>
                  </Box>
                  <Box flexGrow={1} justifyContent="flex-end">
                    <Text color={isNew ? 'text' : undefined}>{secs(c.ms)}</Text>
                  </Box>
                  <Text> </Text>
                  <Text color={HEAT[2 - Math.min(2, Math.floor((c.ms / slowest) * 3))]}>{run(lit, '■')}</Text>
                  <Text color={UNLIT}>{run(tiny - lit, '■')}</Text>
                  <Box width={5} justifyContent="flex-end">
                    <Text color="inactive">{ago(now - c.at)}</Text>
                  </Box>
                </Box>
              )
            }),
            // Blank rows carry the box to the pane's foot, as btop's list does.
            ...Array.from({ length: Math.max(0, room - listed.length) }, () => <Text> </Text>),
          ],
          n > 0 ? `${n}` : '',
        )}
      </Box>
    )
  })
}
