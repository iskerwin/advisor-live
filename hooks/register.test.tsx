import { expect, mock, test } from 'claude-code/testing'

import { advisorAfter, advisorFromArgv, modelName } from './register'

const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

const PANE = {
  plugin: 'advisor-live',
  component: 'Pane',
  requestId: 'advisor-live',
  props: {
    title: 'Advisor',
    isFocused: false,
    bodyColumns: 36,
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

test('/advisor-live switches through the built-ins and the pane follows', async ($, on) => {
  let main = 'claude-opus-5-5'
  on('command.register', () => ({ value: { command: 'advisor-live' } }))
  on('command.list', () => ({ value: [
    { name: 'model', description: '', source: 'builtin' },
    { name: 'advisor', description: '', source: 'builtin' },
  ] }))
  on('ui.status', () => ({ value: undefined }))
  const clock = mock.clock(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => { toasts.push(JSON.stringify(e)); return { value: undefined } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: main }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '42\nclaude --advisor opus\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  let advisorModel = 'sonnet'
  on('settings.read', () => ({ value: { advisorModel } }))
  on('command.run', { command: 'advisor' }, (_, e) => {
    advisorModel = e.args
    return {}
  })
  on('command.run', { command: 'model' }, () => {
    main = 'claude-sonnet-5-5'
    return {}
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'advisor-live', args: 'advisor fable', ...TYPED })
  await clock.advance(50)
  await $.command.run({ command: 'advisor-live', args: 'main sonnet', ...TYPED })
  await clock.advance(50)
  expect(toasts).toEqual([])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Sonnet 5\.5/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^◇ Fable$/ })).toBeDefined()
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
