export type Trigger = 'plan' | 'error' | 'done' | 'other'
export type AdvisorCall = { id: string; trigger: Trigger; ms: number; at: number }
export type Live = {
  /** The most recent calls, newest last; `counts` holds the totals. */
  calls: AdvisorCall[]
  /** Calls per trigger since the conversation began. */
  counts: Record<Trigger, number>
  /** Consecutive failed main-loop tool calls with the same tool and message. */
  repeats: number
  lastError: string
  /** A file was written or edited in this turn, so the plan is already locked. */
  hasEdited: boolean
  mainBusy: boolean
  /** The main loop's model as the engine names it: an alias or a full id. */
  mainModel: string
  /** The advisor's model, an id or the name `/advisor` printed; null when off or unknown. */
  advisorModel: string | null
  /** The Claude Code process whose command line `advisorModel` was read from. */
  launchPid: string
  /** Turns in a row that used tools and never called the advisor. */
  quietTurns: number
  /** This turn has used a tool in the main loop. */
  turnWorked: boolean
  /** This turn has called the advisor. */
  turnCalled: boolean
  /** When the main loop's current turn began, in `$.clock.now()` ms. */
  turnStartedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'advisor-live': { live: Shaped<Live>; tick: number }
  }
}
