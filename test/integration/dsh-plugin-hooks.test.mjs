/**
 * EMA Phase 7 — DSH Plugin & Slash Command Integration Tests
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { apply, buildStaticContext } from '../../dsh/plugin.mjs';
import { parseEmaCommand, buildEmaPrompt } from '../../dsh/slash-ema.mjs';
import { estimateTokens } from '../../src/retrieval/context-builder.mjs';

function createMockCordis() {
  const registeredCommands = new Map();
  const registeredSkills = [];
  const registeredProviders = [];
  const eventListeners = new Map();

  const ctx = {
    skills: {
      register(skill) {
        registeredSkills.push(skill);
      },
      registerProvider(thunk) {
        registeredProviders.push(thunk());
      },
    },
    commands: {
      register(cmd) {
        registeredCommands.set(cmd.name, cmd);
      },
    },
    effect(fn) {
      fn();
    },
    on(event, handler) {
      if (!eventListeners.has(event)) {
        eventListeners.set(event, []);
      }
      eventListeners.get(event).push(handler);
    },
    emit(event, payload) {
      const handlers = eventListeners.get(event) || [];
      for (const h of handlers) {
        h(payload, () => {});
      }
    },
    registeredCommands,
    registeredSkills,
    registeredProviders,
    eventListeners,
  };

  return ctx;
}

// ── Static Context Injection (< 500 Tokens) ──────────────────────────────────

test('Static Context: buildStaticContext strictly stays under 500 tokens', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-plugin-test-'));
  try {
    const agentsContent = `# AGENTS.md
## Critical Rules
1. Discover before assume
2. Evidence before memory
3. One canonical home per concept
4. Current wins over historical
## Memory Navigation
Some nav details...`;
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), agentsContent, 'utf8');

    const ctxText = buildStaticContext(tmpDir, 500);
    assert.ok(ctxText, 'Context text must not be null');
    assert.ok(ctxText.includes('[EMA Active Engineering Context]'));
    assert.ok(ctxText.includes('Discover before assume'));

    const tokens = estimateTokens(ctxText);
    assert.ok(tokens <= 500, `Estimated tokens (${tokens}) must be <= 500 tokens`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Static Context: returns null when AGENTS.md is absent', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-empty-test-'));
  try {
    const ctxText = buildStaticContext(tmpDir, 500);
    assert.equal(ctxText, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── /ema Slash Command Parsing & Prompts ────────────────────────────────────

test('Slash Command: parseEmaCommand parses recall, status, verify, and promote', () => {
  const r1 = parseEmaCommand('recall postgres connection pool');
  assert.equal(r1.subcommand, 'recall');
  assert.deepEqual(r1.args, ['postgres', 'connection', 'pool']);

  const r2 = parseEmaCommand('status');
  assert.equal(r2.subcommand, 'status');
  assert.deepEqual(r2.args, []);

  const r3 = parseEmaCommand('verify');
  assert.equal(r3.subcommand, 'verify');

  const r4 = parseEmaCommand('promote cand-123 workspace');
  assert.equal(r4.subcommand, 'promote');
  assert.deepEqual(r4.args, ['cand-123', 'workspace']);

  const r5 = parseEmaCommand('');
  assert.equal(r5.subcommand, 'default');
});

test('Slash Command: buildEmaPrompt constructs expected instructions per subcommand', () => {
  const recallPrompt = buildEmaPrompt('recall', ['rate', 'limiting'], '/ws');
  assert.ok(recallPrompt.includes('rate limiting'));
  assert.ok(recallPrompt.includes('Stage 1-6 retrieval pipeline'));

  const statusPrompt = buildEmaPrompt('status', [], '/ws');
  assert.ok(statusPrompt.includes('.ema/index.db'));
  assert.ok(statusPrompt.includes('.ema/candidates/'));

  const verifyPrompt = buildEmaPrompt('verify', [], '/ws');
  assert.ok(verifyPrompt.includes('memory-verification'));

  const promotePrompt = buildEmaPrompt('promote', ['cand-99', 'global'], '/ws');
  assert.ok(promotePrompt.includes('cand-99'));
  assert.ok(promotePrompt.includes('global'));
  assert.ok(promotePrompt.includes('≥2 independent repository sources'));
});

// ── Plugin Lifecycle & Seamless Coexistence ──────────────────────────────────

test('Plugin Lifecycle: registers both /project-memory and /ema commands seamlessly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-cordis-test-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# AGENTS.md\n## Critical Rules\n1. Rule A\n2. UNIQUE-WORKSPACE-MARKER-9f3a', 'utf8');

    const ctx = createMockCordis();
    const disposer = apply(ctx, { workspaceRoot: tmpDir });

    // Both commands must be registered
    assert.ok(ctx.registeredCommands.has('project-memory'), 'Must register /project-memory');
    assert.ok(ctx.registeredCommands.has('ema'), 'Must register /ema');

    // Test /ema invocation
    const emaCmd = ctx.registeredCommands.get('ema');
    const injectedMessages = [];
    const mockAgent = {
      session: { header: { cwd: tmpDir } },
      followup(msg) {
        injectedMessages.push(msg);
      },
      inject(msg) {
        injectedMessages.push(msg);
      },
    };

    const res = emaCmd.handler({ rawInput: ' recall postgres', agent: mockAgent });
    assert.equal(res.kind, 'success');
    assert.equal(injectedMessages.length, 1);
    assert.ok(injectedMessages[0].content[0].text.includes('Recall Query'));

    // The subcommand must come from `invocation.rawInput`: DSH 0.1.7 has no
    // `invocation.text`, so reading it silently degraded every /ema call to `default`.
    const statusRes = emaCmd.handler({ rawInput: 'status', agent: mockAgent });
    assert.equal(statusRes.kind, 'success');
    assert.ok(
      injectedMessages[1].content[0].text.includes('.ema/index.db'),
      'the status subcommand must be parsed out of rawInput',
    );

    // Test agent/pre-step event triggers static context injection
    ctx.emit('agent/pre-step', { agent: mockAgent, cwd: tmpDir });

    // Should have injected static context (< 500 tokens)
    const contextMsg = injectedMessages.find(m => m.content?.[0]?.text?.includes('[EMA Active Engineering Context]'));
    assert.ok(contextMsg, 'Static context must be injected during agent/pre-step');
    assert.ok(contextMsg.content[0].text.includes('[EMA Active Engineering Context]'));
    assert.ok(
      contextMsg.content[0].text.includes('UNIQUE-WORKSPACE-MARKER-9f3a'),
      'the workspace must resolve from agent.session.header.cwd (process.cwd() would not carry this marker)',
    );

    if (typeof disposer === 'function') {
      disposer();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Native DSH System Bundled Skills Provider ─────────────────────────────────

test('Bundled Skills: registers 8 system bundled skills via ctx.skills.registerProvider', async () => {
  const ctx = createMockCordis();
  const disposer = apply(ctx, { workspaceRoot: process.cwd() });

  assert.equal(ctx.registeredProviders.length, 1, 'Must register exactly 1 bundled skill provider');
  const provider = ctx.registeredProviders[0];
  assert.equal(provider.name, 'project-memory', 'Provider name must be project-memory');

  const candidates = await provider.list();
  assert.equal(candidates.length, 8, 'Must provide all 8 Project Memory skills');

  const expectedSkills = [
    'knowledge-classification',
    'knowledge-compounding',
    'knowledge-discovery',
    'memory-architecture',
    'memory-edit',
    'memory-verification',
    'obsolete-knowledge',
    'repository-audit'
  ];

  for (const expected of expectedSkills) {
    const candidate = candidates.find(c => c.name === expected);
    assert.ok(candidate, `Candidate list must include ${expected}`);
    assert.equal(candidate.source, 'bundled', 'Must be marked as bundled');
    assert.equal(candidate.rank, 600, 'Bundled skill rank must be 600');
    assert.equal(candidate.invocation.modelInvocable, true);
    assert.equal(candidate.invocation.userInvocable, true);

    const definition = await provider.get(candidate);
    assert.equal(definition.name, expected);
    assert.ok(definition.content.length > 100, 'Skill content must be loaded');
    assert.ok(!definition.content.startsWith('---'), 'Frontmatter must be stripped');
  }

  if (typeof disposer === 'function') {
    disposer();
  }
});

// ── Message source attribution (session format v4) ──────────────────────────

test('Message source: injections declare a producer-owned kind, never the retired "plugin"', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-source-test-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# AGENTS.md\n## Critical Rules\n1. Rule A', 'utf8');

    const ctx = createMockCordis();
    const disposer = apply(ctx, { workspaceRoot: tmpDir });

    const injected = [];
    const mockAgent = {
      session: { header: { cwd: tmpDir } },
      followup(msg) { injected.push(msg); },
      inject(msg) { injected.push(msg); },
    };

    ctx.registeredCommands.get('ema').handler({ text: 'status', agent: mockAgent });
    ctx.registeredCommands.get('project-memory').handler({ text: '', agent: mockAgent });
    ctx.emit('agent/pre-step', { agent: mockAgent, cwd: tmpDir });

    assert.ok(injected.length >= 3, `expected slash-command and hook injections, got ${injected.length}`);

    // ContextForm values the protocol declares (see @deepseek-ai/dsh-llm message types).
    const DECLARED_FORMS = new Set(['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall']);

    for (const message of injected) {
      assert.equal(message.role, 'user');
      assert.equal(typeof message.id, 'string');
      assert.ok(message.id.length > 0, 'every injection carries its own identity');
      assert.ok(Array.isArray(message.content) && message.content.length > 0);
      assert.ok(Object.isFrozen(message), 'injections come from the host createUserMessage()');

      const { kind, form } = message.source ?? {};
      assert.notEqual(
        kind,
        'plugin',
        'session format v4 refuses the retired catch-all "plugin" kind ("format v4 message requires a producer-owned source kind")',
      );
      assert.match(String(kind), /^plugin:.+/, `expected a producer-owned kind, got ${JSON.stringify(kind)}`);
      assert.ok(form === undefined || DECLARED_FORMS.has(form), `undeclared ContextForm: ${JSON.stringify(form)}`);
    }

    if (typeof disposer === 'function') {
      disposer();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Post-task compounding (agent/turn-stopping) ─────────────────────────────

/** Agent stub whose session exposes derived history, as the host Session does. */
function compoundingAgent(tmpDir, injected, messages) {
  return {
    session: { header: { cwd: tmpDir }, deriveMessages: () => messages },
    inject(msg) { injected.push(msg); },
    followup(msg) { injected.push(msg); },
  };
}

