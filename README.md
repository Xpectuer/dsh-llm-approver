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

Requires `dsh` with a profile (`~/.dsh/profiles/web` for the web GUI) and
`pnpm` available.

### Quick (scripts)

```bash
# from a clone of this repo:
./scripts/install.sh                 # install into the web profile (from GitHub)
./scripts/install.sh --profile tui   # install into another profile
./scripts/install.sh --source file:/path/to/dsh-llm-approver  # local source

./scripts/uninstall.sh               # remove from the web profile
./scripts/uninstall.sh --profile tui # remove from another profile
```

Each script edits the profile's `package.json` (bundle + dependency, keeping
both lists intact), runs `pnpm install`, verifies the composed tree, and
prints the restart reminder. Both are idempotent.

### Manual

Edit `~/.dsh/profiles/web/package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@dsh-external/dsh-llm-approver"
      ]
    }
  },
  "dependencies": {
    "@dsh-external/dsh-llm-approver": "github:Xpectuer/dsh-llm-approver"
  }
}
```

For local development instead of GitHub, use a file reference:
`"@dsh-external/dsh-llm-approver": "file:/path/to/dsh-llm-approver"`.

**2. Install and verify**

```bash
cd ~/.dsh/profiles/web
pnpm install
dsh web --dump-config | grep -A2 llm-approver   # row must appear
# the preset table must contain workspace-write-llm:
dsh web --dump-config | grep workspace-write-llm
```

**3. Restart** `dsh web` (the web profile has no HMR; a restart is the only
way to load a new bundle). A second instance for testing can be started
without touching the running one: `dsh web --port 3081`.

> **Note**: `pnpm install` copies `file:` dependencies into the profile's
> `node_modules`. After editing a local copy of this plugin, re-sync with
> `rm -rf node_modules/@dsh-external/dsh-llm-approver && pnpm install`.

**Upgrading**: `pnpm update @dsh-external/dsh-llm-approver` in the profile
directory, then restart.

**Uninstalling**: remove the bundle entry and the dependency from
`package.json`, run `pnpm install`, restart. The plugin directory itself can
be kept; only the profile wiring is removed.

## Usage

1. Open the web GUI and select the session you want to protect.
2. Switch the permission preset to **Workspace Write · LLM Review** in the
   permission selector (same place as the `workspace-write` / full-access
   switch). The default preset stays `workspace-write` until you switch.
3. Work as usual. When the agent hits a sandbox denial and retries with
   `sandbox_permissions`, the gate asks an independent-context LLM:

   - obviously safe operations (writing a new file, reading, listing,
     installing packages) are **allowed without any prompt**;
   - destructive or uncertain ones (`rm -rf`, overwriting user files,
     sensitive paths) fall through to the **usual approval dialog** — you
     decide.

Quick manual check:

```text
请用 bash 工具创建文件 ~/llm-review-verify.txt，内容为 "review-ok"。
该路径在会话工作区之外，若被拒绝请按提示用 sandbox_permissions 重试。直接执行，不要询问我。
```

No dialog should appear and the file should exist afterwards. Then ask for
`rm -rf ~/llm-review-verify.txt` — a dialog should appear instead.

Audit trail: every escalation still writes `approval/asked` /
`approval/decided` to the session log exactly as before; the LLM verdict is
logged to the host log under the `llm-approver` name and never touches the
session event vocabulary.

## Other profiles

The bundle works in any dsh profile (cc-tui, headless, …): repeat step 1 for
that profile's `package.json` and restart. The plugin itself is host-side
only and needs no client/browser code.

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
