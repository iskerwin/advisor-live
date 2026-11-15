import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { advisorAfter, advisorFromArgv, ago, clockFace, graph, modelName } from './register'

const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

const PANE = {
  plugin: 'advisor-live',
  component: 'Pane',
  requestId: 'advisor-live',
  props: {
    title: 'Advisor',
    isFocused: false,
    bodyColumns: 34,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('model ids and aliases read as names', async () => {
  expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
  expect(modelName('opus[1m]')).toBe('Opus')
  expect(modelName('fable')).toBe('Fable')
  expect(modelName('Fable 5.2')).toBe('Fable 5.2')
  expect(modelName(null)).toBe('off')
})

test('/advisor is read by what it did to the setting', async () => {
  expect(advisorAfter('fable', 'opus', 'fable')).toBe('fable')
  expect(advisorAfter('opus', 'opus', 'opus')).toBe('opus')
  expect(advisorAfter('', 'opus', 'sonnet')).toBe('sonnet')
  // A bare /advisor (the picker) counts only once the setting moved.
  expect(advisorAfter('', 'opus', 'opus')).toBe(undefined)
  expect(advisorAfter('off', 'opus', undefined)).toBe(null)
  expect(advisorAfter('off', undefined, undefined)).toBe(null)
  // Refused: nothing written, nothing changes.
  expect(advisorAfter('haiku', 'opus', 'opus')).toBe(undefined)
  expect(advisorAfter('haiku', undefined, undefined)).toBe(undefined)
})

test('a launch names its advisor on the command line', async () => {
  expect(advisorFromArgv('claude --model opus --advisor fable')).toBe('fable')
  expect(advisorFromArgv('claude --advisor=sonnet -c')).toBe('sonnet')
  expect(advisorFromArgv('claude --model opus')).toBe(undefined)
  expect(advisorFromArgv('claude --advisor-x y')).toBe(undefined)
})

test('the pane names both models and follows a switch', async ($, on) => {
  let main = 'claude-opus-5-5'
  on('command.register', () => ({ value: { command: 'advisor-live' } }))
  on('ui.status', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_000 }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: main }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '42\nclaude --model opus\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  // A built-in's output never reaches a mod: what it did shows in settings.
  let advisorModel: string | undefined = 'fable'
  on('settings.read', () => ({ value: { advisorModel } }))
  on('command.run', { command: 'advisor' }, (_, e) => {
    advisorModel = e.args === 'off' ? undefined : e.args === 'haiku' ? advisorModel : e.args
    return {}
  })
  on('command.run', { command: 'model' }, () => {
    main = 'claude-sonnet-5-5'
    return {}
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Fable/ })).toBeDefined()
    await ui.unmount()
  }

  const advisorCard = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const card = (await ui.findAll({ type: 'Text' })).map(t => t.text).find(t => /^[◇◆] /.test(t))
    await ui.unmount()
    return card
  }

  await $.command.run({ command: 'advisor', args: 'opus', ...TYPED })
  expect(await advisorCard()).toBe('◇ Opus')
  await $.command.run({ command: 'advisor', args: 'haiku', ...TYPED })
  expect(await advisorCard()).toBe('◇ Opus')
  await $.command.run({ command: 'advisor', args: 'off', ...TYPED })
  expect(await advisorCard()).toBe('◇ off')

  await $.command.run({ command: 'model', args: 'sonnet', ...TYPED })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Sonnet 5\.5/ })).toBeDefined()
  await ui.unmount()
})

test("the advisor follows a write settings read back late, and a refusal changes nothing", async ($, on) => {
  on('command.register', () => ({ value: { command: 'advisor-live' } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const clock = mock.clock(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '42\nclaude\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  // The engine's settings catch up with the file a few reads after the write.
  let written = 'opus'
  let loaded = written
  let stale = 0
  on('settings.read', () => {
    if (stale-- <= 0) loaded = written
    return { value: { advisorModel: loaded } }
  })
  on('command.run', { command: 'advisor' }, (_, e) => {
    if (e.args !== 'nope') written = e.args
    stale = 3
    return {}
  })
  const advisorCard = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const card = (await ui.findAll({ type: 'Text' })).map(t => t.text).find(t => /^[◇◆] /.test(t))
    await ui.unmount()
    return card
  }

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'advisor', args: 'haiku', ...TYPED })
  await clock.advance(1000)
  expect(await advisorCard()).toBe('◇ Haiku')

  await $.command.run({ command: 'advisor', args: 'nope', ...TYPED })
  await clock.advance(3000)
  expect(await advisorCard()).toBe('◇ Haiku')
})

test('starting again in the same process keeps a switch the launch flag predates', async ($, on) => {
  on('command.register', () => ({ value: { command: 'advisor-live' } }))
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '42\nclaude --advisor fable\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  let advisorModel = 'fable'
  on('settings.read', () => ({ value: { advisorModel } }))
  on('command.run', { command: 'advisor' }, (_, e) => {
    advisorModel = e.args
    return {}
  })
  const advisorCard = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const card = (await ui.findAll({ type: 'Text' })).map(t => t.text).find(t => /^[◇◆] /.test(t))
    await ui.unmount()
    return card
  }

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(await advisorCard()).toBe('◇ Fable')
  await $.command.run({ command: 'advisor', args: 'opus', ...TYPED })
  expect(await advisorCard()).toBe('◇ Opus')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(await advisorCard()).toBe('◇ Opus')
})

