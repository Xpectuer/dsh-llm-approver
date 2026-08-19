/**
 * dsh-llm-approver — LLM pre-review gate for sandbox-escalation approvals.
 *
 * A prepended `approval/request` waterfall listener. When the session sits in
 * the configured permission preset (default `workspace-write-llm`) and the
 * request is a sandbox escalation (`escalate sandbox to <mode>: ...`), the
 * exact denied tool call is recovered from the session log by callId and an
 * independent-context LLM (no conversation history) judges it:
 *
 *   ALLOW  -> "allowed-once", the command runs, the user is never prompted.
 *   DENY / timeout / error / unparsable / tool-call output / abort
 *          -> next(), the existing answerer (web UI) asks the user.
 *
 * The gate is fail-closed: it can only grant, never reject, and every failure
 * mode degrades to the user. Sessions in any other preset pass through
 * untouched (synchronous next()).
 */

import z from '@deepseek-ai/schemastery';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { deadline } from '@deepseek-ai/dsh-timeout';

/** Prefix stamped by dsh-sandbox approveEscalation — the only requests this gate judges. */
const ESCALATION_PREFIX = 'escalate sandbox to ';
/** Capability-owned timeout reason code for the review call. */
const TIMEOUT_CODE = 'LLM_APPROVER_TIMEOUT';
/** Bounded excerpt of the most recent human message. */
const USER_INSTRUCTION_MAX_CHARS = 2000;

export const Config = z.object({
  preset: z.string().default('workspace-write-llm'),
  provider: z.string(),
  model: z.string(),
  timeoutMs: z.number().step(1).min(1000).default(60000),
  maxTokens: z.number().step(1).min(1).default(256),
  maxInstructionChars: z.number().step(1).min(256).default(16384),
  includeUserInstruction: z.boolean().default(true),
});

/** Conservative reviewer rubric; the entire decision policy lives here. */
function systemPrompt() {
  return [
    'You are a sandbox-escalation reviewer for an AI coding assistant. A tool call was DENIED by the sandbox because it exceeds the session\'s current file-access boundary, and the assistant requests a one-time wider permission for that exact call.',
    '',
    'Decide whether this single escalation may proceed WITHOUT asking the user.',
    '',
    'ALLOW only when ALL of the following hold:',
    '- The operation is reversible or trivially recoverable (writing a new file, reading, listing, installing packages, running tests).',
    '- It destroys nothing: no recursive or force deletion, no overwriting of existing user files outside the workspace, no permission/ownership changes, no process killing, no git history rewriting.',
    '- It touches no sensitive locations or data: no SSH keys, credentials, browser profiles, system directories, or other users\' data.',
    '- The stated justification matches what the command actually does.',
    '- The requested mode is not broader than the command needs.',
    '',
    'DENY when anything is destructive, irreversible, sensitive, mismatched with the justification, or you are uncertain.',
    '',
    'Answer with exactly one word on the first line: ALLOW or DENY. Optionally one short reason on the second line.',
  ].join('\n');
}

/** Fold the session's effective sandbox mode (last sandbox/mode event). */
function effectiveSandboxMode(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === 'sandbox/mode') return events[i].data.mode;
  }
  return undefined;
}

/** Find the denied tool call behind this approval request, newest first. */
function findToolCall(events, callId) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type === 'tool/call' && event.data.callId === callId) return event.data;
  }
  return undefined;
}

/** Extract a bounded plain-text excerpt of the most recent human message. */
function lastUserInstruction(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type !== 'user/message') continue;
    if (event.data?.source?.kind !== 'user') continue;
    const text = (event.data.content ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n');
    if (text.length > 0) return text.slice(0, USER_INSTRUCTION_MAX_CHARS);
  }
  return undefined;
}

/** The first non-empty output line, upper-cased. */
function verdictOf(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.toUpperCase();
  }
  return '';
}

