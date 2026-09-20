# Issue (draft) — deepseek-harness: structured approval reasons

> Para abrir en `deepseek-ai/deepseek-harness`. Escrito en inglés (idioma del repo).
> Versión observada: `@deepseek-ai/dsh` **0.1.5-rc.2**.

## Title
Approval prompt only renders a free-form `reason` string; support structured details (like `ask_user_question`)

## Context
`dsh-client-ui-approval` renders each pending approval as a headline plus `Allow once` / `Reject`.
The headline is `pending.reason ?? t("escalation", { toolName: pending.toolName })` — a single
free-form string. There is no structured field for a title, a bullet list, or long details.

By contrast, `ask_user_question` (`dsh-tool-ask-user` + its client UI) renders a proper question with a
**list of options**. Plugins that raise `ask` decisions (domain tools, sandboxes, escalations) can only
supply a single `reason` string, so decision-grade information is crammed into one line and the UI cannot
format it.

## Current behavior
- `approval/request` payload: `{ agent, toolName, reason?, callId? }`; `reason` is a string.
- The client prints `reason` as the headline (plain text; no newlines/markdown, no list).
- Result: a plugin wanting to show "project, steps, dry-run vs execute" must emit a long run-on line,
  which is poor for a permission decision.

## Proposal
Let the approval request carry an optional **structured** reason, rendered like the questions UI, while
keeping `reason` for backwards compatibility:

```ts
interface ApprovalReason {
  reason?: string;     // existing free-form headline (unchanged)
  title?: string;      // short headline
  details?: string[];  // bullet list (rendered as a list, like question options)
  body?: string;       // long text / markdown
}
```

- `dsh-user-approval`: propagate the new optional fields through `approval/request`.
- `dsh-client-ui-approval`: render `title` (or `reason`), then `details` as a list, then `body`;
  keep the current behavior when only `reason` is present.
- The answerer/audit vocabulary (`allowed-once | rejected | cancelled | unavailable`) is unchanged.

## Alternatives
1. Render newlines/markdown in `reason` (least structured; layout is client-decided today).
2. Add a dedicated `conversation.approval.detail`-style **slot** so plugins can render custom content
   (most flexible; more surface and more client coupling).

## Impact
- Backwards compatible: `reason` keeps working.
- Touches `dsh-user-approval` (request shape + propagation) and `dsh-client-ui-approval` (rendering);
  optional type updates in consumers.

## Real-world example (why it matters)
A migration plugin raises an approval for "run these steps in the target (dry-run vs execute)" with a
project path, a step list, and side-effect semantics. With today's API it can only pass one string:
`"Ejecuta ... Pasos (dry-run...): preflight-target — ...; backup-source-db — ...; ... · El ORIGEN no se modifica."`
A `details: string[]` (one entry per step) and `title` would render far better and match the questions UI.