test('Post-task compounding: off by default (opt-in via COMPOUNDING_ENABLED)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-compound-off-'));
  const previous = process.env.COMPOUNDING_ENABLED;
  delete process.env.COMPOUNDING_ENABLED;
  try {
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# AGENTS.md\n## Critical Rules\n1. Rule A', 'utf8');
    const ctx = createMockCordis();
    const disposer = apply(ctx, { workspaceRoot: tmpDir });

    const injected = [];
    const agent = compoundingAgent(tmpDir, injected, [
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(80) }], source: { kind: 'user' } },
    ]);
    ctx.emit('agent/turn-stopping', { agent, turn: 1 });
    assert.equal(injected.length, 0, 'compounding must not inject unless explicitly enabled');

    if (typeof disposer === 'function') disposer();
  } finally {
    if (previous !== undefined) process.env.COMPOUNDING_ENABLED = previous;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Post-task compounding: injects once on agent/turn-stopping for a substantial human task', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-compound-on-'));
  const previous = process.env.COMPOUNDING_ENABLED;
  process.env.COMPOUNDING_ENABLED = '1';
  try {
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# AGENTS.md\n## Critical Rules\n1. Rule A', 'utf8');
    const ctx = createMockCordis();
    const disposer = apply(ctx, { workspaceRoot: tmpDir });

    const injected = [];
    const human = { role: 'user', content: [{ type: 'text', text: 'y'.repeat(80) }], source: { kind: 'user' } };
    const agent = compoundingAgent(tmpDir, injected, [human, { role: 'assistant', content: [{ type: 'text', text: 'done' }] }]);

    ctx.emit('agent/turn-stopping', { agent, turn: 1 });
    assert.equal(injected.length, 1, 'a substantial human task must trigger the compounding prompt');
    assert.ok(injected[0].content[0].text.includes('Project Memory'));

    ctx.emit('agent/turn-stopping', { agent, turn: 2 });
    assert.equal(injected.length, 1, 'the prompt is injected at most once per agent');

    // Context this plugin (or any producer) injected is not the user's own task.
    const injectedOnly = compoundingAgent(tmpDir, injected, [
      { role: 'user', content: [{ type: 'text', text: 'z'.repeat(80) }], source: { kind: 'plugin:dsh-project-memory' } },
    ]);
    ctx.emit('agent/turn-stopping', { agent: injectedOnly, turn: 3 });
    assert.equal(injected.length, 1, 'producer-injected context must not count as the human task');

    if (typeof disposer === 'function') disposer();
  } finally {
    if (previous === undefined) delete process.env.COMPOUNDING_ENABLED;
    else process.env.COMPOUNDING_ENABLED = previous;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Slash Command: /project-memory reads its flags from invocation.rawInput', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-trace-test-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# AGENTS.md\n## Critical Rules\n1. Rule A', 'utf8');
    const ctx = createMockCordis();
    const disposer = apply(ctx, { workspaceRoot: tmpDir });

    const injected = [];
    const agent = compoundingAgent(tmpDir, injected, []);
    const res = ctx.registeredCommands.get('project-memory').handler({ rawInput: ' --trace', agent });
    assert.equal(res.kind, 'success');
    assert.ok(injected[0].content[0].text.includes('Retrieval Trace Mode'), '--trace must be read from rawInput');

    if (typeof disposer === 'function') disposer();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Slash Command: /ema strips --trace from the query and requests a retrieval trace', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-trace-flag-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# AGENTS.md\n## Critical Rules\n1. Rule A', 'utf8');
    const ctx = createMockCordis();
    const disposer = apply(ctx, { workspaceRoot: tmpDir });

    const injected = [];
    const agent = compoundingAgent(tmpDir, injected, []);
    ctx.registeredCommands.get('ema').handler({ rawInput: 'recall rate limiting --trace', agent });

    const text = injected[0].content[0].text;
    assert.ok(text.includes('rate limiting'), 'the query must survive the selector');
    assert.ok(!text.includes('--trace'), 'the selector must not leak into the search query');
    assert.ok(text.includes('Retrieval Trace'), 'the trace note must be appended');

    if (typeof disposer === 'function') disposer();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
