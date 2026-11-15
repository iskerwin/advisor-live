import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Live, Trigger } from '../types'

const PANE = 'advisor-live'
// Wide enough for the longest card: "▶ before calling it done" and its count.
const COLUMNS = 36
const PANE_ARGS = { id: PANE, title: 'Advisor', backgroundColor: 'transparent', columns: COLUMNS } as const
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

const VIOLET = '#a78bfa'
const BLUE = '#6ea8fe'
const RED = '#f0716b'
const GREEN = '#7ad6a0'
const COLOR: Record<Trigger, string> = { plan: VIOLET, error: RED, done: GREEN, other: 'gray' }
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const BARS = '▁▂▃▄▅▆▇█'

const spark = (ms: number[]) => {
  const top = Math.max(...ms, 1)
  return ms.map(v => BARS[Math.min(7, Math.floor((v / top) * 7.999))]).join('')
}

const fresh: Live = {
  calls: [], repeats: 0, lastError: '', hasEdited: false,
  mainBusy: false, mainModel: '', advisorModel: null, launchPid: '',
  quietTurns: 0, turnWorked: false, turnCalled: false,
}
const tick = atom({ plugin: 'advisor-live', key: 'tick' } as const, 0)
const live = atom({ plugin: 'advisor-live', key: 'live' } as const, fresh, { shape: 'live-5' })

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

const LABEL: Record<Trigger, string> = {
  plan: 'before the plan locks',
  error: 'same error twice',
  done: 'before calling it done',
  other: 'checking in',
}
const SHORT: Record<Trigger, string> = { plan: 'plan', error: 'error', done: 'done', other: 'check' }
const QUESTION: Record<Trigger, string> = {
  plan: 'is this the right approach?',
  error: 'real cause, or a loop?',
  done: 'is it actually finished?',
  other: '',
}
const CARDS: Trigger[] = ['plan', 'error', 'done']

// What the advisor was asked for, judged from what the turn has done so far:
// the same failure twice in a row is a loop; a step that ends the turn is the
// finish line; anything before the first file write is the plan; the rest is a
// check-in between the two.
const classify = (s: Live, endsTurn: boolean): Trigger =>
  s.repeats >= 2 ? 'error' : endsTurn ? 'done' : s.hasEdited ? 'other' : 'plan'

const building = (s: Live) => `${modelName(s.mainModel)} building`
// An advisor that is set but never called through this many working turns
// is likely not running: one less capable than the main model never activates,
// and nothing else says so.
const QUIET_TURNS = 3
const isQuiet = (s: Live) => s.advisorModel !== null && s.quietTurns >= QUIET_TURNS

const status = (s: Live) => {
  if (s.advisorModel === null) return `${modelName(s.mainModel)} · advisor off`
  const advisor = `${modelName(s.advisorModel)} advisor`
  if (isQuiet(s)) return `${advisor} idle · ${s.quietTurns} turns`
  const last = s.calls[s.calls.length - 1]
  return last ? `${advisor} ×${s.calls.length} · ${LABEL[last.trigger]}` : `${advisor} on call`
}

let spinner: { cancel: () => void } | undefined

