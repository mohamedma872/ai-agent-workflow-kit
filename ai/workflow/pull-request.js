#!/usr/bin/env node
'use strict';
/*
 * The pull-request stage's runtime. After final verification passes it commits
 * the run worktree, pushes it to a branch and opens the pull request, or finds
 * the one already open for that branch.
 *
 * Every external action lives here as deterministic Node code: git add/commit/
 * push, the GitHub CLI and the Bitbucket REST call. The only agent involved is
 * pr-description, which writes the title and body as a run artifact
 * (12-pull-request.json) and never runs git or talks to a provider.
 *
 * Secrets: credentials are read from the environment by name only. The
 * Bitbucket Authorization header is built inside the --http child from its own
 * environment, so a token never appears in argv, stdin, logs, state, artifacts
 * or error messages. Remote URLs have their userinfo stripped before they are
 * printed or stored.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const { attributionProblems } = require('./artifacts');

const CONFIG_DEFAULTS = Object.freeze({ enabled: false, provider: 'auto', remote: 'origin', base: 'auto', branch: 'ai/{id}', draft: false });
const PROVIDERS = new Set(['auto', 'github', 'bitbucket']);
const BITBUCKET_API = 'api.bitbucket.org';
const BITBUCKET_ENV = 'BITBUCKET_EMAIL and BITBUCKET_API_TOKEN (or BITBUCKET_USERNAME and BITBUCKET_APP_PASSWORD)';
const SECRET_ENV = ['BITBUCKET_API_TOKEN', 'BITBUCKET_APP_PASSWORD', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN'];

class Blocked extends Error {}

function evalMode(env = process.env) { return env.AI_EVAL === '1' || env.QC_EVAL === '1'; }

// ---------------------------------------------------------------- redaction

function redact(text, env = process.env) {
  let out = String(text == null ? '' : text).replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1');
  for (const name of SECRET_ENV) {
    const value = env[name];
    if (typeof value === 'string' && value.length >= 6) out = out.split(value).join('***');
  }
  return out;
}

// ---------------------------------------------------------------- config

// A ref name the runtime will hand to git: a conservative subset of what
// `git check-ref-format` accepts, so a config value can never smuggle an option
// or a refspec into argv.
function validRef(name) {
  const v = String(name || '');
  return /^[A-Za-z0-9._/-]{1,200}$/.test(v) && !v.startsWith('-') && !v.startsWith('/') && !v.endsWith('/')
    && !v.endsWith('.') && !v.endsWith('.lock') && !v.includes('..') && !v.includes('//') && !v.includes('/.') && !v.startsWith('.');
}
function validBranchTemplate(template) { return typeof template === 'string' && validRef(template.replaceAll('{id}', 'RUN-1')); }

function validateOptions(raw, problems, where = 'pull_request') {
  const v = {};
  if ('enabled' in raw) { if (typeof raw.enabled === 'boolean') v.enabled = raw.enabled; else problems.push(`${where}.enabled must be true or false`); }
  if ('provider' in raw) { if (PROVIDERS.has(raw.provider)) v.provider = raw.provider; else problems.push(`${where}.provider must be auto, github or bitbucket`); }
  if ('remote' in raw) { if (typeof raw.remote === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(raw.remote) && !raw.remote.startsWith('-')) v.remote = raw.remote; else problems.push(`${where}.remote must be a git remote name`); }
  if ('base' in raw) { if (raw.base === 'auto' || validRef(raw.base)) v.base = raw.base; else problems.push(`${where}.base must be auto or a branch name`); }
  if ('branch' in raw) { if (validBranchTemplate(raw.branch)) v.branch = raw.branch; else problems.push(`${where}.branch must be a branch name template such as "ai/{id}"`); }
  if ('draft' in raw) { if (typeof raw.draft === 'boolean') v.draft = raw.draft; else problems.push(`${where}.draft must be true or false`); }
  return v;
}

// Read from the PROJECT root (the main checkout), never from the run worktree:
// implementation and fixes may write the worktree, and must not be able to
// turn on outward writes or change where they go.
function loadConfig(root) {
  const out = { ...CONFIG_DEFAULTS, problems: [], source: null };
  const file = path.join(root, '.agentic', 'config.yaml');
  if (!fs.existsSync(file)) return out;
  let data;
  try { data = yaml.load(fs.readFileSync(file, 'utf8')); }
  catch (e) { out.problems.push(`.agentic/config.yaml is not valid YAML (${String(e.message).split('\n')[0]})`); return out; }
  const block = data && typeof data === 'object' ? data.pull_request : undefined;
  if (block === undefined || block === null) return out;
  out.source = '.agentic/config.yaml';
  if (typeof block !== 'object' || Array.isArray(block)) { out.problems.push('pull_request must be a mapping'); return out; }
  const set = validateOptions(block, out.problems);
  // Which keys the file set, so a default (branch "ai/{id}") can give way to
  // the worktree's own tracked branch while a configured value never does.
  return { ...out, ...set, configured: Object.keys(set) };
}

// Config plus the overrides `agentic pr` stored in the run state. A manual
// request is the human's explicit decision, so it opens the PR even while the
// config block is disabled.
function effectiveOptions(config, overrides) {
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  return {
    enabled: config.enabled === true || o.manual === true,
    manual: o.manual === true,
    provider: config.provider,
    remote: config.remote,
    base: o.base || config.base,
    branch: o.branch || config.branch,
    // A branch or draft the human asked for (agentic pr) or wrote in the config.
    branchExplicit: !!o.branch || (config.configured || []).includes('branch'),
    draft: typeof o.draft === 'boolean' ? o.draft : config.draft,
    draftExplicit: typeof o.draft === 'boolean' || (config.configured || []).includes('draft'),
    problems: [...(config.problems || [])],
  };
}

function branchFor(template, id) { return String(template).replaceAll('{id}', id); }

// ---------------------------------------------------------------- remotes

function parseRemote(url) {
  const text = String(url || '').trim();
  if (!text) return null;
  let host;
  let p;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let u;
    try { u = new URL(text); } catch { return null; }
    if (u.protocol === 'file:') return null;
    host = u.hostname.toLowerCase();
    p = decodeURIComponent(u.pathname);
  } else {
    const m = text.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/);
    if (!m) return null;
    host = m[1].toLowerCase();
    p = m[2];
  }
  const parts = p.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const provider = host === 'bitbucket.org' ? 'bitbucket' : host === 'github.com' || /(^|\.)github\./.test(host) ? 'github' : null;
  return { provider, host, owner: parts[parts.length - 2], slug: parts[parts.length - 1] };
}

// ---------------------------------------------------------------- git

function git(cwd, args, opts = {}) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) },
    input: opts.input,
    timeout: opts.timeout || 120000,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (opts.allowFailure) return res;
  if (res.error || res.status !== 0) throw new Error(`git ${args[0]} failed: ${redact(String(res.error?.message || res.stderr || res.stdout || '').trim()).slice(0, 400)}`);
  return String(res.stdout || '').trim();
}
function gitOk(cwd, args, opts = {}) { const r = git(cwd, args, { ...opts, allowFailure: true }); return !r.error && r.status === 0; }
function head(cwd) { return git(cwd, ['rev-parse', 'HEAD']); }
function remoteUrl(cwd, remote) {
  // The configured URL, not `git remote get-url`, which applies insteadOf.
  const r = git(cwd, ['config', '--get', `remote.${remote}.url`], { allowFailure: true });
  return r.status === 0 ? String(r.stdout).trim() : null;
}
function remoteBranchSha(cwd, remote, branch) {
  const r = git(cwd, ['ls-remote', remote, `refs/heads/${branch}`], { allowFailure: true, timeout: 60000 });
  if (r.error || r.status !== 0) throw new Blocked(`cannot reach remote "${remote}": ${redact(String(r.error?.message || r.stderr || '').trim()).slice(0, 300) || `exit ${r.status}`}`);
  // ls-remote matches patterns by suffix; only the exact ref counts.
  const line = String(r.stdout || '').split('\n').map(l => l.trim().split(/\s+/)).find(([, ref]) => ref === `refs/heads/${branch}`);
  return line ? line[0] : null;
}

// ---------------------------------------------------------------- staged diff checks

// Rule 5 of ai/guard.yaml (leak_patterns), the guard's credential-file globs and
// any task pack's declared secret values, loaded through the guard engine so
// the patterns exist in exactly one place.
//
// The runtime's own credentials (SECRET_ENV) count as secret values too: a
// Bitbucket app password matches none of the Rule 5 patterns, and an agent can
// read its environment. Without this, its value in the description or a
// committed file would be posted or pushed (redact() only covers logs).
function leakPolicy(runtimeRoot, env = process.env) {
  const { loadPolicy, loadPacks } = require(path.join(runtimeRoot, 'ai', 'guard', 'engine.js'));
  const policy = loadPolicy(runtimeRoot);
  const packs = loadPacks(runtimeRoot);
  let values = SECRET_ENV.map(name => env[name]).filter(v => typeof v === 'string');
  for (const p of packs) { if (p.secrets) { try { values = values.concat(p.secrets() || []); } catch { /* a pack without secrets */ } } }
  return {
    leakPatterns: policy.leakPatterns,
    secretFiles: [...policy.secretFiles, ...packs.flatMap(p => p.secretFiles)],
    secretValues: values.filter(s => typeof s === 'string' && s.length >= 6),
  };
}

// Hits in the text, as labels only: what matched is never returned.
function textLeaks(text, policy) {
  const hits = [];
  for (const [re, label] of policy.leakPatterns) if (re.test(text)) hits.push(label);
  if (policy.secretValues.some(v => text.includes(v))) hits.push('project secret value');
  return hits;
}

