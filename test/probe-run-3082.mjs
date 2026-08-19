/**
 * Probe run on the 3082 diagnostic instance: default preset -> llm, create
 * session, benign out-of-workspace write, report audit + wait 20s for the
 * host log to show probe/logger lines.
 */
const PORT = '3082';
const BASE = `http://127.0.0.1:${PORT}`;
const TARGET = `${process.env.HOME}/sandbox-llm-gate-test2.txt`;

let seq = 0;
async function rpc(method, payload) {
  const rpcId = `p-${Date.now()}-${seq++}`;
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  });
  const body = await res.json();
  if (!body.result.ok) throw new Error(`${method} failed: ${JSON.stringify(body.result.error ?? body.result)}`);
  return body.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const { existsSync, rmSync } = await import('node:fs');
rmSync(TARGET, { force: true });

log('settings.update: defaultPreset = workspace-write-llm');
await rpc('settings.update', { ns: 'permission', patch: { defaultPreset: 'workspace-write-llm' } });
await sleep(1500);

log('creating session...');
const created = await rpc('session.create', { cwd: process.cwd() });
const sid = created.sessionId;
const list = await rpc('session.list', {});
const item = list.items.find((i) => i.sessionId === sid);
log('session preset:', item?.projections?.values?.permissions?.currentValue, '| sessionId:', sid);

log('prompting benign write...');
await rpc('session.prompt', {
  sessionId: sid, mode: 'queue',
  content: [{ type: 'text', text:
    `用 bash 工具创建文件 ${TARGET}，内容为 "llm-gate-ok-2"（无换行）。该路径在工作区之外，若被沙盒拒绝，请按拒绝提示用 sandbox_permissions 重试。直接执行，不要询问我。` }],
});

// Poll for turn end (up to 4 min), then report.
const start = Date.now();
let events = [];
while (Date.now() - start < 240000) {
  const h = await rpc('session.history', { sessionId: sid, maxMessages: 400 });
  events = h.events.map((en) => en.event);
  const starts = events.filter((e) => e.type === 'turn/start');
  const lastStart = starts.length ? starts[starts.length - 1].seq : -1;
  if (events.some((e) => e.type === 'turn/end' && e.seq > lastStart)) break;
  await sleep(4000);
}

const asked = events.filter((e) => e.type === 'approval/asked');
const decided = events.filter((e) => e.type === 'approval/decided');
const calls = events.filter((e) => e.type === 'tool/call').map((e) => e.data.name + ' | ' + String(e.data.arguments).slice(0, 80));
const results = events.filter((e) => e.type === 'tool/result').map((e) => 'isError=' + !!e.data.error + ' meta=' + JSON.stringify(e.data.meta ?? null));
console.log('\n===== AUDIT =====');
console.log('approval/asked :', JSON.stringify(asked.map((e) => ({ reason: String(e.data.reason).slice(0, 60), callId: e.data.callId })), null, 1));
console.log('approval/decided:', JSON.stringify(decided.map((e) => e.data.outcome)));
console.log('tool/call      :', JSON.stringify(calls, null, 1));
console.log('tool/result    :', JSON.stringify(results, null, 1));
console.log('file exists    :', existsSync(TARGET), existsSync(TARGET) ? `content=${JSON.stringify((await import('node:fs')).readFileSync(TARGET, 'utf8'))}` : '');
console.log('turn ended     :', events.some((e) => e.type === 'turn/end'));

log('waiting 20s for host log flush...');
await sleep(20000);

log('restoring default preset');
await rpc('settings.update', { ns: 'permission', patch: { defaultPreset: 'workspace-write' } });
log('done');
