/**
 * End-to-end proof for the dsh-llm-approver gate against a LIVE dsh web
 * instance. Drives the RPC API directly (no browser, no /api/respond ever
 * called), so any executed escalation is proof the LLM gate granted it.
 *
 *   node dsh-llm-approver/test/e2e-verify.mjs <port>
 */

const PORT = process.argv[2] ?? '3081';
const BASE = `http://127.0.0.1:${PORT}`;
const TARGET = `${process.env.HOME}/sandbox-llm-gate-test.txt`;

let seq = 0;
async function rpc(method, payload) {
  const rpcId = `${Date.now()}-${seq++}`;
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${method}`);
  const body = await res.json();
  if (body.type !== 'server-response' || body.rpcId !== rpcId) throw new Error(`bad envelope for ${method}`);
  if (!body.result.ok) throw new Error(`${method} failed: ${JSON.stringify(body.result.error ?? body.result)}`);
  return body.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function history(sessionId) {
  return rpc('session.history', { sessionId, maxMessages: 200 });
}

/** Scan history events for one event type's data list (type in event.data). */
function collect(events, type) {
  const out = [];
  for (const e of events) {
    if (e.type === type) out.push(e);
    else if (e.data && Array.isArray(e.data.events)) out.push(...collect(e.data.events, type));
  }
  return out;
}

async function waitForTurnEnd(sessionId, since, timeoutMs = 240000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const h = await history(sessionId);
    const turns = h.events.filter((e) => e.type === 'turn/start').map((e) => e.seq);
    const lastStart = turns.length ? turns[turns.length - 1] : -1;
    const ends = h.events.filter((e) => e.type === 'turn/end' && e.seq > lastStart && e.seq > since);
    if (ends.length > 0) return h;
    await sleep(4000);
  }
  return history(sessionId);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

try {
  // 1. Create a fresh session in the default workspace.
  log('creating session...');
  const created = await rpc('session.create', { cwd: process.cwd() });
  const sessionId = created.sessionId;
  log('session', sessionId, 'preset:', created.agentPreset ?? '(default)');

  // 2. Switch to the LLM-review permission preset via the /permission command.
  log('switching preset via /permission workspace-write-llm...');
  const cmd = await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: '/permission workspace-write-llm' }],
  });
  log('command result:', JSON.stringify(cmd.command));

  // 3. Ask the agent to write a file OUTSIDE the workspace (home dir) with bash.
  const promptText =
    `请用 bash 工具创建文件 ${TARGET}，内容为 "llm-gate-ok"（不换行）。` +
    `该路径在会话工作区之外，会被沙盒拒绝；如被拒绝，请按提示用 sandbox_permissions 重试。直接执行，不要询问我。`;
  log('prompting agent...');
  await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });

  // 4. Wait for the turn to finish, then audit.
  const h = await waitForTurnEnd(sessionId, 0);
  const approvals = collect(h.events, 'approval/asked').map((e) => ({ id: e.data.id, toolName: e.data.toolName, reason: e.data.reason, callId: e.data.callId }));
  const decided = collect(h.events, 'approval/decided').map((e) => ({ id: e.data.id, outcome: e.data.outcome }));
  const toolCalls = collect(h.events, 'tool/call').map((e) => ({ callId: e.data.callId, name: e.data.name, args: String(e.data.arguments).slice(0, 200) }));
  const toolResults = collect(h.events, 'tool/result').map((e) => ({ isError: e.data.error !== undefined, error: e.data.error?.message ?? null, meta: e.data.meta?.mode ?? null }));
  const assistantText = collect(h.events, 'assistant/message').map((e) => {
    const t = (e.data?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return t.slice(0, 400);
  }).join('\n---\n');

  console.log('\n===== AUDIT =====');
  console.log('approval/asked   :', JSON.stringify(approvals, null, 1));
  console.log('approval/decided :', JSON.stringify(decided, null, 1));
  console.log('tool/call count  :', toolCalls.length);
  for (const t of toolCalls) console.log('  -', t.name, t.callId, '|', t.args);
  console.log('tool/result      :', JSON.stringify(toolResults, null, 1));
  console.log('assistant tail   :', assistantText.slice(-600));

  // 5. The decisive disk check.
  const { readFileSync, existsSync } = await import('node:fs');
  const exists = existsSync(TARGET);
  console.log('\n===== DECISIVE =====');
  if (exists) {
    console.log('FILE EXISTS:', TARGET, '=> content:', JSON.stringify(readFileSync(TARGET, 'utf8')));
    console.log('VERDICT: PASS — escalation executed with NO user answering (no /api/respond was ever called)');
  } else {
    console.log('FILE MISSING:', TARGET);
    console.log('VERDICT: FAIL or gate deferred to user — check the browser for an approval prompt');
  }
  process.exit(exists ? 0 : 2);
} catch (error) {
  console.error('E2E ERROR:', error.message);
  process.exit(1);
}