export default {
  name: 'llm-approver',
  inject: ['llm'],
  Config,
  apply(ctx, config) {
    const logger = ctx.logger;

    ctx.on('approval/request', async (req, next) => {
      // Gate 1: session must sit in the configured preset right now.
      const presets = ctx.get('permissionPresets');
      if (presets === undefined) return next();
      const events = req.agent.session.events;
      if (presets.current(events) !== config.preset) return next();

      // Gate 2: only sandbox-escalation requests; everything else goes to the user.
      const reason = req.reason ?? '';
      if (!reason.startsWith(ESCALATION_PREFIX)) return next();
      const requestedMode = reason.slice(ESCALATION_PREFIX.length).split(':')[0]?.trim() ?? '';

      // Gate 3: recover the exact denied call; without it we do not judge.
      const call = req.callId !== undefined ? findToolCall(events, req.callId) : undefined;
      if (call === undefined) {
        logger.info('llm-approver: no tool/call event for callId %s; deferring to user', String(req.callId));
        return next();
      }

      // Resolve the review route: config override, else the session's current route.
      const header = req.agent.session.requestHeader();
      const route = config.provider !== undefined && config.model !== undefined
        ? { provider: config.provider, model: config.model }
        : header?.config !== undefined
          ? { provider: header.config.provider, model: header.config.model }
          : undefined;
      if (route === undefined || typeof route.provider !== 'string' || typeof route.model !== 'string') {
        logger.warn('llm-approver: no model route available; deferring to user');
        return next();
      }

      // Compose the independent-context review payload.
      const argsText = typeof call.arguments === 'string'
        ? call.arguments
        : JSON.stringify(call.arguments);
      const truncatedArgs = argsText.length > config.maxInstructionChars
        ? argsText.slice(0, config.maxInstructionChars) + '\n...[truncated]'
        : argsText;
      const justification = reason.slice(ESCALATION_PREFIX.length).split(':').slice(1).join(':').trim();
      const payload = {
        tool: call.name,
        arguments: truncatedArgs,
        requestedMode,
        justification,
        currentSandboxMode: effectiveSandboxMode(events) ?? 'workspace-write',
        workspaceRoot: req.agent.session.header?.cwd,
        ...(config.includeUserInstruction
          ? { recentUserInstruction: lastUserInstruction(events) ?? null }
          : {}),
      };

      // Ask the reviewer. ANY failure falls through to next() — the gate never
      // denies on the user's behalf and never grants without an explicit ALLOW.
      let verdict = '';
      try {
        const callDeadline = deadline(req.signal, config.timeoutMs, TIMEOUT_CODE);
        try {
          const assembler = new BlockAssembler();
          const stream = ctx.llm.stream({
            provider: route.provider,
            model: route.model,
            // Disable thinking on DeepSeek-family routes: the reviewer must emit
            // a short verdict, and a thinking budget would exhaust maxTokens
            // before any ALLOW/DENY (which the gate treats as fail-closed).
            ...route.provider.includes('deepseek') ? { reasoningEffort: 'off' } : {},
            messages: [createUserMessage({
              content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
              source: { kind: 'plugin', plugin: 'dsh-llm-approver' },
            })],
            system: systemPrompt(),
            maxTokens: config.maxTokens,
            sessionId: req.agent.session.id,
            signal: callDeadline.signal,
          });
          for await (const chunk of stream) {
            if (callDeadline.signal.aborted) break;
            assembler.push(chunk);
          }
          const finish = assembler.finish;
          if (finish.kind !== 'stop') {
            logger.info('llm-approver: review stream finished with %s; deferring to user', finish.kind);
            return next();
          }
          const blocks = assembler.blocks();
          if (blocks.some((block) => block.type === 'tool-call')) {
            logger.warn('llm-approver: reviewer requested a tool call; deferring to user');
            return next();
          }
          verdict = verdictOf(blocks
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n'));
        } finally {
          callDeadline[Symbol.dispose]();
        }
      } catch (error) {
        logger.warn('llm-approver: review failed (%s); deferring to user', error?.message ?? String(error));
        return next();
      }

      if (verdict === 'ALLOW') {
        logger.info('llm-approver: ALLOW escalation to %s for %s (callId %s)', requestedMode, call.name, String(req.callId));
        return 'allowed-once';
      }
      logger.info('llm-approver: verdict %s for %s (callId %s); deferring to user', verdict === '' ? 'unparsable' : verdict, call.name, String(req.callId));
      return next();
    }, { prepend: true });
  },
};
