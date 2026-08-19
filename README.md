# dsh-llm-approver

LLM pre-review for sandbox-escalation approvals in the DeepSeek Harness web GUI.

When the session sits in the `workspace-write-llm` permission preset, a sandbox
escalation retry (`sandbox_permissions` on bash/pwsh/fs tools) is first judged
by an **independent-context LLM call** — the request contains only the pending
command and its justification, never the conversation history:

- **ALLOW** → the call runs immediately (`allowed-once`); the user is never prompted.
- **DENY, timeout, error, unparsable output, tool-call output, abort** → the
  request falls through to the existing web UI approval prompt unchanged.

The gate is **fail-closed**: it can only grant, never reject, and every failure
mode degrades to the user. Sessions in any other preset pass through
synchronously with zero behavior change.

## Installation

Add the bundle to a profile (e.g. `~/.dsh/profiles/web/package.json`):

```json
{
  "dsh": { "profile": { "bundles": [..., "@dsh-external/dsh-llm-approver"] } },
  "dependencies": { "@dsh-external/dsh-llm-approver": "file:<path-to-this-dir>" }
}
```

Then `pnpm install` in the profile directory and restart `dsh web`.

## Usage

Switch the session's permission preset to **Workspace Write · LLM Review** in
the web UI permission selector. Escalations for obviously safe operations
(writing a new file, reading, installing packages) run without a prompt;
destructive or uncertain ones (`rm -rf`, overwriting user files, sensitive
paths) still ask you.

## Decision criteria

The reviewer allows an escalation only when the operation is reversible,
destroys nothing, touches no sensitive data, matches its stated justification,
and requests no broader mode than needed. Anything else is denied or deferred.

## Configuration

Override in the profile `cordis.patch.yml` (row id `llm-approver`):

| Key | Default | Meaning |
|---|---|---|
| `preset` | `workspace-write-llm` | Permission preset the gate activates under |
| `provider` / `model` | — | Review route override; default follows the session's current model route |
| `timeoutMs` | `60000` | Review deadline; on expiry the user is asked |
| `maxTokens` | `256` | Review completion budget |
| `maxInstructionChars` | `16384` | Truncation for the reviewed tool arguments |
| `includeUserInstruction` | `true` | Attach a bounded excerpt of the latest human message |

On DeepSeek-family routes the review call disables thinking
(`reasoningEffort: "off"`) so the short ALLOW/DENY verdict fits the token
budget; other adapters receive no effort override and any rejection degrades
to the user prompt.

## Tests

Behavioral gate tests (run from the installed profile copy so `@deepseek-ai/*`
imports resolve):

```bash
mkdir -p ~/.dsh/profiles/web/node_modules/@dsh-external/dsh-llm-approver/test
cp dsh-llm-approver/test/gate.test.mjs ~/.dsh/profiles/web/node_modules/@dsh-external/dsh-llm-approver/test/
node ~/.dsh/profiles/web/node_modules/@dsh-external/dsh-llm-approver/test/gate.test.mjs
```

Live E2E helpers (against a running `dsh web` instance, no browser needed):
`test/e2e-full.mjs <port>` and `test/probe-run-3082.mjs`.

## Failure semantics

| Situation | Behavior |
|---|---|
| Session not in the preset / drifted to custom | Pass-through, unchanged behavior |
| LLM timeout / error / no ALLOW / tool-call output | User approval prompt |
| User interrupts during review | Defer to user; service resolves `cancelled` |
| Missing `callId` or no matching `tool/call` event | User approval prompt |
| `approval/policy = never` | Rejected by the service before this gate runs |
| Plugin row fails to load | The `permission` preset row is independent and still applies |

Audit: `approval/asked` / `approval/decided` are recorded by the approval
service exactly as before; LLM verdicts go to the host log (`llm-approver`),
never to the session event vocabulary.
