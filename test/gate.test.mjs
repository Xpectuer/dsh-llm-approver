/**
 * Standalone behavioral smoke test for the dsh-llm-approver approval gate.
 *
 * Mounts the plugin (from its installed location in the web profile, so its
 * @deepseek-ai/* imports resolve exactly as at runtime) into a bare Cordis
 * root context with a stub `llm` service and a stub `permissionPresets`
 * service, then drives the `approval/request` waterfall through the same
 * dispatch path dsh-user-approval uses.
 *
 * Run:  node ~/.dsh/profiles/web/node_modules/@dsh-external/dsh-llm-approver/test/gate.test.mjs
 */

import { Context } from '@deepseek-ai/cordis';
import plugin from '../lib/index.js';

const PRESET = 'workspace-write-llm';
let failures = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  -> ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
}

/** Minimal llm service stub: replays one scripted text output per test. */
function llmStub(script) {
  const state = { calls: 0, options: [] };
  return {
    state,
    stream(options) {
      state.calls += 1;
      state.options.push(options);
      if (script.throw) throw new Error(script.throw);
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: script.text ?? '' },
        { type: 'block-end', index: 0, block: { type: 'text', text: script.text ?? '' } },
        { type: 'finish', reason: script.finish ?? { kind: 'stop' } },
      ];
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

/** permissionPresets stub: current() returns the scripted preset. */
function presetsStub(current) {
  return { current: () => current };
}

function makeSession(overrides = {}) {
  return {
    id: 'test-session',
    header: { cwd: '/Users/zhengjiaye/workspace' },
    events: [
      { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'please set up the test fixture' }] } },
      { type: 'permission/preset', data: { preset: PRESET } },
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
      { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"echo hi > ~/sandbox-test.txt"}' } },
    ],
    requestHeader: () => ({ config: { provider: 'stub-provider', model: 'stub-model' } }),
    ...overrides,
  };
}

function makeReq(session, overrides = {}) {
  return {
    agent: { session },
    toolName: 'bash',
    callId: 'call-1',
    reason: 'escalate sandbox to danger-full-access: write a scratch file in the home directory',
    ...overrides,
  };
}

/** Boot a fresh context with the given stubs and run one waterfall dispatch. */
async function dispatch({ preset = PRESET, script = {}, req }) {
  const ctx = new Context();
  const llm = llmStub(script);
  ctx.provide('llm', llm);
  ctx.provide('permissionPresets', presetsStub(preset));
  await ctx.plugin(plugin);
  const outcome = await ctx.waterfall('approval/request', req, () => Promise.resolve('user-decides'));
  ctx.fiber.dispose();
  return { outcome, llmCalls: llm.state.calls };
}

// 1. Session in another preset: pass-through, LLM never called.
{
  const { outcome, llmCalls } = await dispatch({ preset: 'workspace-write', req: makeReq(makeSession()) });
  check('other preset passes through', outcome, 'user-decides');
  check('other preset never calls the LLM', llmCalls, 0);
}

// 2. Non-escalation reason (e.g. a cordis_run plugin approval): pass-through.
{
  const { outcome, llmCalls } = await dispatch({ req: makeReq(makeSession(), { reason: 'run dynamic plugin foo', callId: undefined }) });
  check('non-escalation reason passes through', outcome, 'user-decides');
  check('non-escalation never calls the LLM', llmCalls, 0);
}

// 3. ALLOW verdict grants without the user.
{
  const { outcome, llmCalls } = await dispatch({ script: { text: 'ALLOW\nnew scratch file, reversible' }, req: makeReq(makeSession()) });
  check('ALLOW grants allowed-once', outcome, 'allowed-once');
  check('ALLOW called the LLM once', llmCalls, 1);
}

// 4. Case-insensitive allow.
{
  const { outcome } = await dispatch({ script: { text: '  allow  ' }, req: makeReq(makeSession()) });
  check('lowercase allow also grants', outcome, 'allowed-once');
}

// 5. DENY falls through to the user.
{
  const { outcome } = await dispatch({ script: { text: 'DENY\nrecursive delete' }, req: makeReq(makeSession()) });
  check('DENY defers to user', outcome, 'user-decides');
}

// 6. Unparsable output defers to the user.
{
  const { outcome } = await dispatch({ script: { text: 'I think this is probably fine because...' }, req: makeReq(makeSession()) });
  check('unparsable output defers to user', outcome, 'user-decides');
}

// 7. Stream error defers to the user.
{
  const { outcome } = await dispatch({ script: { throw: 'api key invalid' }, req: makeReq(makeSession()) });
  check('LLM error defers to user', outcome, 'user-decides');
}

// 8. Non-stop finish reason defers to the user.
{
  const { outcome } = await dispatch({ script: { text: 'ALLOW', finish: { kind: 'max-tokens' } }, req: makeReq(makeSession()) });
  check('max-tokens finish defers to user', outcome, 'user-decides');
}

// 9. No matching tool/call event: never judged, user decides.
{
  const { outcome, llmCalls } = await dispatch({ req: makeReq(makeSession(), { callId: 'call-missing' }) });
  check('unknown callId defers to user', outcome, 'user-decides');
  check('unknown callId never calls the LLM', llmCalls, 0);
}

// 10. Missing requestHeader and no config override: defer.
{
  const session = makeSession();
  session.requestHeader = () => undefined;
  const { outcome } = await dispatch({ req: makeReq(session) });
  check('no model route defers to user', outcome, 'user-decides');
}

// 11. DeepSeek-family routes disable thinking so the short verdict fits maxTokens.
{
  const deepseekSession = () => {
    const s = makeSession();
    s.requestHeader = () => ({ config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } });
    return s;
  };
  const { outcome } = await dispatch({ script: { text: 'ALLOW' }, req: makeReq(deepseekSession()) });
  check('deepseek route still grants ALLOW', outcome, 'allowed-once');
  // Re-run capturing the options passed to llm.stream.
  const ctx = new Context();
  const llm = llmStub({ text: 'ALLOW' });
  ctx.provide('llm', llm);
  ctx.provide('permissionPresets', presetsStub(PRESET));
  await ctx.plugin(plugin);
  await ctx.waterfall('approval/request', makeReq(deepseekSession()), () => Promise.resolve('user-decides'));
  ctx.fiber.dispose();
  const opts = llm.state.options[0];
  check('deepseek review disables thinking', opts.reasoningEffort, 'off');
}

// 12. Non-deepseek route omits reasoningEffort (adapter-agnostic fail-closed).
{
  const ctx = new Context();
  const llm = llmStub({ text: 'ALLOW' });
  ctx.provide('llm', llm);
  ctx.provide('permissionPresets', presetsStub(PRESET));
  await ctx.plugin(plugin);
  const session = makeSession();
  session.requestHeader = () => ({ config: { provider: 'pi-ai', model: 'some-model' } });
  await ctx.waterfall('approval/request', makeReq(session), () => Promise.resolve('user-decides'));
  ctx.fiber.dispose();
  check('non-deepseek route sends no reasoningEffort', llm.state.options[0].reasoningEffort, undefined);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
