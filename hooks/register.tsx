import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Live, Trigger } from '../types'

const PANE = 'advisor-live'
const live = atom(
  { plugin: 'advisor-live', key: 'live' } as const,
  { calls: [], errors: 0, sonnetBusy: false } as Live,
  { shape: 'live-1' },
)

const LABEL: Record<Trigger, string> = {
  plan: 'before the plan locks',
  error: 'same error twice',
  done: 'before calling it done',
}
const QUESTION: Record<Trigger, string> = {
  plan: 'is this the right approach?',
  error: 'real cause, or a loop?',
  done: 'is it actually finished?',
}
const ORDER: Trigger[] = ['plan', 'error', 'done']

const line = (s: Live) => {
  const last = s.calls[s.calls.length - 1]
  return last
    ? `Advisor ${s.calls.length} · ${LABEL[last.trigger]}`
    : 'Advisor on call'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'advisor-live',
      description: 'Open the live advisor pane',
    })
    void $.ui.open({ id: PANE, title: 'Advisor', backgroundColor: 'transparent' })
    $.ui.status('Advisor on call')
    return next(e)
  })

  on('command.run', { command: 'advisor-live' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Advisor', backgroundColor: 'transparent' })
    return { text: 'Advisor pane opened.' }
  })

  // Same failing Bash result twice in a row marks the "same error twice" moment.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const failed = ran.deny === undefined && ran.isError === true
    await update($, live, s => ({ ...s, errors: failed ? s.errors + 1 : 0 }))
    return ran
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      await update($, live, s => ({ ...s, sonnetBusy: true }))
      $.ui.status('Sonnet building')
    }
    const r = yield* next(e)

    if (e.agentId === undefined) {
      const used = (r.serverToolUses ?? []).filter(u => u.name === 'advisor')
      const s0 = await read($, live)
      const now = await $.clock.now()
      for (const u of used) {
        const trigger: Trigger =
          s0.errors >= 2 ? 'error'
          : r.toolUses.length === 0 && r.stopReason === 'end_turn' ? 'done'
          : 'plan'
        await update($, live, s => ({
          ...s,
          calls: [
            ...s.calls,
            { id: u.id, trigger, ms: (u.endedAt ?? u.startedAt) - u.startedAt, at: now },
          ].slice(-50),
        }))
      }
      const s1 = await read($, live)
      $.ui.status(used.length ? line(s1) : 'Sonnet building')
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    await update($, live, s => ({ ...s, sonnetBusy: false }))
    $.ui.status(line(await read($, live)))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, live)
    const now = await $.clock.now()
    const last = s.calls[s.calls.length - 1]
    const lit = last?.trigger
    const count = (t: Trigger) => s.calls.filter(c => c.trigger === t).length
    const ago = (at: number) => {
      const sec = Math.max(0, Math.round((now - at) / 1000))
      return sec < 60 ? `${sec}s ago` : `${Math.round(sec / 60)}m ago`
    }

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box flexDirection="column">
          <Text bold color="magenta">Advisor</Text>
          <Text dimColor>reads the full session · never writes code</Text>
        </Box>

        <Box flexDirection="column">
          <Box borderStyle="round" borderColor={s.sonnetBusy ? 'blue' : 'gray'} paddingX={1} justifyContent="space-between">
            <Text bold color="blue">{s.sonnetBusy ? '●' : '○'} Sonnet</Text>
            <Text dimColor>{s.sonnetBusy ? 'building' : 'idle'}</Text>
          </Box>
          <Text color="magenta">   │ consult</Text>
          <Box borderStyle="round" borderColor={last ? 'magenta' : 'gray'} paddingX={1} justifyContent="space-between">
            <Text bold color="magenta">{last ? '●' : '○'} Advisor</Text>
            <Text dimColor>{last ? `reviewed ${ago(last.at)}` : 'on call'}</Text>
          </Box>
        </Box>

        <Box flexDirection="column">
          <Text dimColor>wakes up when</Text>
          {ORDER.map(t => (
            <Box borderStyle="round" borderColor={lit === t ? 'magenta' : 'gray'} paddingX={1} justifyContent="space-between">
              <Box flexDirection="column">
                <Text bold={lit === t} color={lit === t ? 'magenta' : undefined}>{lit === t ? '▶ ' : ''}{LABEL[t]}</Text>
                <Text dimColor>{QUESTION[t]}</Text>
              </Box>
              <Text color={count(t) > 0 ? 'magenta' : 'gray'}>×{count(t)}</Text>
            </Box>
          ))}
        </Box>

        {s.calls.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>recent</Text>
            {s.calls.slice(-6).reverse().map(c => (
              <Text dimColor>
                <Text color="magenta">●</Text> {LABEL[c.trigger]} · {Math.round(c.ms / 100) / 10}s · {ago(c.at)}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