// `--advisor` sets the session's advisor without writing it to settings, and
// no API reads it back, so the launch's own command line is read: the shell's
// parent is the Claude Code process that ran it. Failing that, the setting.
// Read once per process: a reload or `/clear` starts the session again in the
// same process, after `/advisor` may have changed what the flag said.
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
// command is not held while it settles.
const SWITCHES = ['model', 'advisor'] as const

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'advisor-live',
      description: 'Open the live advisor pane',
    })
    const advisor = await startingAdvisor($, await read($, live))
    const mainModel = await $.session.model()
    await update($, live, s => ({ ...s, ...advisor, mainModel }))
    void $.ui.open(PANE_ARGS)
    $.ui.status(status(await read($, live)))
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
      await update($, live, s => ({ ...s, mainModel }))
      $.ui.status(status(await read($, live)))
      if (command === 'advisor') void recordAdvisor($, e.args, before).catch(() => {})
      return ran
    })
  }

  // A subagent's turns start and complete inside the main one: only the main
  // loop's own count here.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await update($, live, s => ({ ...s, repeats: 0, lastError: '', hasEdited: false, turnWorked: false, turnCalled: false }))
    spinner ??= $.clock.every(140, () => void update($, tick, n => n + 1))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const failed = ran.isError === true
    const message = failed ? `${e.tool}:${String((ran as { text?: unknown }).text ?? '').slice(0, 80)}` : ''
    await update($, live, s => ({
      ...s,
      hasEdited: s.hasEdited || (!failed && EDIT_TOOLS.has(e.tool)),
      turnWorked: s.turnWorked || e.agentId === undefined,
      repeats: !failed ? 0 : message === s.lastError ? s.repeats + 1 : 1,
      lastError: message,
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
          advisorModel: s.advisorModel ?? 'advisor',
          quietTurns: 0,
          turnCalled: true,
          calls: [
            ...s.calls,
            ...used.map(u => ({ id: u.id, trigger, ms: (u.endedAt ?? u.startedAt) - u.startedAt, at: now })),
          ].slice(-50),
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
    spinner?.cancel()
    spinner = undefined
    $.ui.status(status(await read($, live)))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, live)
    const frame = await read($, tick)
    const now = await $.clock.now()
    const last = s.calls[s.calls.length - 1]
    const count = (t: Trigger) => s.calls.filter(c => c.trigger === t).length
    const ago = (at: number) => {
      const sec = Math.max(0, Math.round((now - at) / 1000))
      return sec < 60 ? `${sec}s ago` : `${Math.round(sec / 60)}m ago`
    }
    const isOff = s.advisorModel === null
    const quiet = isQuiet(s)
    const isFresh = last !== undefined && now - last.at < 6000
    const flow = isFresh ? ['▾', '▿'][frame % 2] : '│'
    const recent = s.calls.slice(-12)

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor={s.mainBusy ? BLUE : 'gray'} paddingX={1} justifyContent="space-between">
            <Text bold color={BLUE}>{s.mainBusy ? SPIN[frame % SPIN.length] : '○'} {modelName(s.mainModel)}</Text>
            <Text color={s.mainBusy ? BLUE : 'gray'}>main · {s.mainBusy ? 'building' : 'idle'}</Text>
          </Box>
          <Text color={isFresh ? VIOLET : 'gray'}>   {flow} consult</Text>
          <Box borderStyle={isFresh ? 'double' : 'round'} borderColor={isOff || quiet ? 'gray' : VIOLET} paddingX={1} justifyContent="space-between">
            <Text bold color={isOff || quiet ? 'gray' : VIOLET}>{last ? '◆' : '◇'} {modelName(s.advisorModel)}</Text>
            <Text color={isFresh ? VIOLET : 'gray'}>
              advisor{quiet ? ' · idle' : last && !isOff ? ` · ${ago(last.at)}` : ''}
            </Text>
          </Box>
        </Box>

        <Box flexDirection="column">
          <Text dimColor>wakes up when</Text>
          {CARDS.map(t => {
            const isLit = last?.trigger === t
            const color = COLOR[t]
            return (
              <Box borderStyle={isLit ? 'double' : 'round'} borderColor={isLit ? color : 'gray'} paddingX={1} justifyContent="space-between">
                <Box flexDirection="column">
                  <Text bold={isLit} color={isLit ? color : undefined}>{isLit ? '▶ ' : ''}{LABEL[t]}</Text>
                  <Text dimColor>{QUESTION[t]}</Text>
                </Box>
                <Text bold={count(t) > 0} color={count(t) > 0 ? color : 'gray'}>×{count(t)}</Text>
              </Box>
            )
          })}
        </Box>

        {recent.length > 0 && (
          <Box flexDirection="column">
            <Text>
              <Text dimColor>recent </Text>
              <Text color={VIOLET}>{spark(recent.map(c => c.ms))}</Text>
            </Text>
            {s.calls.slice(-5).reverse().map(c => (
              <Text dimColor>
                <Text color={COLOR[c.trigger]}>●</Text> {SHORT[c.trigger]} · {Math.round(c.ms / 100) / 10}s · {ago(c.at)}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
