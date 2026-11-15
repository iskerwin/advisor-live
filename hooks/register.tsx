import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

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

const fresh: Live = { calls: [], repeats: 0, lastError: '', hasEdited: false, sonnetBusy: false }
const tick = atom({ plugin: 'advisor-live', key: 'tick' } as const, 0)
const live = atom({ plugin: 'advisor-live', key: 'live' } as const, fresh, { shape: 'live-2' })

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

const status = (s: Live) => {
  const last = s.calls[s.calls.length - 1]
  return last ? `Advisor ${s.calls.length} · ${LABEL[last.trigger]}` : 'Advisor on call'
}

let spinner: { cancel: () => void } | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'advisor-live', description: 'Open the live advisor pane' })
    void $.ui.open(PANE_ARGS)
    $.ui.status('Advisor on call')
    return next(e)
  })

  on('command.run', { command: 'advisor-live' }, async $ => {
    await $.ui.open(PANE_ARGS)
    return { text: 'Advisor pane opened.' }
  })

  on('turn.start', async ($, e, next) => {
    await update($, live, s => ({ ...s, repeats: 0, lastError: '', hasEdited: false }))
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
      repeats: !failed ? 0 : message === s.lastError ? s.repeats + 1 : 1,
      lastError: message,
    }))
    return ran
  })

  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    if (isMain) {
      await update($, live, s => ({ ...s, sonnetBusy: true }))
      $.ui.status('Sonnet building')
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
          calls: [
            ...s.calls,
            ...used.map(u => ({ id: u.id, trigger, ms: (u.endedAt ?? u.startedAt) - u.startedAt, at: now })),
          ].slice(-50),
        }))
      }
      $.ui.status(used.length > 0 ? status(await read($, live)) : 'Sonnet building')
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    await update($, live, s => ({ ...s, sonnetBusy: false }))
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
    const isFresh = last !== undefined && now - last.at < 6000
    const flow = isFresh ? ['▾', '▿'][frame % 2] : '│'
    const recent = s.calls.slice(-12)

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box flexDirection="column">
          <Text bold color={VIOLET}>◆ Advisor</Text>
          <Text dimColor>reads the session, writes no code</Text>
        </Box>

        <Box flexDirection="column">
          <Box borderStyle="round" borderColor={s.sonnetBusy ? BLUE : 'gray'} paddingX={1} justifyContent="space-between">
            <Text bold color={BLUE}>{s.sonnetBusy ? SPIN[frame % SPIN.length] : '○'} Sonnet</Text>
            <Text color={s.sonnetBusy ? BLUE : 'gray'}>{s.sonnetBusy ? 'building' : 'idle'}</Text>
          </Box>
          <Text color={isFresh ? VIOLET : 'gray'}>   {flow} consult</Text>
          <Box borderStyle={isFresh ? 'double' : 'round'} borderColor={last ? VIOLET : 'gray'} paddingX={1} justifyContent="space-between">
            <Text bold color={VIOLET}>{last ? '◆' : '◇'} Advisor</Text>
            <Text color={isFresh ? VIOLET : 'gray'}>{last ? `reviewed ${ago(last.at)}` : 'on call'}</Text>
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