// Every added line of a unified diff, with its file and new line number.
// `--- `/`+++ ` are file headers only in a file's header section (after
// `diff --git`, before its first `@@`): inside a hunk, an added line whose text
// starts with "++ " is content. Reading it as a header let that line escape the
// scan and turned its text into the "file name" of later hits.
function addedLines(diff) {
  const out = [];
  let file = null;
  let line = 0;
  let header = true;
  for (const raw of String(diff).split('\n')) {
    if (raw.startsWith('diff --git ')) { header = true; file = null; continue; }
    if (header) {
      if (raw.startsWith('+++ ')) {
        const target = raw.slice(4).replace(/^"(.*)"$/, '$1');
        file = target === '/dev/null' ? null : target.replace(/^b\//, '');
        continue;
      }
      if (!raw.startsWith('@@')) continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { header = false; line = Number(hunk[1]); continue; }
    if (raw.startsWith('+') && file) { out.push({ file, line, text: raw.slice(1) }); line++; }
    else if (raw.startsWith(' ')) line++;
  }
  return out;
}

function scanDiff(diff, policy) {
  const problems = [];
  for (const added of addedLines(diff)) {
    for (const label of textLeaks(added.text, policy)) problems.push({ file: added.file, line: added.line, label });
  }
  return problems;
}
function conflictMarkers(diff) {
  return addedLines(diff).filter(a => /^(?:<{7}|>{7})(?: |$)/.test(a.text)).map(a => `${a.file}:${a.line}`);
}

const DIFF_FLAGS = ['-U0', '--no-color', '--no-ext-diff', '--no-renames', '--no-textconv'];
function stagedDiff(cwd, env) { return git(cwd, ['diff', '--cached', ...DIFF_FLAGS], { env }); }
function nameList(cwd, args, env) { return git(cwd, [...args, '--name-only', '-z', '--diff-filter=ACMR', '--no-renames'], { env }).split('\0').filter(Boolean); }
function stagedFiles(cwd, env) { return nameList(cwd, ['diff', '--cached'], env); }

// The problems in one diff. Only a path git listed by name is ever printed: a
// file name parsed out of diff text is a fallback label, never a reason.
function diffProblems(diff, files, policy, prefix = '') {
  const listed = new Set(files);
  const where = hit => `${prefix}${listed.has(hit.file) ? hit.file : 'a changed file'}:${hit.line}`;
  const problems = [];
  for (const file of files) if (policy.secretFiles.some(re => re.test(file))) problems.push(`${prefix}${file}: is a credential file and is never committed`);
  const markers = addedLines(diff).filter(a => /^(?:<{7}|>{7})(?: |$)/.test(a.text)).map(where);
  if (markers.length) problems.push(`conflict markers at ${markers.slice(0, 10).join(', ')}`);
  for (const hit of scanDiff(diff, policy)) problems.push(`${where(hit)}: contains what looks like a ${hit.label}`);
  return problems;
}

// Refuses the staged index in `cwd` (or the index named by env.GIT_INDEX_FILE).
function stagedProblems(cwd, policy, env) {
  const files = stagedFiles(cwd, env);
  return { problems: diffProblems(stagedDiff(cwd, env), files, policy), files };
}

// What a push would publish: every commit reachable from HEAD that is on
// neither the base branch nor the remote branch already. Commits made by hand,
// by a hook, or on a pre-created branch are scanned as well as the runtime's
// own, and so is each commit's message (credentials, attribution trailers). A
// secret added in one commit and removed in a later one is still caught,
// because each commit is diffed against its first parent.
const MAX_SCANNED_COMMITS = 1000;
// Attribution in a commit message. Narrower than attributionProblems(), which
// is for text an agent wrote: a human's commit may name a tool it is about
// ("Upgrade the OpenAI client") or credit a human co-author. What is refused is
// an AI tool credited as author: a Co-Authored-By trailer naming one, a
// "Generated with" line, the robot emoji.
const COMMIT_ATTRIBUTION = [
  [/^\s*co-authored-by\s*:[^\n]*(?:\b(?:claude|codex|anthropic|openai|chatgpt|copilot|gemini|cursor)\b|noreply@anthropic\.com)/im, 'a Co-Authored-By trailer crediting an AI tool'],
  [/\b(?:generated|created|written|made)\s+(?:with|by|using)\s+\[?\s*(?:claude|codex|chatgpt|copilot|an?\s+ai\b|ai\b|an?\s+llm\b|llm\b)/i, 'a "Generated with" attribution'],
  [/\u{1F916}/u, 'a robot-emoji attribution'],
];
function commitAttributionProblems(message) { return COMMIT_ATTRIBUTION.filter(([re]) => re.test(String(message || ''))).map(([, label]) => label); }
function commitsToPublish(cwd, exclude) {
  const out = git(cwd, ['rev-list', '--reverse', 'HEAD', '--not', ...exclude.filter(Boolean)]);
  return out ? out.split('\n').filter(Boolean) : [];
}
function publishProblems(cwd, commits, policy) {
  if (commits.length > MAX_SCANNED_COMMITS) return [`${commits.length} commits would be pushed, more than the ${MAX_SCANNED_COMMITS} the runtime scans; the base is probably wrong — pass it: --base <branch>`];
  const problems = [];
  let emptyTree = null;
  for (const sha of commits) {
    const short = sha.slice(0, 12);
    const message = git(cwd, ['log', '-1', '--format=%B', sha]);
    const leaks = textLeaks(message, policy);
    if (leaks.length) problems.push(`commit ${short}: its message contains what looks like a ${leaks.join(', ')}`);
    const attribution = commitAttributionProblems(message);
    if (attribution.length) problems.push(`commit ${short}: its message contains ${attribution.join(', ')}`);
    const parentRes = git(cwd, ['rev-parse', '-q', '--verify', `${sha}^1`], { allowFailure: true });
    let parent = parentRes.status === 0 ? String(parentRes.stdout).trim() : null;
    if (!parent) parent = emptyTree ||= git(cwd, ['hash-object', '-t', 'tree', '--stdin'], { input: '' });
    const files = nameList(cwd, ['diff', parent, sha]);
    problems.push(...diffProblems(git(cwd, ['diff', ...DIFF_FLAGS, parent, sha]), files, policy, `commit ${short} `));
  }
  return problems;
}

// ---------------------------------------------------------------- provider layer

// The two calls that leave the machine. Selftests replace them (see layer()).
function ghSpawn(args, opts = {}) {
  return spawnSync('gh', args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
    timeout: 90000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
// One HTTPS request through a child process, so the synchronous engine can wait
// for it. The request carries no credentials: the child adds them from its own
// environment.
function httpSync(request) {
  const res = spawnSync(process.execPath, [__filename, '--http'], {
    input: JSON.stringify({ method: request.method, url: request.url, body: request.body ?? null }),
    encoding: 'utf8',
    env: process.env,
    timeout: 60000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) return { error: res.error.message };
  try { return JSON.parse(res.stdout || '{}'); } catch { return { error: `HTTP helper exited ${res.status}` }; }
}
function layer(env = process.env) {
  if (env.AI_WORKFLOW_SELFTEST === '1' && env.AI_WORKFLOW_TEST_PR_LAYER) return require(path.resolve(env.AI_WORKFLOW_TEST_PR_LAYER));
  return { gh: ghSpawn, http: httpSync };
}

function bitbucketCredentials(env = process.env) {
  if (env.BITBUCKET_EMAIL && env.BITBUCKET_API_TOKEN) return { user: env.BITBUCKET_EMAIL, secret: env.BITBUCKET_API_TOKEN, kind: 'api-token' };
  if (env.BITBUCKET_USERNAME && env.BITBUCKET_APP_PASSWORD) return { user: env.BITBUCKET_USERNAME, secret: env.BITBUCKET_APP_PASSWORD, kind: 'app-password' };
  return null;
}
function authorizationHeader(env = process.env) {
  const c = bitbucketCredentials(env);
  return c ? `Basic ${Buffer.from(`${c.user}:${c.secret}`).toString('base64')}` : null;
}

function githubProvider(remote, deps, cwd) {
  const repo = remote ? (remote.host === 'github.com' ? `${remote.owner}/${remote.slug}` : `${remote.host}/${remote.owner}/${remote.slug}`) : null;
  const repoArgs = repo ? ['--repo', repo] : [];
  const gh = args => deps.gh(args, { cwd });
  const failure = (what, r) => new Blocked(`gh ${what} failed: ${redact(String(r.error?.message || r.stderr || r.stdout || '').trim()).slice(0, 300) || `exit ${r.status}`}`);
  return {
    name: 'github',
    target: repo || 'the repository of the run worktree',
    credentialProblem() {
      const r = gh(['auth', 'status', ...(remote ? ['--hostname', remote.host] : [])]);
      if (r.error && (r.error.code === 'ENOENT' || /ENOENT/.test(r.error.message || ''))) return 'GitHub CLI "gh" is not installed or not on PATH — install it, then run: gh auth login (or export GH_TOKEN)';
      if (r.error || r.status !== 0) return `gh is not authenticated${remote ? ` for ${remote.host}` : ''} — run: gh auth login (or export GH_TOKEN)`;
      return null;
    },
    credentialsPresent() {
      const r = gh(['--version']);
      return r.error ? 'gh is not on PATH' : 'gh is installed (authentication is checked when the PR opens)';
    },
    findOpen({ branch }) {
      const r = gh(['pr', 'list', ...repoArgs, '--head', branch, '--state', 'open', '--json', 'number,url,baseRefName,isDraft', '--limit', '10']);
      if (r.error || r.status !== 0) throw failure('pr list', r);
      let list = [];
      try { list = JSON.parse(r.stdout || '[]'); } catch { throw new Blocked('gh pr list returned output that is not JSON'); }
      const pr = Array.isArray(list) ? list[0] : null;
      return pr ? { number: pr.number, url: pr.url, base: pr.baseRefName || null, draft: !!pr.isDraft } : null;
    },
    create({ title, bodyFile, base, branch, draft }) {
      const r = gh(['pr', 'create', ...repoArgs, '--base', base, '--head', branch, '--title', title, '--body-file', bodyFile, ...(draft ? ['--draft'] : [])]);
      if (r.error || r.status !== 0) throw failure('pr create', r);
      const url = String(r.stdout || '').split('\n').map(x => x.trim()).filter(x => /^https?:\/\//.test(x)).pop();
      if (!url) throw new Blocked('gh pr create printed no pull request URL');
      const m = url.match(/\/pull\/(\d+)/);
      return { number: m ? Number(m[1]) : null, url };
    },
  };
}

function bitbucketProvider(remote, deps, env) {
  if (!remote || !remote.owner || !remote.slug) throw new Blocked('cannot read the Bitbucket workspace and repository from the remote URL (expected git@bitbucket.org:<workspace>/<repo>.git or https://bitbucket.org/<workspace>/<repo>)');
  const base = `https://${BITBUCKET_API}/2.0/repositories/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.slug)}/pullrequests`;
  const call = (method, url, body) => {
    const r = deps.http({ method, url, body: body === undefined ? null : JSON.stringify(body) });
    if (r.error) throw new Blocked(`Bitbucket API request failed: ${redact(r.error).slice(0, 300)}`);
    let data = null;
    try { data = r.body ? JSON.parse(r.body) : null; } catch { data = null; }
    if (r.status === 401 || r.status === 403) throw new Blocked(`Bitbucket rejected the credentials (HTTP ${r.status}) — check ${BITBUCKET_ENV} and that the token can write pull requests`);
    if (r.status < 200 || r.status >= 300) throw new Blocked(`Bitbucket API HTTP ${r.status}: ${redact(data?.error?.message || String(r.body || '')).slice(0, 300)}`);
    return data || {};
  };
  const shape = pr => ({ number: pr.id, url: pr.links?.html?.href || null, base: pr.destination?.branch?.name || null, draft: !!pr.draft });
  return {
    name: 'bitbucket',
    target: `${remote.owner}/${remote.slug}`,
    credentialProblem() { return bitbucketCredentials(env) ? null : `Bitbucket credentials are not set — export ${BITBUCKET_ENV}`; },
    credentialsPresent() { const c = bitbucketCredentials(env); return c ? `Bitbucket ${c.kind} credentials are set` : `missing ${BITBUCKET_ENV}`; },
    findOpen({ branch }) {
      const q = encodeURIComponent(`source.branch.name="${branch}" AND state="OPEN"`);
      const data = call('GET', `${base}?state=OPEN&q=${q}`);
      const pr = (data.values || []).find(x => x?.source?.branch?.name === branch) || null;
      return pr ? shape(pr) : null;
    },
    create({ title, body, base: target, branch, draft }) {
      const payload = { title, description: body, source: { branch: { name: branch } }, destination: { branch: { name: target } }, close_source_branch: false, ...(draft ? { draft: true } : {}) };
      return shape(call('POST', base, payload));
    },
  };
}

function providerFor(kind, remote, deps, cwd, env) {
  if (kind === 'github') return githubProvider(remote, deps, cwd);
  if (kind === 'bitbucket') return bitbucketProvider(remote, deps, env);
  throw new Blocked(`unsupported provider ${kind}`);
}

// ---------------------------------------------------------------- the stage

function haveCommit(cwd, sha) { return !!sha && gitOk(cwd, ['cat-file', '-e', `${sha}^{commit}`]); }
function fetchBranch(cwd, remote, branch) { git(cwd, ['fetch', '-q', '--no-tags', remote, `refs/heads/${branch}`], { allowFailure: true, timeout: 120000 }); }
// The commit a branch was created at, from its reflog, or null when the reflog
// does not reach back to the creation (expired, or disabled).
function branchCreation(cwd, branch) {
  const r = git(cwd, ['reflog', 'show', '--format=%H%x09%gs', `refs/heads/${branch}`], { allowFailure: true });
  if (r.status !== 0) return null;
  const last = String(r.stdout || '').trim().split('\n').pop() || '';
  const [sha, subject] = last.split('\t');
  return /^branch: Created from /.test(subject || '') ? sha : null;
}

// The worktree's checked-out branch and, when it tracks a branch on `remote`,
// that branch's name there. Read from branch.<name>.remote and .merge, which are
// exact, where `@{u}` would have to be split at an ambiguous slash.
function trackedBranch(worktree, remote) {
  const r = git(worktree, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFailure: true });
  const local = r.status === 0 ? String(r.stdout).trim() : '';
  if (!local) return { local: null, upstream: null };
  const cfg = key => { const x = git(worktree, ['config', '--get', `branch.${local}.${key}`], { allowFailure: true }); return x.status === 0 ? String(x.stdout).trim() : ''; };
  const merge = cfg('merge');
  const upstream = cfg('remote') === remote && merge.startsWith('refs/heads/') ? merge.slice('refs/heads/'.length) : null;
  return { local, upstream: upstream && validRef(upstream) ? upstream : null };
}

function resolveTarget(ctx) {
  const { id, worktree, options, meta } = ctx;
  const raw = remoteUrl(worktree, options.remote);
  if (!raw) throw new Blocked(`git remote "${options.remote}" is not configured in the run worktree`);
  const remote = parseRemote(raw);
  const kind = options.provider === 'auto' ? remote?.provider : options.provider;
  if (!kind) throw new Blocked(`cannot tell the provider from remote "${options.remote}" (${redact(raw)}) — set pull_request.provider to github or bitbucket in .agentic/config.yaml`);
  let base = options.base && options.base !== 'auto' ? options.base : (meta?.baseBranch || null);
  let baseSource = options.base && options.base !== 'auto' ? 'requested' : 'worktree';
  if (!base) {
    const r = git(worktree, ['symbolic-ref', '--short', '-q', `refs/remotes/${options.remote}/HEAD`], { allowFailure: true });
    const sym = r.status === 0 ? String(r.stdout).trim() : '';
    if (sym.startsWith(`${options.remote}/`)) { base = sym.slice(options.remote.length + 1); baseSource = `${options.remote}/HEAD`; }
  }
  if (!base) throw new Blocked(`cannot tell which branch this run is based on (its worktree recorded none and ${options.remote}/HEAD is not known) — pass it: agentic pr ${id} --base <branch>`);
  if (!validRef(base)) throw new Blocked(`"${base}" is not a valid base branch name`);
  // The branch to push and open the PR from. A configured or requested one
  // wins. Otherwise the branch the worktree already tracks on the remote: a PR
  // may already be open from it, and pushing to "ai/<id>" instead opened a
  // second one. Otherwise the template.
  const tracked = trackedBranch(worktree, options.remote);
  let branch;
  let branchSource;
  if (!options.branchExplicit && tracked.upstream && tracked.upstream !== base) { branch = tracked.upstream; branchSource = `the branch ${tracked.local} tracks`; }
  else { branch = branchFor(options.branch, id); branchSource = options.branchExplicit ? 'requested' : 'template'; }
  if (!validRef(branch) || !gitOk(worktree, ['check-ref-format', '--branch', branch])) throw new Blocked(`"${branch}" is not a valid branch name`);
  if (base === branch) throw new Blocked(`the pull request branch and its base are both "${base}" — choose another branch with: agentic pr ${id} --branch <name>`);
  return { raw, display: redact(raw), remote, kind, branch, branchSource, base, baseSource, localBranch: tracked.local };
}

// A base taken from <remote>/HEAD (the worktree recorded none: it predates
// base recording, or its branch existed before the run) is a guess. A wrong
// guess opens a PR that carries another branch's commits, with no human in the
// loop when the stage is enabled. So it is used only when the run demonstrably
// starts on it: the run's start commit is on the base, and the run branch was
// created at that commit. Then the PR holds exactly the run's own commits.
// Returns the reason it cannot be trusted, or null.
function fallbackBaseProblem(ctx, target, baseTip, { fetch = true } = {}) {
  if (target.baseSource === 'requested' || target.baseSource === 'worktree') return null;
  const { id, worktree, options, meta } = ctx;
  const pass = `pass the base explicitly: agentic pr ${id} --base <branch>`;
  const name = `${options.remote}/${target.base}`;
  const guess = `${name} is only a guess from ${target.baseSource}, because the worktree recorded no base branch`;
  if (!haveCommit(worktree, baseTip) && fetch) fetchBranch(worktree, options.remote, target.base);
  if (!haveCommit(worktree, baseTip)) return fetch ? `cannot fetch ${name} to check that this run is based on it — ${pass}` : null;
  if (!meta?.baseSha || !haveCommit(worktree, meta.baseSha)) return `${guess}, and the run's start commit is unknown, so it cannot be checked — ${pass}`;
  if (!gitOk(worktree, ['merge-base', '--is-ancestor', meta.baseSha, baseTip])) return `${guess}, and this run started at ${meta.baseSha.slice(0, 12)}, which is not on it: a pull request against it would carry another branch's commits — ${pass}`;
  if (meta.branchPreexisted === undefined) {
    // Metadata from before 1.9.31 does not say whether the run branch existed
    // before its worktree; baseSha was the main checkout's HEAD either way. The
    // branch's reflog says where it was really created.
    const created = meta.branch ? branchCreation(worktree, meta.branch) : null;
    if (created !== meta.baseSha) return `${guess}, and ${meta.branch || 'the run branch'} was not created at the run's start commit ${meta.baseSha.slice(0, 12)} (${created ? `it was created at ${created.slice(0, 12)}` : 'its reflog does not show where it was created'}), so the base may be another branch — ${pass}`;
  }
  return null;
}

// An open PR from the branch the worktree is on, when that branch was pushed
// by hand without tracking. It is the run's PR too, so it is reused.
function worktreeBranchPr(ctx, target, provider) {
  const local = target.localBranch;
  if (target.branchSource !== 'template' || !local || local === target.branch || local === target.base || !validRef(local)) return null;
  if (!remoteBranchSha(ctx.worktree, ctx.options.remote, local)) return null;
  return provider.findOpen({ branch: local, base: target.base });
}

// The checks that need no description and change nothing: remote, provider,
// branch names, credentials and the base branch on the remote. The engine runs
// them before paying for the pr-description agent.
function preflight(ctx) {
  const env = ctx.env || process.env;
  try {
    const target = resolveTarget(ctx);
    const provider = providerFor(target.kind, target.remote, ctx.deps || layer(env), ctx.worktree, env);
    const credentials = provider.credentialProblem();
    if (credentials) throw new Blocked(credentials);
    const baseTip = remoteBranchSha(ctx.worktree, ctx.options.remote, target.base);
    if (!baseTip) throw new Blocked(`base branch "${target.base}" does not exist on remote "${ctx.options.remote}" — push it first, or pass another: agentic pr ${ctx.id} --base <branch>`);
    const misfit = fallbackBaseProblem(ctx, target, baseTip);
    if (misfit) throw new Blocked(misfit);
    return { ok: true, target };
  } catch (e) {
    return { ok: false, reason: redact(e instanceof Blocked ? e.message : `pull request preflight failed: ${e.message}`, env) };
  }
}

// `git add -A` hashes every new or changed file into the object store and runs
// any clean filter (git-lfs copies content into .git/lfs). A dry run stages into
// a throwaway index AND a throwaway object directory (the real one is an
// alternate, read-only), with every configured filter driver switched off, so
// it leaves nothing behind in the product repository.
function scratchStaging(worktree, temp) {
  const index = path.join(temp, 'index');
  const real = path.resolve(worktree, git(worktree, ['rev-parse', '--git-path', 'index']));
  if (fs.existsSync(real)) fs.copyFileSync(real, index);
  const objects = path.join(temp, 'objects');
  fs.mkdirSync(objects, { recursive: true });
  const realObjects = path.resolve(worktree, git(worktree, ['rev-parse', '--git-path', 'objects']));
  const drivers = new Set();
  const r = git(worktree, ['config', '--name-only', '--get-regexp', '^filter\\..+\\.(clean|smudge|process|required)$'], { allowFailure: true });
  for (const key of String(r.stdout || '').split('\n').map(x => x.trim()).filter(Boolean)) { const m = key.match(/^filter\.(.+)\.[a-z]+$/i); if (m) drivers.add(m[1]); }
  const config = [...drivers].flatMap(d => ['-c', `filter.${d}.clean=`, '-c', `filter.${d}.process=`, '-c', `filter.${d}.required=false`]);
  return { env: { GIT_INDEX_FILE: index, GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: realObjects }, config };
}

// What `agentic pr <id> --dry-run` prints. Reads only: the leak scan stages
// into a throwaway index and object directory, nothing is fetched, committed or
// pushed, and no provider API is called.
function plan(ctx) {
  const { id, worktree, options, description } = ctx;
  const deps = ctx.deps || layer(ctx.env);
  const env = ctx.env || process.env;
  const lines = [`${id}: dry run — nothing is committed, pushed or sent to a provider`];
  let target;
  let provider;
  try { target = resolveTarget(ctx); provider = providerFor(target.kind, target.remote, deps, worktree, env); }
  catch (e) { lines.push(`  ✗ ${redact(e.message, env)}`); return { ok: false, lines }; }
  const branchWhy = target.branchSource === 'template' ? `from the template "${options.branch}"` : target.branchSource === 'requested' ? 'requested' : target.branchSource;
  lines.push(`  provider:   ${target.kind} (${provider.target})`, `  remote:     ${options.remote} ${target.display}`, `  base:       ${target.base} (${target.baseSource})`, `  branch:     ${target.branch}${options.draft ? ' (draft)' : ''} — ${branchWhy}`);
  lines.push(`  credentials: ${provider.credentialsPresent()}`);
  lines.push(`  description: ${description ? `"${description.title}"` : 'not written yet — the pr-description role writes 12-pull-request.md first'}`);
  let ok = true;
  const policy = leakPolicy(ctx.runtimeRoot, env);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-pr-index-'));
  try {
    const scratch = scratchStaging(worktree, temp);
    git(worktree, [...scratch.config, 'add', '-A'], { env: scratch.env });
    const staged = stagedProblems(worktree, policy, scratch.env);
    lines.push(`  would commit: ${staged.files.length ? `${staged.files.length} file(s)` : 'nothing new'}`);
    for (const f of staged.files.slice(0, 20)) lines.push(`      ${f}`);
    if (staged.files.length > 20) lines.push(`      … ${staged.files.length - 20} more`);
    for (const p of staged.problems) { lines.push(`  ✗ ${p}`); ok = false; }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  const ahead = ctx.meta?.baseSha && haveCommit(worktree, ctx.meta.baseSha) ? Number(git(worktree, ['rev-list', '--count', `${ctx.meta.baseSha}..HEAD`])) : null;
  if (ahead !== null) lines.push(`  commits already ahead of the run base: ${ahead}`);
  try {
    const remoteSha = remoteBranchSha(worktree, options.remote, target.branch);
    lines.push(`  remote branch: ${remoteSha ? `exists at ${remoteSha.slice(0, 12)} (pushed only when HEAD descends from it; never forced)` : 'not on the remote yet'}`);
    const baseTip = remoteBranchSha(worktree, options.remote, target.base);
    if (!baseTip) { lines.push(`  ✗ base branch "${target.base}" does not exist on remote "${options.remote}"`); ok = false; }
    else {
      const misfit = fallbackBaseProblem(ctx, target, baseTip, { fetch: false });
      if (misfit) { lines.push(`  ✗ ${misfit}`); ok = false; }
      // Commits already on the branch are published by the push too; they are
      // scanned when their objects are here (a dry run never fetches).
      if (haveCommit(worktree, baseTip) && (!remoteSha || haveCommit(worktree, remoteSha))) {
        const commits = commitsToPublish(worktree, [baseTip, remoteSha]);
        const problems = publishProblems(worktree, commits, policy);
        lines.push(`  existing commits the push would publish: ${commits.length}${commits.length ? ' (scanned)' : ''}`);
        for (const p of problems) { lines.push(`  ✗ ${p}`); ok = false; }
      } else {
        lines.push(`  ! existing commits on the branch were not scanned: fetch ${options.remote}/${target.base} to include them (the real run fetches and scans them before pushing)`);
        if (!['requested', 'worktree'].includes(target.baseSource)) lines.push(`  ! the base is a guess from ${target.baseSource} and was not checked against this run without fetching; the real run checks it and asks for --base if it does not fit`);
      }
    }
    if (target.branchSource === 'template' && target.localBranch && target.localBranch !== target.branch && remoteBranchSha(worktree, options.remote, target.localBranch)) lines.push(`  before opening one: an open PR from ${target.localBranch} (on the remote) is reused`);
  } catch (e) { lines.push(`  ✗ ${redact(e.message, env)}`); ok = false; }
  lines.push('  would run:', '      git add -A', `      git commit -F - (message "${id}: ${description ? description.title : '<title>'}"; hooks run)`, `      git push -u ${options.remote} HEAD:refs/heads/${target.branch}`,
    `      ${target.kind === 'github' ? `gh pr list / gh pr create --base ${target.base} --head ${target.branch}${options.draft ? ' --draft' : ''}` : `GET + POST https://${BITBUCKET_API}/2.0/repositories/${provider.target}/pullrequests`}`);
  return { ok, lines };
}

// The real thing. Returns {status:'pass', pullRequest} or {status:'blocked',
// reason}. Every step can be repeated: a resume after any partial failure
// commits only what is not committed yet, pushes only what is not pushed yet,
// and reuses an open pull request for the branch instead of opening another.
function deliver(ctx) {
  const { id, worktree, options, description, meta } = ctx;
  const deps = ctx.deps || layer(ctx.env);
  const env = ctx.env || process.env;
  const record = ctx.record || (() => {});
  const log = ctx.log || (() => {});
  try {
    if (!description || !description.title || !description.body) throw new Blocked('the pull request description (12-pull-request.json) is missing');
    const policy = leakPolicy(ctx.runtimeRoot, env);
    const target = resolveTarget(ctx);
    const descriptionLeaks = textLeaks(`${description.title}\n${description.summary || ''}\n${description.body}`, policy);
    if (descriptionLeaks.length) throw new Blocked(`the pull request description contains what looks like a ${descriptionLeaks.join(', ')}`);
    const attribution = attributionProblems(`${description.title}\n${description.summary || ''}\n${description.body}`);
    if (attribution.length) throw new Blocked(`the pull request description contains ${attribution.join(', ')}`);
    const provider = providerFor(target.kind, target.remote, deps, worktree, env);
    const credentials = provider.credentialProblem();
    if (credentials) throw new Blocked(credentials);
    const baseTip = remoteBranchSha(worktree, options.remote, target.base);
    if (!baseTip) throw new Blocked(`base branch "${target.base}" does not exist on remote "${options.remote}" — push it first, or pass another: agentic pr ${id} --base <branch>`);
    const misfit = fallbackBaseProblem(ctx, target, baseTip);
    if (misfit) throw new Blocked(misfit);

    // An open PR is looked for first, before anything changes, so a mismatch
    // with what was asked for stops the stage before a commit or a push.
    let existing = worktreeBranchPr(ctx, target, provider);
    if (existing) { target.branchSource = `open PR #${existing.number} from ${target.localBranch}`; target.branch = target.localBranch; }
    else existing = provider.findOpen({ branch: target.branch, base: target.base });
    const warnings = [];
    if (existing) {
      if (existing.base && existing.base !== target.base) {
        if (target.baseSource === 'requested') throw new Blocked(`pull request #${existing.number} from ${target.branch} is open against ${existing.base}, but ${target.base} was requested — retarget it to ${target.base} (or close it) and run again, or ask for ${existing.base}: agentic pr ${id} --base ${existing.base}`);
        warnings.push(`PR #${existing.number} targets ${existing.base}, not ${target.base} (${target.baseSource}); it is left as it is`);
      }
      if (options.draftExplicit && !!existing.draft !== !!options.draft) warnings.push(`PR #${existing.number} is ${existing.draft ? 'a draft' : 'not a draft'}; ${options.draft ? 'draft' : 'ready for review'} was asked for but is not applied to an open PR`);
    }
    const base = { provider: target.kind, branch: target.branch, branchSource: target.branchSource, base: target.base, requestedBase: target.baseSource === 'requested' ? target.base : null, remote: options.remote, draft: !!options.draft };

    // Commit.
    const unmerged = git(worktree, ['ls-files', '-u']);
    if (unmerged) throw new Blocked(`the run worktree has unmerged paths: ${[...new Set(unmerged.split('\n').map(l => l.split('\t')[1]).filter(Boolean))].slice(0, 10).join(', ')}`);
    const before = head(worktree);
    git(worktree, ['add', '-A']);
    const staged = stagedProblems(worktree, policy);
    if (staged.problems.length) {
      git(worktree, ['reset', '-q'], { allowFailure: true });
      throw new Blocked(`refusing to commit: ${staged.problems.slice(0, 8).join('; ')}`);
    }
    let committed = false;
    if (!gitOk(worktree, ['diff', '--cached', '--quiet'])) {
      const message = `${id}: ${description.title}\n\n${String(description.summary || '').trim()}\n`;
      const r = git(worktree, ['commit', '-q', '-F', '-'], { input: message, allowFailure: true });
      if (r.error || r.status !== 0) {
        const why = String(r.stderr || r.stdout || r.error?.message || '');
        git(worktree, ['reset', '-q'], { allowFailure: true });
        if (/tell me who you are|empty ident|unable to auto-detect email/i.test(why)) throw new Blocked('git has no user identity for the run worktree — set user.name and user.email in that repository (the runtime never sets them), then resume');
        throw new Blocked(`git commit failed (a hook may have refused it): ${redact(why.trim()).slice(0, 400)}`);
      }
      committed = true;
      const sha = head(worktree);
      record({ ...base, status: 'committed', commit: sha, preCommitSha: before }, { action: 'commit', commit: sha });
      log(`${id}: committed ${staged.files.length} file(s) as ${sha.slice(0, 12)}`);
    }
    const sha = head(worktree);
    const ahead = meta?.baseSha && haveCommit(worktree, meta.baseSha) ? Number(git(worktree, ['rev-list', '--count', `${meta.baseSha}..HEAD`])) : null;
    if (!committed && ahead === 0 && !existing) throw new Blocked('nothing to commit and no commits ahead of the run base — there is nothing to open a pull request for');

    // Push, never forced, and only what passed the scan.
    const remoteSha = remoteBranchSha(worktree, options.remote, target.branch);
    let contained = false;
    if (remoteSha !== sha) {
      if (remoteSha && !haveCommit(worktree, remoteSha)) fetchBranch(worktree, options.remote, target.branch);
      if (remoteSha && !haveCommit(worktree, remoteSha)) throw new Blocked(`cannot fetch ${options.remote}/${target.branch} (${remoteSha.slice(0, 12)}) to compare it with this run`);
      if (remoteSha && gitOk(worktree, ['merge-base', '--is-ancestor', sha, remoteSha])) {
        // Someone pushed on top of the run's work (a review fix, say): HEAD is
        // already published, and the open PR, if any, is reused.
        contained = true;
        log(`${id}: ${options.remote}/${target.branch} (${remoteSha.slice(0, 12)}) already contains ${sha.slice(0, 12)}; nothing to push`);
      } else {
        if (remoteSha && !gitOk(worktree, ['merge-base', '--is-ancestor', remoteSha, sha])) {
          throw new Blocked(`remote branch "${target.branch}" has commits this run does not have, and this run has commits it does not have (${remoteSha.slice(0, 12)} and ${sha.slice(0, 12)} have diverged); it is never force-pushed — choose another branch with: agentic pr ${id} --branch <name>, or reconcile it by hand`);
        }
        if (!haveCommit(worktree, baseTip)) fetchBranch(worktree, options.remote, target.base);
        if (!haveCommit(worktree, baseTip)) throw new Blocked(`cannot fetch ${options.remote}/${target.base} to tell which commits the push would publish`);
        const problems = publishProblems(worktree, commitsToPublish(worktree, [baseTip, remoteSha]), policy);
        if (problems.length) throw new Blocked(`refusing to push: ${problems.slice(0, 8).join('; ')}${problems.length > 8 ? ` (and ${problems.length - 8} more)` : ''} — the runtime never rewrites history; fix those commits by hand, then resume`);
        const r = git(worktree, ['push', '-u', options.remote, `HEAD:refs/heads/${target.branch}`], { allowFailure: true, timeout: 300000 });
        if (r.error || r.status !== 0) throw new Blocked(`git push failed (a hook or the remote refused it): ${redact(String(r.stderr || r.error?.message || '').trim()).slice(0, 400)}`);
        record({ ...base, status: 'pushed', commit: sha }, { action: 'push', commit: sha });
        log(`${id}: pushed ${sha.slice(0, 12)} to ${options.remote}/${target.branch}`);
      }
    }

    // Open, or reuse the one already open.
    let pr = existing;
    if (!pr) {
      const bodyFile = ctx.bodyFile || path.join(os.tmpdir(), `agentic-pr-${process.pid}-${Date.now()}.md`);
      fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
      fs.writeFileSync(bodyFile, description.body.endsWith('\n') ? description.body : `${description.body}\n`);
      try { pr = provider.create({ title: description.title, body: description.body, bodyFile, base: target.base, branch: target.branch, draft: !!options.draft }); }
      finally { if (!ctx.bodyFile) { try { fs.unlinkSync(bodyFile); } catch { /* gone */ } } }
    }
    const reused = !!existing;
    if (!pr || !pr.url) throw new Blocked('the provider returned no pull request URL');
    const pullRequest = { ...base, base: pr.base || target.base, draft: pr.draft ?? !!options.draft, status: 'open', number: pr.number ?? null, url: redact(pr.url), commit: sha, reused, ...(contained ? { remoteCommit: remoteSha } : {}), ...(warnings.length ? { warnings } : {}) };
    for (const w of warnings) log(`${id}: ! ${w}`);
    record(pullRequest, { action: reused ? 'reuse' : 'open', number: pullRequest.number, url: pullRequest.url, commit: sha, ...(warnings.length ? { warnings } : {}) });
    return { status: 'pass', pullRequest };
  } catch (e) {
    return { status: 'blocked', reason: redact(e instanceof Blocked ? e.message : `pull request failed: ${e.message}`, env) };
  }
}

// ---------------------------------------------------------------- --http child

function httpChild() {
  const https = require('https');
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { input += c; });
  process.stdin.on('end', () => {
    const done = value => { process.stdout.write(JSON.stringify(value)); };
    let req;
    try { req = JSON.parse(input); } catch { return done({ error: 'bad request' }); }
    let url;
    try { url = new URL(req.url); } catch { return done({ error: 'bad URL' }); }
    // Credentials go to the Bitbucket API and nowhere else.
    if (url.protocol !== 'https:' || url.hostname !== BITBUCKET_API) return done({ error: `refusing to send credentials to ${url.hostname}` });
    const auth = authorizationHeader();
    if (!auth) return done({ error: `missing ${BITBUCKET_ENV}` });
    const body = req.body == null ? null : String(req.body);
    const r = https.request(url, {
      method: req.method || 'GET',
      headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) },
      timeout: 45000,
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { if (text.length < 8 * 1024 * 1024) text += c; });
      res.on('end', () => done({ status: res.statusCode, body: text }));
    });
    r.on('timeout', () => r.destroy(new Error('request timed out')));
    r.on('error', e => done({ error: e.message }));
    if (body) r.write(body);
    r.end();
  });
}

// ---------------------------------------------------------------- selftest

function selftest() {
  const RUNTIME = path.resolve(__dirname, '..', '..');
  const ENGINE = path.join(__dirname, 'engine.js');
  const RUNS_TOOL = path.join(RUNTIME, 'ai', 'tasks', 'feature', 'runs.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-request-selftest-'));
  // The machine's own git config (signing, hooks, a default identity) must not
  // leak into the fixtures, and the fixtures must not need it.
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  const isolate = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(isolate.GIT_CONFIG_GLOBAL, '[init]\n\tdefaultBranch = main\n');
  const saved = {};
  for (const [k, v] of Object.entries(isolate)) { saved[k] = process.env[k]; process.env[k] = v; }
  const sh = (cwd, ...args) => git(cwd, args);
  try {
    // ---- config
    assert.deepStrictEqual({ ...loadConfig(path.join(tmp, 'nowhere')), problems: undefined, source: undefined }, { ...CONFIG_DEFAULTS, problems: undefined, source: undefined }, 'no config file means disabled defaults');
    const cfgRoot = path.join(tmp, 'cfg');
    fs.mkdirSync(path.join(cfgRoot, '.agentic'), { recursive: true });
    const writeCfg = text => fs.writeFileSync(path.join(cfgRoot, '.agentic', 'config.yaml'), text);
    writeCfg('version: 1\npull_request:\n  enabled: true\n  provider: bitbucket\n  remote: upstream\n  base: develop\n  branch: "feature/{id}"\n  draft: true\n');
    const on = loadConfig(cfgRoot);
    assert.deepStrictEqual([on.enabled, on.provider, on.remote, on.base, on.branch, on.draft, on.problems.length], [true, 'bitbucket', 'upstream', 'develop', 'feature/{id}', true, 0]);
    writeCfg('pull_request:\n  enabled: "yes"\n  provider: gitlab\n  remote: "-x"\n  branch: "../{id}"\n');
    const bad = loadConfig(cfgRoot);
    assert.strictEqual(bad.enabled, false, 'an enabled value that is not literally true stays disabled');
    assert.strictEqual(bad.problems.length, 4, bad.problems.join('; '));
    writeCfg('# pull_request:\n#   enabled: false\nrag:\n  enabled: true\n');
    assert.strictEqual(loadConfig(cfgRoot).enabled, false, 'a commented-out block is disabled');
    const manual = effectiveOptions(loadConfig(cfgRoot), { manual: true, base: 'feature/parent', branch: 'feature/child', draft: true });
    assert.deepStrictEqual([manual.enabled, manual.base, manual.branch, manual.draft], [true, 'feature/parent', 'feature/child', true], 'agentic pr overrides apply over the config');

    // ---- remotes and redaction
    assert.deepStrictEqual(parseRemote('git@bitbucket.org:extra-ws/flutter_project.git'), { provider: 'bitbucket', host: 'bitbucket.org', owner: 'extra-ws', slug: 'flutter_project' });
    assert.deepStrictEqual(parseRemote('ssh://git@bitbucket.org/ws/app.git'), { provider: 'bitbucket', host: 'bitbucket.org', owner: 'ws', slug: 'app' });
    assert.deepStrictEqual(parseRemote('https://someone@bitbucket.org/ws/app.git'), { provider: 'bitbucket', host: 'bitbucket.org', owner: 'ws', slug: 'app' });
    assert.deepStrictEqual(parseRemote('https://github.com/acme/app'), { provider: 'github', host: 'github.com', owner: 'acme', slug: 'app' });
    assert.strictEqual(parseRemote('git@github.com:acme/app.git').provider, 'github');
    assert.strictEqual(parseRemote('/srv/git/app.git'), null);
    assert.strictEqual(parseRemote('file:///srv/git/app.git'), null);
    assert.strictEqual(redact('fatal: https://user:hunter2-secret@bitbucket.org/ws/app.git denied'), 'fatal: https://bitbucket.org/ws/app.git denied');
    assert.strictEqual(redact('token tok-123456789 leaked', { GH_TOKEN: 'tok-123456789' }), 'token *** leaked');
    assert.strictEqual(authorizationHeader({ BITBUCKET_EMAIL: 'a@b.c', BITBUCKET_API_TOKEN: 't0ken-value' }), `Basic ${Buffer.from('a@b.c:t0ken-value').toString('base64')}`);
    assert.strictEqual(authorizationHeader({ BITBUCKET_USERNAME: 'me', BITBUCKET_APP_PASSWORD: 'app-pass-1' }), `Basic ${Buffer.from('me:app-pass-1').toString('base64')}`);
    assert.strictEqual(authorizationHeader({ BITBUCKET_EMAIL: 'a@b.c' }), null);

    // ---- diff scanning reuses the guard's Rule 5
    const policy = leakPolicy(RUNTIME);
    const fakeKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    const diff = ['diff --git a/x.txt b/x.txt', '--- a/x.txt', '+++ b/x.txt', '@@ -1,0 +2,2 @@', '+ok', `+key = ${fakeKey}`].join('\n');
    assert.deepStrictEqual(scanDiff(diff, policy), [{ file: 'x.txt', line: 3, label: 'AWS access key' }]);
    assert.deepStrictEqual(conflictMarkers('+++ b/a.dart\n@@ -0,0 +1,3 @@\n+<<<<<<< HEAD\n+x\n+>>>>>>> other'), ['a.dart:1', 'a.dart:3']);
    assert.deepStrictEqual(conflictMarkers('+++ b/README.md\n@@ -0,0 +1,2 @@\n+Title\n+======='), [], 'a setext heading is not a conflict marker');
    // An added line whose text starts with "++ " is content, not a file header:
    // it is scanned, and its text never becomes a file name.
    const ghToken = ['ghp', '_', 'A'.repeat(36)].join('');
    const plusPlus = ['diff --git a/x.txt b/x.txt', '--- a/x.txt', '+++ b/x.txt', '@@ -0,0 +1,3 @@', `+++ key=${fakeKey}`, '++ token=SECRETVALUE123456789', `+${ghToken}`].join('\n');
    assert.deepStrictEqual(scanDiff(plusPlus, policy).map(h => [h.file, h.line, h.label]), [['x.txt', 1, 'AWS access key'], ['x.txt', 3, 'GitHub token']]);
    // The runtime's own credentials are secret values too (an app password
    // matches no Rule 5 pattern), and are reported by label only.
    const credPolicy = leakPolicy(RUNTIME, { BITBUCKET_APP_PASSWORD: 'ATBBnotARealAppPassword1' });
    assert.deepStrictEqual(textLeaks('body: ATBBnotARealAppPassword1', credPolicy), ['project secret value']);
    assert.deepStrictEqual(textLeaks('body: ATBBnotARealAppPassword1', policy), [], 'only when that variable is set');
    // Commit messages: an AI credited as author is refused; a human co-author,
    // or a commit about a tool, is not.
    assert.deepStrictEqual(commitAttributionProblems('Tidy up\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n'), ['a Co-Authored-By trailer crediting an AI tool']);
    assert.deepStrictEqual(commitAttributionProblems('Upgrade the OpenAI client\n\nCo-Authored-By: Jane Doe <jane@example.com>\n'), []);

    // ---- fixtures: a bare remote reached through a provider-shaped URL
    process.env.AI_WORKFLOW_STATE_ROOT = path.join(tmp, 'runs');
    const { ensure: ensureWorktree, inspect } = require('./worktree');
    const fixture = (name, url) => {
      const bare = path.join(tmp, `${name}-remote.git`);
      const product = path.join(tmp, `${name}-product`);
      sh(tmp, 'init', '-q', '--bare', bare);
      sh(tmp, 'init', '-q', '-b', 'main', product);
      sh(product, 'config', 'user.email', 'dev@example.com');
      sh(product, 'config', 'user.name', 'Fixture Dev');
      fs.writeFileSync(path.join(product, 'app.txt'), 'one\n');
      fs.writeFileSync(path.join(product, '.gitignore'), '.ai-worktrees/\nbuild/\n');
      sh(product, 'add', '-A');
      sh(product, 'commit', '-qm', 'base');
      sh(product, 'remote', 'add', 'origin', url);
      sh(product, 'config', `url.${bare}.insteadOf`, url);
      sh(product, 'push', '-q', 'origin', 'main');
      return { bare, product, remoteSha: branch => { const r = git(tmp, ['--git-dir', bare, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`], { allowFailure: true }); return r.status === 0 ? String(r.stdout).trim() : null; } };
    };
    const startRun = (fx, id, change = true) => {
      const wt = ensureWorktree(RUNTIME, id, { sourceRoot: fx.product });
      assert.strictEqual(wt.baseBranch, 'main', 'the worktree records the branch it was created from');
      if (change) {
        fs.writeFileSync(path.join(wt.path, 'app.txt'), 'one\ntwo\n');
        fs.writeFileSync(path.join(wt.path, 'feature.txt'), 'new\n');
        fs.mkdirSync(path.join(wt.path, 'build'), { recursive: true });
        fs.writeFileSync(path.join(wt.path, 'build', 'out.bin'), 'ignored\n');
      }
      return inspect(RUNTIME, id);
    };
    const description = { title: 'Add a greeting to the app', summary: 'Adds a greeting line.', body: '## Summary\nAdds a greeting line.\n\n## Definition of Done\n- [x] tests pass\n- [ ] device run — not done: no device in CI\n' };
    const opts = over => ({ provider: 'auto', remote: 'origin', base: 'auto', branch: 'ai/{id}', draft: false, ...over });
    const recorder = () => { const r = { patches: [], history: [] }; r.fn = (patch, hist) => { r.patches.push(patch); r.history.push(hist); }; return r; };

    // A GitHub stand-in: gh calls are recorded and PRs kept in memory.
    const fakeGh = () => {
      const s = { calls: [], prs: [], missing: false };
      s.gh = args => {
        s.calls.push(args);
        if (s.missing) return { error: Object.assign(new Error('spawnSync gh ENOENT'), { code: 'ENOENT' }) };
        if (args[0] === 'auth') return { status: 0, stdout: '', stderr: '' };
        if (args[0] === '--version') return { status: 0, stdout: 'gh version 2\n' };
        if (args[0] === 'pr' && args[1] === 'list') {
          const h = args[args.indexOf('--head') + 1];
          return { status: 0, stdout: JSON.stringify(s.prs.filter(p => p.head === h && p.state === 'open').map(p => ({ number: p.number, url: p.url, baseRefName: p.base, isDraft: p.draft }))) };
        }
        if (args[0] === 'pr' && args[1] === 'create') {
          const number = 100 + s.prs.length;
          const pr = { number, url: `https://github.com/acme/app/pull/${number}`, head: args[args.indexOf('--head') + 1], base: args[args.indexOf('--base') + 1], draft: args.includes('--draft'), state: 'open', body: fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8') };
          s.prs.push(pr);
          return { status: 0, stdout: `Creating pull request\n${pr.url}\n` };
        }
        return { status: 1, stderr: `unexpected gh ${args.join(' ')}` };
      };
      return s;
    };
    // A Bitbucket stand-in at the HTTP layer: the request it sees is exactly what
    // the real child would send, minus the Authorization header the child adds.
    const fakeBitbucket = () => {
      const s = { calls: [], prs: [], failCreate: 0 };
      s.http = req => {
        s.calls.push(req);
        const u = new URL(req.url);
        if (req.method === 'GET') {
          const q = u.searchParams.get('q') || '';
          const m = q.match(/source\.branch\.name="([^"]+)"/);
          return { status: 200, body: JSON.stringify({ values: s.prs.filter(p => p.source.branch.name === m?.[1]) }) };
        }
        if (s.failCreate > 0) { s.failCreate--; return { status: 500, body: JSON.stringify({ error: { message: 'temporary outage' } }) }; }
        const body = JSON.parse(req.body);
        const id = 7762 + s.prs.length;
        const pr = { ...body, id, links: { html: { href: `https://bitbucket.org/ws/app/pull-requests/${id}` } } };
        s.prs.push(pr);
        return { status: 201, body: JSON.stringify(pr) };
      };
      return s;
    };
    const bbEnv = { ...process.env, BITBUCKET_EMAIL: 'dev@example.com', BITBUCKET_API_TOKEN: 'bb-fake-token-value-123' };

    // ---- dry run: says everything, changes nothing
    const gh1 = fixture('gh', 'https://github.com/acme/app.git');
    const dryMeta = startRun(gh1, 'RUN-DRY');
    const dryHead = head(dryMeta.path);
    const ghDry = fakeGh();
    // An untracked file with a clean filter on it: a dry run must neither store
    // its content in the repository's objects nor run the filter (git-lfs would
    // copy it into .git/lfs).
    const dryContent = `only ever seen by a dry run ${process.pid}\n`;
    fs.writeFileSync(path.join(dryMeta.path, 'dry-only.txt'), dryContent);
    const dryBlob = git(dryMeta.path, ['hash-object', '--stdin'], { input: dryContent });
    const filterRan = path.join(tmp, 'filter-ran');
    sh(gh1.product, 'config', 'filter.probe.clean', `sh -c 'echo ran >> "${filterRan}"; cat'`);
    sh(gh1.product, 'config', 'filter.probe.required', 'true');
    const infoAttributes = path.join(gh1.product, '.git', 'info', 'attributes');
    fs.mkdirSync(path.dirname(infoAttributes), { recursive: true });
    fs.writeFileSync(infoAttributes, 'dry-only.txt filter=probe\n');
    const dry = plan({ id: 'RUN-DRY', worktree: dryMeta.path, meta: dryMeta, options: opts(), description, deps: ghDry, runtimeRoot: RUNTIME });
    const dryText = dry.lines.join('\n');
    assert.ok(dry.ok, dryText);
    assert.ok(!gitOk(dryMeta.path, ['cat-file', '-e', dryBlob]), 'a dry run writes no object into the repository');
    assert.ok(!fs.existsSync(filterRan), 'a dry run runs no clean filter');
    fs.unlinkSync(infoAttributes);
    sh(gh1.product, 'config', '--remove-section', 'filter.probe');
    assert.match(dryText, /provider: {3}github \(acme\/app\)/);
    assert.match(dryText, /base: {7}main \(worktree\)/);
    assert.match(dryText, /branch: {5}ai\/RUN-DRY — from the template "ai\/\{id\}"/, 'the dry run says which branch and why');
    assert.match(dryText, /would commit: 3 file\(s\)/);
    assert.match(dryText, /existing commits the push would publish: 0/);
    assert.match(dryText, /git push -u origin HEAD:refs\/heads\/ai\/RUN-DRY/);
    assert.ok(!dryText.includes('out.bin'), '.gitignore is respected');
    assert.strictEqual(head(dryMeta.path), dryHead, 'dry run commits nothing');
    assert.strictEqual(sh(dryMeta.path, 'diff', '--cached', '--name-only'), '', 'dry run leaves the real index alone');
    assert.strictEqual(gh1.remoteSha('ai/RUN-DRY'), null, 'dry run pushes nothing');
    assert.ok(!ghDry.calls.some(a => a[0] === 'pr' || a[0] === 'auth'), 'dry run calls no provider API');

    // ---- GitHub happy path, then an idempotent re-run
    const ghMeta = startRun(gh1, 'RUN-GH');
    const ghFake = fakeGh();
    const rec = recorder();
    const first = deliver({ id: 'RUN-GH', worktree: ghMeta.path, meta: ghMeta, options: opts({ draft: true }), description, deps: ghFake, runtimeRoot: RUNTIME, record: rec.fn });
    assert.strictEqual(first.status, 'pass', first.reason);
    assert.deepStrictEqual([first.pullRequest.number, first.pullRequest.url, first.pullRequest.branch, first.pullRequest.base, first.pullRequest.draft, first.pullRequest.provider], [100, 'https://github.com/acme/app/pull/100', 'ai/RUN-GH', 'main', true, 'github']);
    const create = ghFake.calls.find(a => a[1] === 'create');
    assert.deepStrictEqual(create.slice(0, 8), ['pr', 'create', '--repo', 'acme/app', '--base', 'main', '--head', 'ai/RUN-GH']);
    assert.ok(create.includes('--draft'));
    assert.ok(ghFake.prs[0].body.includes('device run — not done'), 'the body file carries the description body');
    const ghHead = head(ghMeta.path);
    assert.strictEqual(gh1.remoteSha('ai/RUN-GH'), ghHead, 'the run branch is pushed');
    assert.strictEqual(sh(ghMeta.path, 'log', '-1', '--format=%s'), 'RUN-GH: Add a greeting to the app');
    assert.strictEqual(sh(ghMeta.path, 'log', '-1', '--format=%an <%ae>'), 'Fixture Dev <dev@example.com>', "the repository's own identity is used");
    assert.ok(!/co-authored|generated with/i.test(sh(ghMeta.path, 'log', '-1', '--format=%B')), 'no attribution in the commit');
    assert.deepStrictEqual(sh(ghMeta.path, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['app.txt', 'feature.txt']);
    assert.deepStrictEqual(rec.history.map(h => h.action), ['commit', 'push', 'open']);
    assert.strictEqual(rec.patches[0].preCommitSha, ghMeta.baseSha, 'the pre-commit HEAD is kept for evidence that was recorded against it');
    assert.match(sh(ghMeta.path, 'rev-parse', '--abbrev-ref', '@{u}'), /^origin\/ai\/RUN-GH$/, 'push -u sets the upstream');
    const again = deliver({ id: 'RUN-GH', worktree: ghMeta.path, meta: ghMeta, options: opts({ draft: true }), description, deps: ghFake, runtimeRoot: RUNTIME, record: rec.fn });
    assert.strictEqual(again.status, 'pass', again.reason);
    assert.strictEqual(again.pullRequest.reused, true);
    assert.strictEqual(ghFake.calls.filter(a => a[1] === 'create').length, 1, 'a re-run does not open a second PR');
    assert.strictEqual(head(ghMeta.path), ghHead, 'a re-run does not commit again');

    // ---- missing gh
    const noGhMeta = startRun(gh1, 'RUN-NOGH');
    const noGh = fakeGh(); noGh.missing = true;
    const missingGh = deliver({ id: 'RUN-NOGH', worktree: noGhMeta.path, meta: noGhMeta, options: opts(), description, deps: noGh, runtimeRoot: RUNTIME });
    assert.strictEqual(missingGh.status, 'blocked');
    assert.match(missingGh.reason, /"gh" is not installed/);
    assert.strictEqual(head(noGhMeta.path), noGhMeta.baseSha, 'nothing is committed before the provider is usable');

    // ---- secret in the diff: blocked with file:line, never the value
    const leakMeta = startRun(gh1, 'RUN-LEAK');
    fs.writeFileSync(path.join(leakMeta.path, 'config.txt'), `name = demo\naws = ${fakeKey}\n`);
    const leak = deliver({ id: 'RUN-LEAK', worktree: leakMeta.path, meta: leakMeta, options: opts(), description, deps: fakeGh(), runtimeRoot: RUNTIME });
    assert.strictEqual(leak.status, 'blocked');
    assert.match(leak.reason, /config\.txt:2: contains what looks like a AWS access key/);
    assert.ok(!leak.reason.includes(fakeKey), 'the secret itself is never repeated');
    assert.strictEqual(head(leakMeta.path), leakMeta.baseSha, 'nothing is committed');
    assert.strictEqual(sh(leakMeta.path, 'diff', '--cached', '--name-only'), '', 'the index is put back');
    fs.writeFileSync(path.join(leakMeta.path, 'config.txt'), 'name = demo\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> theirs\n');
    const markers = deliver({ id: 'RUN-LEAK', worktree: leakMeta.path, meta: leakMeta, options: opts(), description, deps: fakeGh(), runtimeRoot: RUNTIME });
    assert.match(markers.reason || '', /conflict markers at config\.txt:2, config\.txt:6/);

    // A real staged file with a "++ " line: the token after it is reported at
    // its own line, and the "++ " line's text is never a file name.
    const ppMeta = startRun(gh1, 'RUN-PP', false);
    fs.writeFileSync(path.join(ppMeta.path, 'pp.txt'), `++ token=SECRETVALUE123456789\n${ghToken}\n`);
    const pp = deliver({ id: 'RUN-PP', worktree: ppMeta.path, meta: ppMeta, options: opts(), description, deps: fakeGh(), runtimeRoot: RUNTIME });
    assert.match(pp.reason || '', /pp\.txt:2: contains what looks like a GitHub token/);
    assert.ok(!/SECRETVALUE|token=/.test(pp.reason), pp.reason);

    // ---- nothing to do
    const emptyMeta = startRun(gh1, 'RUN-EMPTY', false);
    const empty = deliver({ id: 'RUN-EMPTY', worktree: emptyMeta.path, meta: emptyMeta, options: opts(), description, deps: fakeGh(), runtimeRoot: RUNTIME });
    assert.match(empty.reason || '', /nothing to commit and no commits ahead/);

    // ---- remote branch diverged: blocked, never forced
    const divMeta = startRun(gh1, 'RUN-DIV');
    const other = path.join(tmp, 'other-clone');
    sh(tmp, 'clone', '-q', gh1.bare, other);
    sh(other, 'config', 'user.email', 'other@example.com'); sh(other, 'config', 'user.name', 'Other');
    fs.writeFileSync(path.join(other, 'theirs.txt'), 'theirs\n');
    sh(other, 'add', '-A'); sh(other, 'commit', '-qm', 'someone else');
    sh(other, 'push', '-q', 'origin', 'HEAD:refs/heads/ai/RUN-DIV');
    const theirs = gh1.remoteSha('ai/RUN-DIV');
    const div = deliver({ id: 'RUN-DIV', worktree: divMeta.path, meta: divMeta, options: opts(), description, deps: fakeGh(), runtimeRoot: RUNTIME });
    assert.strictEqual(div.status, 'blocked');
    assert.match(div.reason, /has commits this run does not have.*never force-pushed/);
    assert.strictEqual(gh1.remoteSha('ai/RUN-DIV'), theirs, 'the remote branch is untouched');
    const diverted = deliver({ id: 'RUN-DIV', worktree: divMeta.path, meta: divMeta, options: opts({ branch: 'ai/{id}-2' }), description, deps: fakeGh(), runtimeRoot: RUNTIME });
    assert.strictEqual(diverted.status, 'pass', `another branch name gets through: ${diverted.reason}`);

    // ---- Bitbucket: missing credentials, then the happy path after a failed create
    const bb = fixture('bb', 'git@bitbucket.org:ws/app.git');
    const bbMeta = startRun(bb, 'RUN-BB');
    const bbFake = fakeBitbucket();
    const noCreds = deliver({ id: 'RUN-BB', worktree: bbMeta.path, meta: bbMeta, options: opts(), description, deps: bbFake, runtimeRoot: RUNTIME, env: { PATH: process.env.PATH } });
    assert.strictEqual(noCreds.status, 'blocked');
    assert.match(noCreds.reason, /BITBUCKET_EMAIL and BITBUCKET_API_TOKEN \(or BITBUCKET_USERNAME and BITBUCKET_APP_PASSWORD\)/);
    assert.strictEqual(bbFake.calls.length, 0, 'no API call without credentials');
    assert.strictEqual(head(bbMeta.path), bbMeta.baseSha);
    bbFake.failCreate = 1;
    const bbRec = recorder();
    const outage = deliver({ id: 'RUN-BB', worktree: bbMeta.path, meta: bbMeta, options: opts(), description, deps: bbFake, runtimeRoot: RUNTIME, env: bbEnv, record: bbRec.fn });
    assert.strictEqual(outage.status, 'blocked');
    assert.match(outage.reason, /Bitbucket API HTTP 500: temporary outage/);
    const pushedSha = head(bbMeta.path);
    assert.notStrictEqual(pushedSha, bbMeta.baseSha, 'the commit is kept');
    assert.strictEqual(bb.remoteSha('ai/RUN-BB'), pushedSha, 'the push is kept');
    assert.deepStrictEqual(bbRec.history.map(h => h.action), ['commit', 'push']);
    const resumed = deliver({ id: 'RUN-BB', worktree: bbMeta.path, meta: bbMeta, options: opts(), description, deps: bbFake, runtimeRoot: RUNTIME, env: bbEnv, record: bbRec.fn });
    assert.strictEqual(resumed.status, 'pass', resumed.reason);
    assert.deepStrictEqual(bbRec.history.map(h => h.action), ['commit', 'push', 'open'], 'the resume neither commits nor pushes again');
    assert.strictEqual(head(bbMeta.path), pushedSha);
    assert.deepStrictEqual([resumed.pullRequest.number, resumed.pullRequest.url], [7762, 'https://bitbucket.org/ws/app/pull-requests/7762']);
    const post = bbFake.calls.filter(c => c.method === 'POST').pop();
    assert.strictEqual(post.url, 'https://api.bitbucket.org/2.0/repositories/ws/app/pullrequests');
    assert.deepStrictEqual(JSON.parse(post.body), { title: description.title, description: description.body, source: { branch: { name: 'ai/RUN-BB' } }, destination: { branch: { name: 'main' } }, close_source_branch: false });
    const lookup = bbFake.calls.find(c => c.method === 'GET');
    assert.match(new URL(lookup.url).searchParams.get('q'), /^source\.branch\.name="ai\/RUN-BB" AND state="OPEN"$/);
    const reuse = deliver({ id: 'RUN-BB', worktree: bbMeta.path, meta: bbMeta, options: opts(), description, deps: bbFake, runtimeRoot: RUNTIME, env: bbEnv, record: bbRec.fn });
    assert.strictEqual(reuse.pullRequest.reused, true);
    assert.strictEqual(bbFake.prs.length, 1, 'the open PR is found, not duplicated');
    const everything = JSON.stringify([bbFake.calls, bbRec.patches, bbRec.history, outage, resumed, noCreds]);
    assert.ok(!everything.includes('bb-fake-token-value-123'), 'the token appears in no request, record or message');

    // ---- a pre-push hook refuses once: the resume pushes the same commit
    const fxH = fixture('hook', 'https://github.com/acme/app.git');
    const hookMeta = startRun(fxH, 'RUN-HOOK');
    const refuseOnce = path.join(tmp, 'refuse-push-once');
    fs.writeFileSync(refuseOnce, '');
    const hooks = path.join(fxH.product, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'pre-push'), `#!/bin/sh\nif [ -f "${refuseOnce}" ]; then rm -f "${refuseOnce}"; echo "pre-push: refused once" >&2; exit 1; fi\nexit 0\n`, { mode: 0o755 });
    const hookGh = fakeGh();
    const hookRec = recorder();
    const hookCtx = { id: 'RUN-HOOK', worktree: hookMeta.path, meta: hookMeta, options: opts(), description, deps: hookGh, runtimeRoot: RUNTIME, record: hookRec.fn };
    const refused = deliver(hookCtx);
    assert.strictEqual(refused.status, 'blocked');
    assert.match(refused.reason, /git push failed .*pre-push: refused once/);
    const hookCommit = head(hookMeta.path);
    assert.notStrictEqual(hookCommit, hookMeta.baseSha, 'the commit is kept');
    assert.strictEqual(fxH.remoteSha('ai/RUN-HOOK'), null, 'nothing reached the remote');
    assert.deepStrictEqual(hookRec.history.map(h => h.action), ['commit']);
    const pushedLater = deliver(hookCtx);
    assert.strictEqual(pushedLater.status, 'pass', pushedLater.reason);
    assert.deepStrictEqual(hookRec.history.map(h => h.action), ['commit', 'push', 'open'], 'the resume does not commit again');
    assert.strictEqual(head(hookMeta.path), hookCommit);
    assert.strictEqual(sh(hookMeta.path, 'rev-list', '--count', `${hookMeta.baseSha}..HEAD`), '1', 'exactly one runtime commit');
    assert.strictEqual(fxH.remoteSha('ai/RUN-HOOK'), hookCommit);

    // ---- the remote branch already contains HEAD (a fix pushed on top): reused, nothing pushed
    const onTopClone = path.join(tmp, 'on-top-clone');
    sh(tmp, 'clone', '-q', '-b', 'ai/RUN-HOOK', fxH.bare, onTopClone);
    sh(onTopClone, 'config', 'user.email', 'reviewer@example.com'); sh(onTopClone, 'config', 'user.name', 'Reviewer');
    fs.writeFileSync(path.join(onTopClone, 'review-fix.txt'), 'fix\n');
    sh(onTopClone, 'add', '-A'); sh(onTopClone, 'commit', '-qm', 'review fix');
    sh(onTopClone, 'push', '-q', 'origin', 'HEAD:refs/heads/ai/RUN-HOOK');
    const reviewerTip = fxH.remoteSha('ai/RUN-HOOK');
    const onTop = deliver(hookCtx);
    assert.strictEqual(onTop.status, 'pass', onTop.reason);
    assert.deepStrictEqual([onTop.pullRequest.reused, onTop.pullRequest.remoteCommit, onTop.pullRequest.commit], [true, reviewerTip, hookCommit]);
    assert.strictEqual(fxH.remoteSha('ai/RUN-HOOK'), reviewerTip, 'the remote branch is untouched');
    assert.strictEqual(hookGh.calls.filter(a => a[1] === 'create').length, 1);

    // ---- commits already in the worktree are scanned before the push
    const keyMeta = startRun(fxH, 'RUN-KEY', false);
    fs.writeFileSync(path.join(keyMeta.path, 'k.txt'), `aws = ${fakeKey}\n`);
    sh(keyMeta.path, 'add', 'k.txt'); sh(keyMeta.path, 'commit', '-qm', 'add config');
    fs.writeFileSync(path.join(keyMeta.path, 'k.txt'), 'aws = from-the-environment\n');
    sh(keyMeta.path, 'commit', '-qam', 'take the key out again');
    const keyed = deliver({ id: 'RUN-KEY', worktree: keyMeta.path, meta: keyMeta, options: opts(), description, deps: fakeGh(), runtimeRoot: RUNTIME });
    assert.strictEqual(keyed.status, 'blocked');
    assert.match(keyed.reason, /refusing to push: commit [0-9a-f]{12} k\.txt:1: contains what looks like a AWS access key/, 'a key added and then removed is still in the pushed history');
    assert.ok(!keyed.reason.includes(fakeKey));
    assert.strictEqual(fxH.remoteSha('ai/RUN-KEY'), null, 'nothing is pushed');
    const keyDry = plan({ id: 'RUN-KEY', worktree: keyMeta.path, meta: keyMeta, options: opts(), description, deps: fakeGh(), runtimeRoot: RUNTIME });
    assert.ok(!keyDry.ok && /commit [0-9a-f]{12} k\.txt:1/.test(keyDry.lines.join('\n')), 'the dry run reports it too');
    const attrMeta = startRun(fxH, 'RUN-ATTR', false);
    fs.writeFileSync(path.join(attrMeta.path, 'a.txt'), 'a\n');
    sh(attrMeta.path, 'add', 'a.txt'); sh(attrMeta.path, 'commit', '-qm', 'Tidy up\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    const attributed = deliver({ id: 'RUN-ATTR', worktree: attrMeta.path, meta: attrMeta, options: opts(), description, deps: fakeGh(), runtimeRoot: RUNTIME });
    assert.match(attributed.reason || '', /commit [0-9a-f]{12}: its message contains a Co-Authored-By trailer crediting an AI tool/);
    assert.strictEqual(fxH.remoteSha('ai/RUN-ATTR'), null);

    // ---- a hook that adds a file to the runtime's own commit: scanned before the push
    const fxK = fixture('plant', 'https://github.com/acme/app.git');
    const plantMeta = startRun(fxK, 'RUN-PLANT');
    fs.writeFileSync(path.join(fxK.product, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\nprintf 'aws=%s\\n' ${fakeKey.slice(0, 4)}${fakeKey.slice(4)} > planted.txt\ngit add planted.txt\n`, { mode: 0o755 });
    const planted = deliver({ id: 'RUN-PLANT', worktree: plantMeta.path, meta: plantMeta, options: opts(), description, deps: fakeGh(), runtimeRoot: RUNTIME });
    assert.strictEqual(planted.status, 'blocked');
    assert.match(planted.reason, /refusing to push: commit [0-9a-f]{12} planted\.txt:1: contains what looks like a AWS access key/);
    assert.strictEqual(fxK.remoteSha('ai/RUN-PLANT'), null);
    fs.unlinkSync(path.join(fxK.product, '.git', 'hooks', 'pre-commit'));

    // ---- the runtime's own credential in the description or a file is refused
    const credMeta = startRun(bb, 'RUN-CRED');
    const withToken = { ...description, body: `${description.body}\nToken: ${bbEnv.BITBUCKET_API_TOKEN}\n` };
    const credDesc = deliver({ id: 'RUN-CRED', worktree: credMeta.path, meta: credMeta, options: opts(), description: withToken, deps: fakeBitbucket(), runtimeRoot: RUNTIME, env: bbEnv });
    assert.match(credDesc.reason || '', /description contains what looks like a project secret value/);
    fs.writeFileSync(path.join(credMeta.path, 'settings.txt'), `password=${bbEnv.BITBUCKET_API_TOKEN}\n`);
    const credFile = deliver({ id: 'RUN-CRED', worktree: credMeta.path, meta: credMeta, options: opts(), description, deps: fakeBitbucket(), runtimeRoot: RUNTIME, env: bbEnv });
    assert.match(credFile.reason || '', /settings\.txt:1: contains what looks like a project secret value/);
    assert.ok(![credDesc.reason, credFile.reason].join(' ').includes(bbEnv.BITBUCKET_API_TOKEN));
    assert.strictEqual(head(credMeta.path), credMeta.baseSha);

    // ---- an open PR whose base or draft state differs from the one asked for
    const warnMeta = startRun(fxH, 'RUN-WARN');
    const warnGh = fakeGh();
    warnGh.prs.push({ number: 300, url: 'https://github.com/acme/app/pull/300', head: 'ai/RUN-WARN', base: 'develop', draft: false, state: 'open' });
    const warned = deliver({ id: 'RUN-WARN', worktree: warnMeta.path, meta: warnMeta, options: opts({ draft: true, draftExplicit: true }), description, deps: warnGh, runtimeRoot: RUNTIME });
    assert.strictEqual(warned.status, 'pass', warned.reason);
    assert.strictEqual(warned.pullRequest.number, 300);
    assert.match(warned.pullRequest.warnings.join('\n'), /PR #300 targets develop, not main/);
    assert.match(warned.pullRequest.warnings.join('\n'), /PR #300 is not a draft/);
    const stacked = deliver({ id: 'RUN-WARN', worktree: warnMeta.path, meta: warnMeta, options: opts({ base: 'main' }), description, deps: warnGh, runtimeRoot: RUNTIME });
    assert.match(stacked.reason || '', /pull request #300 from ai\/RUN-WARN is open against develop, but main was requested — retarget it/, 'a requested base is never silently dropped');

    // ---- a run branch created beforehand from another base, tracking a branch with an open PR
    const fxP = fixture('pre', 'https://github.com/acme/app.git');
    const mainTip = sh(fxP.product, 'rev-parse', 'main');
    sh(fxP.product, 'checkout', '-q', '-b', 'revamp');
    fs.writeFileSync(path.join(fxP.product, 'revamp.txt'), 'revamp work\n');
    sh(fxP.product, 'add', '-A'); sh(fxP.product, 'commit', '-qm', 'revamp work');
    sh(fxP.product, 'push', '-q', 'origin', 'revamp');
    sh(fxP.product, 'branch', 'ai/run/RUN-PRE');
    sh(fxP.product, 'push', '-q', '-u', 'origin', 'ai/run/RUN-PRE:security/RUN-PRE');
    sh(fxP.product, 'checkout', '-q', 'main');
    sh(fxP.product, 'remote', 'set-head', 'origin', 'main');
    const preWt = ensureWorktree(RUNTIME, 'RUN-PRE', { sourceRoot: fxP.product });
    assert.deepStrictEqual([preWt.branchPreexisted, preWt.baseBranch, preWt.baseSha], [true, null, sh(fxP.product, 'rev-parse', 'revamp')], 'the main checkout\'s branch is not its base');
    fs.writeFileSync(path.join(preWt.path, 'fix.txt'), 'the run\'s change\n');
    const preMeta = inspect(RUNTIME, 'RUN-PRE');
    const preGh = fakeGh();
    preGh.prs.push({ number: 7763, url: 'https://github.com/acme/app/pull/7763', head: 'security/RUN-PRE', base: 'revamp', draft: false, state: 'open' });
    const preCtx = over => ({ id: 'RUN-PRE', worktree: preWt.path, meta: preMeta, options: opts(over), description, deps: preGh, runtimeRoot: RUNTIME });
    const guessed = deliver(preCtx());
    assert.strictEqual(guessed.status, 'blocked');
    assert.match(guessed.reason, /origin\/main is only a guess from origin\/HEAD.*started at [0-9a-f]{12}, which is not on it.*agentic pr RUN-PRE --base <branch>/);
    assert.strictEqual(preflight(preCtx()).ok, false, 'the engine stops before paying for a description');
    assert.match(plan(preCtx()).lines.join('\n'), /branch: {5}security\/RUN-PRE — the branch ai\/run\/RUN-PRE tracks/);
    // The same run as pre-1.9.31 metadata described it: baseSha was the main
    // checkout's HEAD, which IS on main. The branch's reflog gives it away.
    const oldShape = { ...preMeta, baseSha: mainTip };
    delete oldShape.branchPreexisted; delete oldShape.baseBranch;
    const oldGuess = deliver({ ...preCtx(), meta: oldShape });
    assert.match(oldGuess.reason || '', /ai\/run\/RUN-PRE was not created at the run's start commit/);
    const wrongBase = deliver(preCtx({ base: 'main' }));
    assert.match(wrongBase.reason || '', /pull request #7763 from security\/RUN-PRE is open against revamp, but main was requested/);
    assert.strictEqual(head(preWt.path), preMeta.baseSha, 'nothing was committed by the blocked attempts');
    assert.strictEqual(preGh.calls.filter(a => a[1] === 'create').length, 0);
    const preRec = recorder();
    const adopted = deliver({ ...preCtx({ base: 'revamp' }), record: preRec.fn });
    assert.strictEqual(adopted.status, 'pass', adopted.reason);
    assert.deepStrictEqual([adopted.pullRequest.number, adopted.pullRequest.reused, adopted.pullRequest.branch, adopted.pullRequest.base, adopted.pullRequest.requestedBase], [7763, true, 'security/RUN-PRE', 'revamp', 'revamp']);
    assert.match(adopted.pullRequest.branchSource, /tracks/);
    assert.strictEqual(preGh.calls.filter(a => a[1] === 'create').length, 0, 'the open PR is found, not duplicated');
    assert.strictEqual(fxP.remoteSha('security/RUN-PRE'), head(preWt.path), 'the run commit goes onto the tracked branch');
    assert.strictEqual(fxP.remoteSha('ai/RUN-PRE'), null, 'no second branch is pushed');

    // ---- the worktree branch pushed by hand (no tracking) with an open PR: reused
    const fxW = fixture('wtbranch', 'https://github.com/acme/app.git');
    const wtbMeta = startRun(fxW, 'RUN-WTB');
    sh(wtbMeta.path, 'push', '-q', 'origin', 'HEAD:refs/heads/ai/run/RUN-WTB');
    const wtbGh = fakeGh();
    wtbGh.prs.push({ number: 41, url: 'https://github.com/acme/app/pull/41', head: 'ai/run/RUN-WTB', base: 'main', draft: false, state: 'open' });
    const wtb = deliver({ id: 'RUN-WTB', worktree: wtbMeta.path, meta: wtbMeta, options: opts(), description, deps: wtbGh, runtimeRoot: RUNTIME });
    assert.strictEqual(wtb.status, 'pass', wtb.reason);
    assert.deepStrictEqual([wtb.pullRequest.number, wtb.pullRequest.branch, wtb.pullRequest.reused], [41, 'ai/run/RUN-WTB', true]);
    assert.strictEqual(fxW.remoteSha('ai/RUN-WTB'), null, 'no duplicate branch or PR');
    assert.strictEqual(wtbGh.calls.filter(a => a[1] === 'create').length, 0);

    // ---- an old worktree without baseBranch falls back to <remote>/HEAD, else asks for --base
    const oldMeta = { ...startRun(gh1, 'RUN-OLD') };
    delete oldMeta.baseBranch;
    // Written before 1.9.31: no branchPreexisted either. Its reflog shows it
    // was created at baseSha, so the fallback is trusted.
    delete oldMeta.branchPreexisted;
    // Newer git creates <remote>/HEAD on fetch; this run must start without one.
    git(oldMeta.path, ['symbolic-ref', '-d', 'refs/remotes/origin/HEAD'], { allowFailure: true });
    const noBase = plan({ id: 'RUN-OLD', worktree: oldMeta.path, meta: oldMeta, options: opts(), description, deps: fakeGh(), runtimeRoot: RUNTIME });
    assert.match(noBase.lines.join('\n'), /pass it: agentic pr RUN-OLD --base <branch>/);
    sh(oldMeta.path, 'remote', 'set-head', 'origin', 'main');
    assert.match(plan({ id: 'RUN-OLD', worktree: oldMeta.path, meta: oldMeta, options: opts(), description, deps: fakeGh(), runtimeRoot: RUNTIME }).lines.join('\n'), /base: {7}main \(origin\/HEAD\)/);

    engineSelftest({ tmp, RUNTIME, ENGINE, RUNS_TOOL, fixture, description });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('pull-request selftest OK');
}

// The stage through the real engine and runs.js, in child processes: an old
// state.json without the new phase, the disabled default, `agentic pr` with
// stacked-PR overrides, and the enabled config. Only the agent (a stub
// executor) and the provider (a stub gh layer) are stand-ins.
function engineSelftest({ tmp, RUNTIME, ENGINE, RUNS_TOOL, fixture, description }) {
  const yamlWorkflow = yaml.load(fs.readFileSync(path.join(RUNTIME, 'ai', 'workflows', 'feature.yaml'), 'utf8'));
  const states = path.join(tmp, 'engine-runs');
  const fx = fixture('engine', 'https://github.com/acme/app.git');
  const db = path.join(tmp, 'gh-db.json');
  fs.writeFileSync(db, JSON.stringify({ prs: [], calls: [] }));
  const ghLayer = path.join(tmp, 'gh-layer.js');
  fs.writeFileSync(ghLayer, `
    const fs = require('fs');
    const DB = ${JSON.stringify(db)};
    exports.gh = args => {
      const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
      db.calls.push(args);
      let out = { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'pr' && args[1] === 'list') { const h = args[args.indexOf('--head') + 1]; out.stdout = JSON.stringify(db.prs.filter(p => p.head === h).map(p => ({ number: p.number, url: p.url, baseRefName: p.base, isDraft: p.draft }))); }
      if (args[0] === 'pr' && args[1] === 'create') { const number = 7762 + db.prs.length; const pr = { number, url: 'https://github.com/acme/app/pull/' + number, head: args[args.indexOf('--head') + 1], base: args[args.indexOf('--base') + 1], draft: args.includes('--draft') }; db.prs.push(pr); out.stdout = pr.url + '\\n'; }
      fs.writeFileSync(DB, JSON.stringify(db));
      return out;
    };
    exports.http = () => ({ error: 'no network in selftest' });
  `);
  const stub = path.join(tmp, 'stub-executor.js');
  fs.writeFileSync(stub, `
    const fs = require('fs');
    const args = process.argv.slice(2);
    const out = args[args.indexOf('--output-file') + 1];
    fs.appendFileSync(${JSON.stringify(path.join(tmp, 'executor.log'))}, args[2] + '\\n');
    fs.writeFileSync(out, JSON.stringify({ schemaVersion: 1, runId: process.env.FEATURE_RUN_ID, title: ${JSON.stringify(description.title)}, summary: 'Adds a greeting line.', body: ${JSON.stringify(description.body)}, template: null,
      definitionOfDone: [{ item: 'tests pass', status: 'done' }, { item: 'device run', status: 'not-done', reason: 'no device available' }], residualRisks: ['run the app on a device'] }));
  `);
  const env = { ...process.env, PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), AI_WORKFLOW_STATE_ROOT: states, AI_WORKFLOW_PROJECT_ROOT: fx.product, AI_WORKFLOW_RUNTIME_ROOT: RUNTIME, AI_WORKFLOW_SELFTEST: '1', AI_WORKFLOW_TEST_EXECUTOR: stub, AI_WORKFLOW_TEST_PR_LAYER: ghLayer, AI_WORKFLOW_AVAILABLE_MCPS: '' };
  delete env.AI_WORKFLOW_PRODUCT_ROOT; delete env.AI_AGENTIC_CLI; delete env.AI_EVAL; delete env.QC_EVAL;
  const stateOf = id => JSON.parse(fs.readFileSync(path.join(states, id, 'state.json'), 'utf8'));
  // A run whose every stage before the new one is done, written the way a
  // 1.9.30 run left it: no pull-request phase at all.
  const verifiedRun = id => {
    const started = spawnSync(process.execPath, [RUNS_TOOL, 'start', id], { env, encoding: 'utf8' });
    assert.strictEqual(started.status, 0, started.stderr);
    const file = path.join(states, id, 'state.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const stage of yamlWorkflow.stages) if (stage.id !== 'pull-request') state.phases[stage.id] = { status: stage.when ? 'skipped' : 'pass' };
    state.evidence.mobileScreenshots = { requirement: 'not-required', reason: 'selftest' };
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
    const prev = process.env.AI_WORKFLOW_STATE_ROOT;
    process.env.AI_WORKFLOW_STATE_ROOT = states;
    const wt = require('./worktree').ensure(RUNTIME, id, { sourceRoot: fx.product });
    process.env.AI_WORKFLOW_STATE_ROOT = prev;
    fs.writeFileSync(path.join(wt.path, 'feature.txt'), 'new\n');
    return wt;
  };
  const drive = (code, extra = {}) => {
    const driver = `const engine = require(${JSON.stringify(ENGINE)}); const wf = engine.workflow(); const stage = wf.stages.find(s => s.id === 'pull-request');
      try { const r = (${code})(engine, wf, stage); console.log('RESULT ' + r); } catch (e) { console.log('RESULT ERROR ' + e.message); }`;
    const res = spawnSync(process.execPath, ['-e', driver], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 120000 });
    assert.strictEqual(res.status, 0, res.stderr);
    return { result: (res.stdout.match(/^RESULT (.*)$/m) || [])[1], stdout: res.stdout, stderr: res.stderr };
  };

  // Old state.json: the new stage is next, and with no config it is skipped with the hint.
  verifiedRun('E2E-OLD');
  assert.strictEqual(stateOf('E2E-OLD').phases['pull-request'], undefined);
  const next = drive(`(engine, wf) => engine.nextEligibleStage(wf, require(${JSON.stringify(path.join(states, 'E2E-OLD', 'state.json'))})).id`);
  assert.strictEqual(next.result, 'pull-request', 'a run verified before 1.9.31 resumes at the new stage');
  const skipped = drive('(engine, wf, stage) => engine.executeStage("E2E-OLD", wf, stage, {})');
  assert.strictEqual(skipped.result, 'skipped', skipped.stdout + skipped.stderr);
  const old = stateOf('E2E-OLD');
  assert.strictEqual(old.phases['pull-request'].status, 'skipped');
  assert.match(old.phases['pull-request'].note, /pull_request\.enabled is not true.*engine\.js pr E2E-OLD/);
  assert.ok(!fs.existsSync(path.join(tmp, 'executor.log')), 'a disabled stage runs no agent');
  const { buildSummary, renderTerminal } = require('./progress');
  assert.match(renderTerminal(buildSummary('E2E-OLD', old, { root: states })), /Pull request: not opened — run: node ai\/workflow\/engine\.js pr E2E-OLD/);

  // Dry run through the engine command: no state change.
  const before = fs.readFileSync(path.join(states, 'E2E-OLD', 'state.json'), 'utf8');
  const dry = drive('(engine) => engine.pullRequestCommand("E2E-OLD", { "dry-run": true, branch: "feature/child", base: "main" })');
  assert.strictEqual(dry.result, 'dry-run', dry.stdout + dry.stderr);
  assert.match(dry.stdout, /branch: {5}feature\/child/);
  assert.strictEqual(fs.readFileSync(path.join(states, 'E2E-OLD', 'state.json'), 'utf8'), before, 'a dry run writes no state');

  // `agentic pr` on the skipped stage, with stacked-PR overrides: opens the PR
  // although the config is disabled, and keeps the overrides for a resume.
  const opened = drive('(engine) => engine.pullRequestCommand("E2E-OLD", { branch: "feature/child", base: "main", draft: true })');
  assert.strictEqual(opened.result, 'pass', opened.stdout + opened.stderr);
  const done = stateOf('E2E-OLD');
  assert.strictEqual(done.phases['pull-request'].status, 'pass');
  assert.deepStrictEqual([done.pullRequestOptions.manual, done.pullRequestOptions.branch, done.pullRequestOptions.base, done.pullRequestOptions.draft], [true, 'feature/child', 'main', true]);
  assert.deepStrictEqual([done.pullRequest.number, done.pullRequest.url, done.pullRequest.branch, done.pullRequest.status, done.pullRequest.draft], [7762, 'https://github.com/acme/app/pull/7762', 'feature/child', 'open', true]);
  assert.ok(done.pullRequest.createdAt && done.pullRequest.updatedAt);
  assert.ok(done.history.some(h => h.kind === 'pull-request' && h.action === 'open'));
  assert.strictEqual(fx.remoteSha('feature/child'), done.pullRequest.commit);
  assert.ok(fs.existsSync(path.join(states, 'E2E-OLD', '12-pull-request.md')), 'the description artifact is kept');
  assert.match(renderTerminal(buildSummary('E2E-OLD', done, { root: states })), /Pull request: #7762 https:\/\/github\.com\/acme\/app\/pull\/7762/);
  // Again: the description is not regenerated and the PR is not duplicated.
  const repeat = drive('(engine) => engine.pullRequestCommand("E2E-OLD", {})');
  assert.strictEqual(repeat.result, 'pass', repeat.stdout + repeat.stderr);
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'executor.log'), 'utf8').trim().split('\n').length, 1, 'the description is written once');
  assert.strictEqual(JSON.parse(fs.readFileSync(db, 'utf8')).prs.length, 1, 'one PR, however often it is asked for');
  assert.strictEqual(stateOf('E2E-OLD').pullRequestOptions.branch, 'feature/child', 'the overrides persist');

  // Enabled in config: the stage runs on its own after verification.
  fs.mkdirSync(path.join(fx.product, '.agentic'), { recursive: true });
  fs.writeFileSync(path.join(fx.product, '.agentic', 'config.yaml'), 'version: 1\npull_request:\n  enabled: true\n');
  verifiedRun('E2E-ON');
  const auto = drive('(engine, wf, stage) => engine.executeStage("E2E-ON", wf, stage, {})');
  assert.strictEqual(auto.result, 'pass', auto.stdout + auto.stderr);
  assert.strictEqual(stateOf('E2E-ON').pullRequest.branch, 'ai/E2E-ON');
  assert.strictEqual(fx.remoteSha('ai/E2E-ON'), stateOf('E2E-ON').pullRequest.commit);

  // Eval mode never opens a pull request, even when enabled.
  verifiedRun('E2E-EVAL');
  const evalRun = drive('(engine, wf, stage) => engine.executeStage("E2E-EVAL", wf, stage, {})', { AI_EVAL: '1' });
  assert.strictEqual(evalRun.result, 'skipped');
  assert.match(stateOf('E2E-EVAL').phases['pull-request'].note, /eval mode/);
  assert.strictEqual(fx.remoteSha('ai/E2E-EVAL'), null);

  // A blocked stage is blocked with its reason and the engine exits non-zero.
  verifiedRun('E2E-BLOCK');
  fs.writeFileSync(path.join(fx.product, '.agentic', 'config.yaml'), 'version: 1\npull_request:\n  enabled: true\n  remote: nowhere\n');
  const blocked = drive('(engine, wf, stage) => engine.executeStage("E2E-BLOCK", wf, stage, {})');
  assert.match(blocked.result, /^ERROR .*git remote "nowhere" is not configured/);
  assert.strictEqual(stateOf('E2E-BLOCK').phases['pull-request'].status, 'blocked');
  assert.strictEqual(drive(`(engine, wf) => engine.nextEligibleStage(wf, require(${JSON.stringify(path.join(states, 'E2E-BLOCK', 'state.json'))})).id`).result, 'pull-request', 'resume picks a blocked PR stage up again');
  // ...and executing it (blocked → begin) opens the PR once the cause is fixed.
  fs.writeFileSync(path.join(fx.product, '.agentic', 'config.yaml'), 'version: 1\npull_request:\n  enabled: true\n');
  const unblocked = drive('(engine, wf, stage) => engine.executeStage("E2E-BLOCK", wf, stage, {})');
  assert.strictEqual(unblocked.result, 'pass', unblocked.stdout + unblocked.stderr);
  assert.strictEqual(stateOf('E2E-BLOCK').phases['pull-request'].status, 'pass');
  assert.strictEqual(fx.remoteSha('ai/E2E-BLOCK'), stateOf('E2E-BLOCK').pullRequest.commit);

  // An engine that died mid-stage leaves it in_progress; the next one carries on.
  verifiedRun('E2E-STUCK');
  const stuckFile = path.join(states, 'E2E-STUCK', 'state.json');
  const stuck = JSON.parse(fs.readFileSync(stuckFile, 'utf8'));
  stuck.phases['pull-request'] = { status: 'in_progress', updatedAt: new Date().toISOString() };
  fs.writeFileSync(stuckFile, JSON.stringify(stuck, null, 2));
  assert.strictEqual(drive(`(engine, wf) => engine.nextEligibleStage(wf, require(${JSON.stringify(stuckFile)})).id`).result, 'pull-request');
  const resumedStuck = drive('(engine, wf, stage) => engine.executeStage("E2E-STUCK", wf, stage, {})');
  assert.strictEqual(resumedStuck.result, 'pass', resumedStuck.stdout + resumedStuck.stderr);
  assert.match(resumedStuck.stdout, /carrying on with an interrupted pull-request stage/);
  assert.strictEqual(stateOf('E2E-STUCK').phases['pull-request'].status, 'pass');

  // A closed run is never published by a resume, and `agentic pr` needs --reopen.
  verifiedRun('E2E-CLOSED');
  const closedFile = path.join(states, 'E2E-CLOSED', 'state.json');
  const closedState = JSON.parse(fs.readFileSync(closedFile, 'utf8'));
  closedState.status = 'done'; closedState.closedAt = new Date().toISOString();
  fs.writeFileSync(closedFile, JSON.stringify(closedState, null, 2));
  const closedResume = drive('(engine, wf, stage) => engine.executeStage("E2E-CLOSED", wf, stage, {})');
  assert.strictEqual(closedResume.result, 'skipped', closedResume.stdout + closedResume.stderr);
  assert.match(stateOf('E2E-CLOSED').phases['pull-request'].note, /the run is closed .*--reopen/);
  assert.strictEqual(fx.remoteSha('ai/E2E-CLOSED'), null);
  const refusedClosed = drive('(engine) => engine.pullRequestCommand("E2E-CLOSED", {})');
  assert.match(refusedClosed.result, /^ERROR run E2E-CLOSED is closed.*--reopen/);
  const reopened = drive('(engine) => engine.pullRequestCommand("E2E-CLOSED", { reopen: true })');
  assert.strictEqual(reopened.result, 'pass', reopened.stdout + reopened.stderr);
  assert.strictEqual(fx.remoteSha('ai/E2E-CLOSED'), stateOf('E2E-CLOSED').pullRequest.commit);

  // A mistyped or unknown option is refused before anything runs.
  verifiedRun('E2E-FLAGS');
  const flagsWt = JSON.parse(fs.readFileSync(path.join(states, 'E2E-FLAGS', 'engine', 'worktree.json'), 'utf8'));
  const flagsHead = String(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: flagsWt.path, encoding: 'utf8' }).stdout).trim();
  for (const [argv, why] of [[['--dryrun'], /unknown option --dryrun \(did you mean --dry-run\?\)/], [['--dry_run'], /did you mean --dry-run/], [['--dry-run=true'], /did you mean --dry-run without "="/], [['-n'], /unexpected argument "-n"/], [['main'], /unexpected argument "main" \(the base is passed as --base <branch>\)/], [['--no-draft'], /unknown option --no-draft/]]) {
    const cli = spawnSync(process.execPath, [ENGINE, 'pr', 'E2E-FLAGS', ...argv], { env, encoding: 'utf8', timeout: 120000 });
    assert.notStrictEqual(cli.status, 0, `pr ${argv.join(' ')} must fail`);
    assert.match(cli.stderr, why);
    assert.match(cli.stderr, /usage: agentic pr <id>/);
  }
  assert.strictEqual(String(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: flagsWt.path, encoding: 'utf8' }).stdout).trim(), flagsHead, 'nothing was committed');
  assert.strictEqual(fx.remoteSha('ai/E2E-FLAGS'), null, 'nothing was pushed');
  assert.strictEqual(stateOf('E2E-FLAGS').pullRequestOptions, undefined, 'no options were stored');
}

if (require.main === module) {
  const arg = process.argv[2];
  if (arg === '--http') httpChild();
  else if (arg === '--selftest' || arg === 'selftest') {
    try { selftest(); } catch (e) { console.error(e.stack || e.message); process.exitCode = 1; }
  } else {
    console.error('usage: pull-request.js --selftest   (the stage runs through: engine.js pr <id> [--base <branch>] [--branch <name>] [--draft] [--dry-run], or agentic pr <id>)');
    process.exitCode = 1;
  }
}

module.exports = { CONFIG_DEFAULTS, Blocked, evalMode, redact, validRef, loadConfig, effectiveOptions, branchFor, parseRemote, leakPolicy, textLeaks, scanDiff, addedLines, conflictMarkers, commitAttributionProblems, publishProblems, fallbackBaseProblem, layer, bitbucketCredentials, authorizationHeader, githubProvider, bitbucketProvider, preflight, plan, deliver };
