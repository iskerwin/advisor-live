# advisor-live

A Claude Code mod that shows the advisor's activity live while you work: a status line entry and a side pane.

- **Status line**: `Sonnet 5.5 building`, then `Fable advisor ×2 · before the plan locks` after each advisor call.
- **Side pane**: opens with the session, or with `/advisor-live`. It names the main model and the advisor model and shows the main model's state, the advisor's last review, the three moments the advisor wakes up (before the plan locks, same error twice, before calling it done) with a count for each, and the most recent calls with their duration.

Start a session with an advisor, for example `claude --model sonnet --advisor fable`.

Switch either model mid-session with the built-in `/model` and `/advisor`; the pane follows. Both save the choice as your default for new sessions.

A mod can't read which advisor the session is using, so the pane works it out: at start from `--advisor` on the launch command line, else the `advisorModel` setting; after `/advisor`, from what it wrote to that setting. A card reading `Advisor` means calls are arriving but nothing named the model.

The advisor runs inside the API request, so the mod sees a call only after it finishes. There is no "consulting" state while it runs. The moment each call counts under is inferred from the turn, not reported by the advisor: the same tool failing twice in a row with the same message is "same error twice", a step that ends the turn is "before calling it done", a call before any file was written is "before the plan locks", and a call in between shows as a check-in in the recent list.

## Install

In a Claude Code session:

```
/plugin install advisor-live --marketplace iskerwin/advisor-live
```

From a shell:

```
claude plugin install advisor-live --marketplace iskerwin/advisor-live
```

Answer `y` to add the marketplace, then pick a scope.

## License

MIT
