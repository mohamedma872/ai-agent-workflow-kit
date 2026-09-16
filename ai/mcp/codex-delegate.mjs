#!/usr/bin/env node

/**
 * codex-delegate MCP server
 *
 * Lets a Claude orchestrator delegate a focused workflow role to Codex without
 * putting the full task context or Codex response back into Claude's context.
 *
 * Claude passes paths to run artifacts under ai/runs/<id>/. This server reads
 * the context locally, calls ai/workflow/router.js with --agent codex, writes
 * Codex's detailed final result to another run artifact, and returns only a
 * compact status object to the MCP host.
 *
 * Security properties:
 * - prompt/output files must stay inside the same ai/runs/<id>/ tree
 * - the actual Codex process still uses the repo's Codex hook/guardrail wiring
 * - no shell interpolation: child_process.spawnSync receives argv directly
 * - stdout is reserved for MCP; diagnostics go to stderr
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const RUNS = path.join(ROOT, 'ai', 'runs');
const ROUTER = path.join(ROOT, 'ai', 'workflow', 'router.js');

function runScopedPath(input, label) {
  const abs = path.resolve(ROOT, String(input || ''));
  const rel = path.relative(RUNS, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${label} must be inside ai/runs/<id>/`);
  }
  const [runId] = rel.split(path.sep);
  if (!runId || runId === '.' || runId === '..') {
    throw new Error(`${label} must identify a concrete ai/runs/<id>/ run`);
  }
  return { abs, runId };
}

function repoRelative(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

function currentChanges() {
  const res = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (res.status !== 0) { return []; }
  return String(res.stdout || '')
    .split('\n')
    .filter(Boolean)
    .map(line => line.slice(3).replace(/^"|"$/g, ''))
    .filter(file => !file.startsWith('ai/runs/'))
    .slice(0, 100);
}

function textResult(payload, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

const server = new McpServer({
  name: 'codex-delegate',
  version: '0.3.0',
});

server.registerTool(
  'delegate',
  {
    title: 'Delegate workflow role to Codex',
    description: 'Delegate a focused agentic-workflow role to Codex. Pass a context artifact under ai/runs/<id>/; Codex writes its detailed result to another run artifact. Returns only compact status metadata to save orchestrator context/tokens.',
    inputSchema: z.object({
      workflow: z.string().min(1).default('feature').describe('Workflow name, normally feature.'),
      role: z.string().min(1).describe('Workflow role to execute, e.g. implementation or fixes.'),
      prompt_file: z.string().min(1).describe('Repo-relative context file under ai/runs/<id>/.'),
      output_file: z.string().min(1).describe('Repo-relative result file under the same ai/runs/<id>/ tree.'),
      budget_usd: z.number().positive().max(100).default(20),
      timeout_min: z.number().int().positive().max(180).default(60),
    }),
  },
  async ({ workflow, role, prompt_file, output_file, budget_usd, timeout_min }) => {
    const started = Date.now();
    try {
      const prompt = runScopedPath(prompt_file, 'prompt_file');
      const output = runScopedPath(output_file, 'output_file');
      if (prompt.runId !== output.runId) {
        throw new Error('prompt_file and output_file must belong to the same ai/runs/<id>/ run');
      }
      if (!fs.existsSync(prompt.abs) || !fs.statSync(prompt.abs).isFile()) {
        throw new Error(`prompt_file does not exist: ${repoRelative(prompt.abs)}`);
      }
      if (fs.statSync(prompt.abs).size > 2 * 1024 * 1024) {
        throw new Error('prompt_file is larger than 2 MB; create a focused context artifact instead');
      }

      fs.mkdirSync(path.dirname(output.abs), { recursive: true });
      const before = new Set(currentChanges());
      const args = [
        ROUTER,
        'exec', workflow, role,
        '--agent', 'codex',
        '--prompt-file', prompt.abs,
        '--output-file', output.abs,
        '--budget', String(budget_usd),
        '--timeout-min', String(timeout_min),
      ];

      const res = spawnSync(process.execPath, args, {
        cwd: ROOT,
        env: {
          ...process.env,
          AI_DELEGATED_BY: 'claude-mcp',
          AI_DELEGATION_TRANSPORT: 'mcp',
        },
        encoding: 'utf8',
        timeout: (timeout_min + 1) * 60 * 1000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const after = currentChanges();
      const changed = after.filter(file => !before.has(file));
      const durationSeconds = Math.round((Date.now() - started) / 1000);
      const result = {
        ok: res.status === 0 && !res.error,
        workflow,
        role,
        executor: 'codex',
        run_id: prompt.runId,
        output_file: repoRelative(output.abs),
        changed_files: changed,
        duration_seconds: durationSeconds,
        exit_status: typeof res.status === 'number' ? res.status : null,
      };

      if (res.error || res.status !== 0) {
        const stderrTail = String(res.stderr || res.error?.message || '').slice(-1200);
        return textResult({ ...result, error: stderrTail || 'Codex delegation failed' }, true);
      }

      return textResult(result);
    } catch (error) {
      return textResult({
        ok: false,
        workflow,
        role,
        executor: 'codex',
        error: error instanceof Error ? error.message : String(error),
        duration_seconds: Math.round((Date.now() - started) / 1000),
      }, true);
    }
  }
);

serveStdio(() => server);
console.error('codex-delegate MCP server ready on stdio');
