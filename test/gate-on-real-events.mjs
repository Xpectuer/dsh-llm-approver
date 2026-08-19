/**
 * Offline diagnostic: pull a REAL session's events from the live instance,
 * reconstruct the approval/request req exactly as approveEscalation would,
 * and run the installed gate handler against it with a next() spy.
 *
 *   node dsh-llm-approver/test/gate-on-real-events.mjs <port> <sessionId>
 */

import { Context } from '@deepseek-ai/cordis';
import plugin from '/Users/zhengjiaye/.dsh/profiles/web/node_modules/@dsh-external/dsh-llm-approver/lib/index.js';

const PORT = process.argv[2] ?? '3081';
const SESSION = process.argv[3];
const BASE = `http://127.0.0.1:${PORT}`;

const res = await fetch(`${BASE}/api/session.history`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: 'diag-1', method: 'session.history', payload: { sessionId: SESSION, maxMessages: 1000 } }),
});
const body = await res.json();
if (!body.result.ok) { console.error('history failed', JSON.stringify(body.result)); process.exit(1); }
const events = body.result.value.events.map((en) => en.event);
console.log('events:', events.length);

// Rebuild the permission-presets fold from real events (same math as dsh-permission-presets derive).
function foldKnobs(evs) {
  let preset = null, sandbox = null, approval = null;
  for (const e of evs) {
    if (e.type === 'permission/preset') preset = e.data.preset;
    else if (e.type === 'sandbox/mode') sandbox = e.data.mode;
    else if (e.type === 'approval/policy') approval = e.data.policy;
  }
  return { preset, sandbox, approval };
}
const knobs = foldKnobs(events);
console.log('knob fold:', JSON.stringify(knobs));

const asked = events.filter((e) => e.type === 'approval/asked');
console.log('approval/asked count:', asked.length);
const last = asked[asked.length - 1];
if (!last) { console.log('no approval/asked found'); process.exit(0); }

const headerEvent = events.filter((e) => e.type === 'request/header').pop();
console.log('last request/header:', headerEvent ? JSON.stringify(headerEvent.data.header?.config) : 'none');

// Reconstruct the req exactly like dsh-sandbox approveEscalation does.
const req = {
  agent: {
    session: {
      id: SESSION,
      events,
      header: { cwd: '/Users/zhengjiaye/workspace' },
      requestHeader: () => headerEvent?.data.header ?? undefined,
    },
  },
  toolName: 'bash',
  callId: last.data.callId,
  reason: last.data.reason,
  signal: undefined,
};

// Boot the REAL plugin in a bare context with a live-fold permissionPresets stub.
const ctx = new Context();
ctx.provide('llm', {
  stream() { throw new Error('llm should not be called in this diagnostic unless gates pass'); },
});
ctx.provide('permissionPresets', {
  current(evs) {
    const k = foldKnobs(evs);
    return k.preset === 'workspace-write-llm' ? 'workspace-write-llm' : 'workspace-write';
  },
});
await ctx.plugin(plugin);

let nextCalled = false;
const outcome = await ctx.waterfall('approval/request', req, () => { nextCalled = true; return Promise.resolve('user-decides'); });
console.log('gate outcome:', JSON.stringify(outcome), '| next() called:', nextCalled);

// Also check callId matching against the tool/call events.
const toolCalls = events.filter((e) => e.type === 'tool/call');
console.log('tool/call count:', toolCalls.length);
console.log('last approval callId:', last.data.callId);
console.log('tool/call callIds:', toolCalls.map((t) => t.data.callId).join(', '));
console.log('reason:', last.data.reason);
process.exit(0);
