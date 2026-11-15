export type Trigger = 'plan' | 'error' | 'done'
export type AdvisorCall = { id: string; trigger: Trigger; ms: number; at: number }
export type Live = { calls: AdvisorCall[]; errors: number; sonnetBusy: boolean }

declare module 'claude-code' {
  interface PluginState {
    'advisor-live': { live: Shaped<Live> }
  }
}
