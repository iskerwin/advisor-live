export type Trigger = 'plan' | 'error' | 'done' | 'other'
export type AdvisorCall = { id: string; trigger: Trigger; ms: number; at: number }
export type Live = {
  calls: AdvisorCall[]
  /** Consecutive failed tool calls with the same tool and message. */
  repeats: number
  lastError: string
  /** A file was written or edited in this turn, so the plan is already locked. */
  hasEdited: boolean
  sonnetBusy: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'advisor-live': { live: Shaped<Live>; tick: number }
  }
}