test('a step names the main model and an advisor call counts', async ($, on) => {
  on('command.register', () => ({ value: { command: 'advisor-live' } }))
  const statuses: string[] = []
  on('ui.status', (_, e) => { statuses.push(e.text ?? ''); return { value: undefined } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  mock.clock(on, { now: 10_000 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'opus' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '42\nclaude --advisor fable\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('settings.read', () => ({ value: {} }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: null,
      serverToolUses: [{ id: 'a1', name: 'advisor', input: {}, startedAt: 9_000, endedAt: 10_000 }],
    }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 })
  while (!(await step.next()).done) {}

  expect(statuses).toContain('Sonnet 5.5 building')
  expect(statuses.at(-1)).toBe('Fable advisor ×1 · before the plan locks')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Sonnet 5\.5/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^◆ Fable$/ })).toBeDefined()
  await ui.unmount()
})

test('an advisor never called through working turns reads idle, and a call clears it', async ($, on) => {
  on('command.register', () => ({ value: { command: 'advisor-live' } }))
  const statuses: string[] = []
  on('ui.status', (_, e) => { statuses.push(e.text ?? ''); return { value: undefined } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  mock.clock(on, { now: 10_000 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '42\nclaude --advisor sonnet\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('settings.read', () => ({ value: {} }))
  on('tool.call', () => ({ result: {} }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  let callAdvisor = false
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null,
      serverToolUses: callAdvisor ? [{ id: 'a1', name: 'advisor', input: {}, startedAt: 9_000, endedAt: 10_000 }] : [],
    }
  })
  const turn = async (n: number, { tools = true, agentId }: { tools?: boolean; agentId?: string } = {}) => {
    const turnId = `t${n}`
    await $.turn.start({ text: 'go', turnId, agentId })
    if (tools) await $.tool.call({ tool: 'Bash', command: 'ls', agentId })
    const step = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId })
    while (!(await step.next()).done) {}
    await $.turn.complete({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer', agentId })
  }
  const advisorRight = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    await ui.unmount()
    return texts.find(t => t.startsWith('idle'))
  }

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await turn(1)
  await turn(2, { tools: false })
  await turn(3)
  // A subagent's turn neither counts nor resets the main one's.
  await turn(4, { agentId: 'sub' })
  expect(await advisorRight()).toBe(undefined)
  await turn(5)
  expect(await advisorRight()).toBe('idle · 3 turns')
  expect(statuses.at(-1)).toBe('Sonnet advisor idle · 3 turns')

  callAdvisor = true
  await turn(6)
  expect(await advisorRight()).toBe(undefined)
  expect(statuses.at(-1)).toBe('Sonnet advisor ×1 · before calling it done')
})

test('a braille graph fills each value from the bottom, newest at the right', async () => {
  expect(graph([], 4, 2)).toEqual(['    ', '    '])
  // The largest fills both rows; half of it, the bottom row.
  expect(graph([2, 1], 3, 2)).toEqual([' ⣿ ', ' ⣿⣿'])
  expect(graph([1, 1, 1, 1, 1], 3, 1)).toEqual(['⣿⣿⣿'])
  // Few values on a wide graph: two cells and a gap each.
  expect(graph([1, 1], 7, 1)).toEqual([' ⣿⣿ ⣿⣿ '])
})

test('time since a call reads in its largest whole unit', async () => {
  expect(ago(0)).toBe('0s')
  expect(ago(59_999)).toBe('59s')
  expect(ago(90_000)).toBe('1m')
  expect(ago(2 * 3600_000 + 5)).toBe('2h')
  expect(clockFace(27_400)).toBe('0:27')
  expect(clockFace(723_000)).toBe('12:03')
})

// A session whose steps call the advisor as `advise` says, with a turn helper.
const session = (on: Parameters<TestBody>[1], argv = 'claude --advisor fable') => {
  on('command.register', () => ({ value: { command: 'advisor-live' } }))
  const statuses: string[] = []
  on('ui.status', (_, e) => { statuses.push(e.text ?? ''); return { value: undefined } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const clock = mock.clock(on, { now: 10_000 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('classic.SessionStart', () => ({}))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: `42\n${argv}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('settings.read', () => ({ value: {} }))
  const failing = new Set<string>()
  on('tool.call', (_, e) => (failing.has(e.tool) ? { result: 'boom', isError: true, text: 'boom' } : { result: {} }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const advise = { calls: 0 }
  on('turn.step', async function* (_, e) {
    const n = advise.calls
    advise.calls = 0
    return {
      turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null,
      serverToolUses: Array.from({ length: n }, (_, i) => ({ id: `${e.turnId}-${i}`, name: 'advisor', input: {}, startedAt: 9_000, endedAt: 10_000 })),
    }
  })
  return { statuses, clock, failing, advise }
}

test('the pane keeps moving after the turn that called the advisor ends', async ($, on) => {
  const { advise, clock } = session(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.start({ text: 'go', turnId: 't1' })
  advise.calls = 1
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  while (!(await step.next()).done) {}
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  expect(await ui.find({ type: 'Text', text: /^0s$/ })).toBeDefined()
  await clock.advance(70_000)
  expect(await ui.find({ type: 'Text', text: /^0s$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^1m$/ })).toBeDefined()
  await ui.unmount()
})

test('counts keep growing past the calls the pane lists', async ($, on) => {
  const { advise, statuses } = session(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  advise.calls = 15
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  while (!(await step.next()).done) {}
  expect(statuses.at(-1)).toBe('Fable advisor ×15 · before calling it done')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '15' })).toBeDefined()
  await ui.unmount()
})

test('a subagent failing the same way twice is not the main loop looping', async ($, on) => {
  const { advise, failing, statuses } = session(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  failing.add('Bash')
  await $.tool.call({ tool: 'Bash', command: 'make', agentId: 'sub' })
  await $.tool.call({ tool: 'Bash', command: 'make', agentId: 'sub' })
  advise.calls = 1
  let step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  while (!(await step.next()).done) {}
  expect(statuses.at(-1)).toBe('Fable advisor ×1 · before calling it done')

  await $.tool.call({ tool: 'Bash', command: 'make' })
  await $.tool.call({ tool: 'Bash', command: 'make' })
  advise.calls = 1
  step = $.turn.step({ turnId: 't1', index: 1, model: 'claude-opus-5-5', messageCount: 1 })
  while (!(await step.next()).done) {}
  expect(statuses.at(-1)).toBe('Fable advisor ×2 · same error twice')
})

test('an advisor nothing named reads as one word', async ($, on) => {
  const { advise, statuses } = session(on, 'claude')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(statuses.at(-1)).toBe('Opus 5.5 · advisor off')
  advise.calls = 1
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  while (!(await step.next()).done) {}
  expect(statuses.at(-1)).toBe('Advisor ×1 · before calling it done')
})

test('/clear starts the counts over and keeps both models', async ($, on) => {
  const { advise, statuses } = session(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  advise.calls = 2
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  while (!(await step.next()).done) {}
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await $.classic.SessionStart({ source: 'clear' })
  expect(statuses.at(-1)).toBe('Fable advisor on call')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^◇ Fable$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^moments$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^latency$/ })).toBeUndefined()
  // `done` names its meter alone: the call list is empty.
  expect((await ui.findAll({ type: 'Text', text: /^done$/ })).length).toBe(1)
  await ui.unmount()
})

test('a short or minimized pane folds the moments into one line', async ($, on) => {
  session(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const props of [{ scroll: { offset: 0, bodyRows: 5 } }, { placement: 'widget' as const }]) {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, ...props } })
    expect(await ui.find({ type: 'Text', text: /^moments$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /plan 0 · error 0 · done 0/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a docked pane draws btop boxes: link, latency graph, moments, calls', async ($, on) => {
  const { advise, clock } = session(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  advise.calls = 2
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  while (!(await step.next()).done) {}
  await clock.advance(2 * 60_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()
  expect(texts).toContain('◆ Fable')
  expect(texts).toContain('2m')
  for (const title of ['link', 'latency', 'moments', 'calls']) expect(texts).toContain(title)
  expect(texts.filter(t => t === 'done')).toHaveLength(3)
  // Every edge is the pane's width: 34 columns less the padding.
  const edges = texts.filter(t => /^[╭╰].*[╮╯]$/.test(t))
  expect(edges).toHaveLength(8)
  for (const edge of edges) expect(edge.length).toBe(32)
  expect(texts.filter(t => /^[⠀-⣿ ]+$/.test(t) && t.length === 28)).toHaveLength(3)
})
