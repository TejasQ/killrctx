// ============================================================================
// setup.mjs — detect-and-connect wizard for killrctx
// ============================================================================
//
// _Basically_, this is the "npm run init" experience. A developer who already
// has a backend running (OpenRAG or AI Workbench) runs this once and ends up
// with a working app at http://localhost:3001 — no manual .env editing required.
//
// This script does NOT install anything. Start a backend first, then run it.
//
// Flow (interactive / no flags):
//   1. printBanner()           — show the title
//   2. detectBackends()        — probe OpenRAG + AI Workbench (3s timeout each)
//   3. showMenu()              — arrow-key select with [1]–[6] labels; reprints after each action
//
// Non-interactive flags (via cac — each maps to one menu action):
//   --status               print detection results and exit
//   --configure openrag    configure OpenRAG and write .env.local
//   --configure workbench  configure AI Workbench and write .env.local
//   --configure all        configure both backends
//   --launch               run configure-all then start the app
//   --force                skip "already configured?" guard in configure flow
//   --skip-launch          legacy alias for running configure without launching
//   --help / --version
//
// Per-backend configure flow:
//   a. collectKeys(backend)           — gather API keys (warns if backend DOWN)
//   b. discoverWorkbenchConfig()      — (Workbench only) pick workspace/agent IDs
//   c. writeEnvLocal(backends, keys)  — incremental write; backup once per session
// ============================================================================

import { createRequire } from 'module'
import { execSync, spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// ESM-compatible require for CJS packages (prompts, cac)
const require = createRequire(import.meta.url)
// Wrap prompts so Ctrl-C during any prompt exits immediately instead of
// silently returning undefined and letting the wizard continue.
const _prompts = require('prompts')
const prompts  = (q, opts) => _prompts(q, { onCancel: () => process.exit(0), ...opts })
const { cac }  = require('cac')

import chalk from 'chalk'
import ora   from 'ora'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT      = path.resolve(__dirname, '..')          // killrctx repo root
const PKG       = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

// Tracks whether we've already backed up .env.local this session so we only
// do it once — subsequent incremental writes should not overwrite the backup.
let backupDoneThisSession = false

// ─── tiny log helpers ────────────────────────────────────────────────────────
const sym = {
  ok:   chalk.green('✓'),
  fail: chalk.red('✗'),
  warn: chalk.yellow('⚠'),
  info: chalk.blue('ℹ'),
  dash: chalk.dim('─'),
}
const log = {
  ok:   (msg) => console.log(` ${sym.ok}  ${msg}`),
  fail: (msg) => console.log(` ${sym.fail}  ${msg}`),
  warn: (msg) => console.log(` ${sym.warn}  ${chalk.yellow(msg)}`),
  info: (msg) => console.log(` ${sym.info}  ${msg}`),
  rule: ()    => console.log(chalk.dim('─'.repeat(52))),
  nl:   ()    => console.log(),
}

// ─── entry point (cac) ───────────────────────────────────────────────────────
const cli = cac('killrctx')
cli.version(PKG.version)
cli.help()
cli.option('--status',           'Show backend detection results and exit')
cli.option('--configure <target>', 'Configure openrag | workbench | all')
cli.option('--launch',           'Configure all backends then start the app')
cli.option('--force',            'Skip "already configured?" guard')
cli.option('--skip-launch',      'Write .env.local but do not start the app (legacy)')
cli.command('[...args]', 'Interactive setup wizard').action((_args, opts) => {
  main(opts).catch((err) => {
    log.fail(err.message ?? String(err))
    process.exit(1)
  })
})
cli.parse()

// ─── main ────────────────────────────────────────────────────────────────────
async function main(opts = {}) {
  printBanner()

  const backends = await detectBackends()

  // Non-interactive flag paths — each does one thing and exits.
  if (opts.status) {
    // detectBackends already printed the status table — nothing more needed.
    process.exit(0)
  }

  if (opts.configure) {
    const target = String(opts.configure).toLowerCase()
    if (target === 'openrag' || target === 'all') {
      await configureBackend('openrag', backends, opts)
    }
    if (target === 'workbench' || target === 'all') {
      await configureBackend('workbench', backends, opts)
    }
    process.exit(0)
  }

  if (opts.launch) {
    await configureBackend('openrag',   backends, opts)
    await configureBackend('workbench', backends, opts)
    await launchApp()
    return
  }

  // Legacy --skip-launch: configure everything, skip launch.
  if (opts['skip-launch']) {
    await configureBackend('openrag',   backends, opts)
    await configureBackend('workbench', backends, opts)
    log.nl()
    log.ok('.env.local written. Skipping launch (--skip-launch).')
    process.exit(0)
  }

  // No flags — show the interactive menu loop.
  await showMenu(backends, opts)
}

// ─── showMenu ─────────────────────────────────────────────────────────────────
// _Basically_, a numbered menu that stays on screen until the user exits.
// Each action completes then the menu reprints — so the developer can configure
// one backend, check status, and launch without re-running the script.
async function showMenu(backends, opts) {
  while (true) {
    const { choice } = await prompts({
      type:    'select',
      name:    'choice',
      message: 'What would you like to do?',
      choices: [
        { title: '[1]  Configure OpenRAG',      value: '1' },
        { title: '[2]  Configure AI Workbench', value: '2' },
        { title: '[3]  Configure both',         value: '3' },
        { title: '[4]  Show backend status',    value: '4' },
        { title: '[5]  Launch app',             value: '5' },
        { title: '[6]  Exit',                   value: '6' },
      ],
    })

    log.nl()

    if (choice === '1') await configureBackend('openrag',   backends, opts)
    if (choice === '2') await configureBackend('workbench', backends, opts)
    if (choice === '3') {
      await configureBackend('openrag',   backends, opts)
      await configureBackend('workbench', backends, opts)
    }
    if (choice === '4') await detectBackends()    // re-probe and reprint status
    if (choice === '5') { await launchApp(); return }
    if (choice === '6' || !choice) process.exit(0)
  }
}

// ─── configureBackend ─────────────────────────────────────────────────────────
// _Basically_, the per-backend configure flow: check if already configured,
// collect keys, discover Workbench IDs (if applicable), write .env.local.
//
// Skips with a "already configured" prompt unless --force is set.
// Warns if the backend is currently DOWN (keys may not work, but proceeds).
async function configureBackend(backendKey, backends, opts = {}) {
  const label = backendKey === 'openrag' ? 'OpenRAG' : 'AI Workbench'

  // ── Already-configured guard (TASK-22) ───────────────────────────────────
  if (!opts.force) {
    const alreadySet = isBackendConfigured(backendKey)
    if (alreadySet) {
      const { proceed } = await prompts({
        type:    'confirm',
        name:    'proceed',
        message: `${label} is already configured — reconfigure?`,
        initial: false,
      })
      if (!proceed) {
        log.info(`Keeping existing ${label} configuration.`)
        log.nl()
        return
      }
    }
  }

  // ── Offline warning (TASK-23) ─────────────────────────────────────────────
  const isUp = backendKey === 'openrag' ? backends.openrag : backends.workbench
  if (!isUp) {
    log.warn(`${label} is not running. Keys entered now may not work until the backend starts.`)
    log.nl()
  }

  // ── Collect keys ──────────────────────────────────────────────────────────
  const keys = await collectKeys(backendKey)

  // ── Workbench: discover workspace/agent/service IDs ───────────────────────
  // We skip discovery when the backend is DOWN — there's nothing to query.
  if (backendKey === 'workbench' && isUp) {
    const discovered = await discoverWorkbenchConfig(backends.workbenchUrl)
    Object.assign(keys, discovered)
  }

  // ── Write .env.local (incremental) ────────────────────────────────────────
  await writeEnvLocal(backends, keys)
}

// ─── isBackendConfigured ──────────────────────────────────────────────────────
// Returns true if the key variables for this backend are already set in
// .env.local or .env (i.e. a previous wizard run wrote them).
function isBackendConfigured(backendKey) {
  const env = {
    ...loadEnvFile(path.join(ROOT, '.env')),
    ...loadEnvFile(path.join(ROOT, '.env.local')),
  }
  if (backendKey === 'openrag') {
    return Boolean(env.OPENAI_API_KEY || env.OPENRAG_API_KEY)
  }
  if (backendKey === 'workbench') {
    return Boolean(env.WORKBENCH_URL && env.WORKBENCH_WORKSPACE_ID)
  }
  return false
}

// ─── printBanner ─────────────────────────────────────────────────────────────
function printBanner() {
  console.log()
  console.log(chalk.cyan('╔══════════════════════════════════════════════════╗'))
  console.log(chalk.cyan('║') + chalk.bold('  killrctx') + chalk.dim('  ·  self-hosted NotebookLM setup  ') + chalk.cyan('║'))
  console.log(chalk.cyan('╚══════════════════════════════════════════════════╝'))
  console.log()
}

// ─── loadEnvFile — minimal line-by-line .env parser ─────────────────────────
// _Basically_, reads KEY=VALUE lines from a file and returns them as an object.
// Ignores comments and blank lines. No external dotenv lib.
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {}
  const vars = {}
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    // Strip inline comments — e.g. KEY=value  # comment
    const raw = trimmed.slice(eq + 1)
    const val = raw.replace(/#.*$/, '').trim()
    // Only record non-blank values. A blank entry (e.g. OPENAI_API_KEY= from
    // .env.example / a fresh .env.local) should not shadow a real value in
    // a higher-priority file — we skip it here and let the merge in callers
    // fall through to the next file in priority order.
    if (val) vars[key] = val
  }
  return vars
}

// ─── detectBackends ──────────────────────────────────────────────────────────
// Probes OpenRAG and AI Workbench in parallel. Reads URL vars from .env.local
// then .env so a developer with custom ports is handled automatically.
async function detectBackends() {
  const env = {
    ...loadEnvFile(path.join(ROOT, '.env')),
    ...loadEnvFile(path.join(ROOT, '.env.local')),
  }

  const openragUrl   = (env.OPENRAG_URL   || 'http://localhost:3000').replace(/\/$/, '')
  const workbenchUrl = (env.WORKBENCH_URL || 'http://localhost:8080').replace(/\/$/, '')

  const spinner = ora('Detecting local backends…').start()

  const probe = async (url, suffix = '/health') => {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 3000)
      const res = await fetch(`${url}${suffix}`, { signal: ctrl.signal })
      clearTimeout(timer)
      return res.ok
    } catch {
      return false
    }
  }

  const [openrag, workbench] = await Promise.all([
    probe(openragUrl, '/health'),
    probe(workbenchUrl, '/healthz'),
  ])

  spinner.stop()
  log.rule()

  if (openrag) {
    log.ok(`OpenRAG       ${chalk.dim(`found at ${openragUrl}`)}`)
  } else {
    log.fail(`OpenRAG       ${chalk.dim(`not found  (probed ${openragUrl}/health)`)}`)
  }

  if (workbench) {
    log.ok(`AI Workbench  ${chalk.dim(`found at ${workbenchUrl}`)}`)
  } else {
    log.fail(`AI Workbench  ${chalk.dim(`not found  (probed ${workbenchUrl}/healthz)`)}`)
  }

  log.rule()
  log.nl()

  return { openrag, workbench, openragUrl, workbenchUrl }
}

// ─── collectKeys ─────────────────────────────────────────────────────────────
// _Basically_, prompts only for the keys killrctx itself needs to talk to the
// chosen backend — not for the keys the backend uses internally (those were
// configured when the user set up the backend).
//
// If a key already exists in .env or .env.local its masked value is shown next
// to the prompt and pressing Enter keeps it (no re-typing required).
async function collectKeys(backendKey) {
  log.rule()
  log.info('API keys for killrctx:')
  log.rule()
  log.nl()

  // Read existing values so we can pre-fill prompts (.env.local wins over .env).
  const existing = {
    ...loadEnvFile(path.join(ROOT, '.env')),
    ...loadEnvFile(path.join(ROOT, '.env.local')),
  }

  // Returns a masked hint like "sk-…xYz" for display next to the prompt.
  // Plain text only — prompts wraps the message in kleur.bold() internally,
  // and nested chalk ANSI codes inside that wrapper render incorrectly on
  // most terminals (the dim codes get swallowed by the bold reset).
  const mask = (v) => v ? `${v.slice(0, 3)}…${v.slice(-3)}` : ''

  const needed = []
  if (backendKey === 'openrag') {
    needed.push({ name: 'OPENAI_API_KEY',  label: 'OpenAI API key (platform.openai.com/api-keys)' })
    needed.push({ name: 'OPENRAG_API_KEY', label: 'OpenRAG API key (optional)' })
  }
  // Workbench connection URL is already known from detectBackends — no key prompts.
  needed.push({ name: 'ELEVENLABS_API_KEY', label: 'ElevenLabs API key (elevenlabs.io/app/settings/api-keys · optional)' })

  const result = {}
  for (const { name, label } of needed) {
    const current = existing[name] || ''
    // Plain-text hint — no chalk here so the mask is visible inside prompts'
    // own bold wrapper. e.g.  OpenAI API key ... [sk-…VoA]:
    const hint    = current ? ` [${mask(current)}]` : ''

    const { value } = await prompts({
      type:    'invisible',
      name:    'value',
      message: `${label}${hint}`,
    })

    // Empty input = keep existing value (if any). Explicit input = use new value.
    const resolved = value || current
    if (resolved) result[name] = resolved
  }

  log.nl()
  return result
}

// ─── discoverWorkbenchConfig ─────────────────────────────────────────────────
// _Basically_, queries the live workbench API to find workspaces, agents, and
// services — then lets the user pick by name instead of pasting UUIDs.
// Returns a partial env object ready to merge into keys.
//
// For existing installs where agent/chunking/embedding IDs are already in
// .env.local, we skip those prompts — the user only re-picks the workspace
// if they want to switch.
async function discoverWorkbenchConfig(baseUrl) {
  log.rule()
  log.info('Discovering AI Workbench configuration from live API …')
  log.nl()

  const get = async (apiPath) => {
    try {
      const res = await fetch(`${baseUrl}${apiPath}`)
      if (!res.ok) return []
      const data = await res.json()
      return data.items ?? []
    } catch {
      return []
    }
  }

  // Step 1 — pick workspace
  const workspaces = await get('/api/v1/workspaces')
  if (!workspaces.length) {
    log.warn('No workspaces found on workbench — skipping auto-config.')
    log.nl()
    return {}
  }

  const { wsId } = await prompts({
    type:    'select',
    name:    'wsId',
    message: 'Which workspace?',
    choices: workspaces.map((w) => ({ title: `${chalk.bold(w.name)}  ${chalk.dim(w.workspaceId)}`, value: w.workspaceId })),
  })
  if (!wsId) return {}

  // If agent/chunking/embedding IDs are already in .env.local, skip those prompts.
  // The user is just reconnecting — they already made these choices.
  const existing = {
    ...loadEnvFile(path.join(ROOT, '.env')),
    ...loadEnvFile(path.join(ROOT, '.env.local')),
  }
  const hasDefaults = (
    existing.WORKBENCH_DEFAULT_AGENT_ID &&
    existing.WORKBENCH_CHUNKING_SERVICE_ID &&
    existing.WORKBENCH_DEFAULT_EMBEDDING_SERVICE_ID
  )

  if (hasDefaults) {
    log.ok('Agent, chunking service, and embedding service already configured — keeping existing.')
    log.nl()
    return { WORKBENCH_WORKSPACE_ID: wsId }
  }

  // IDs missing — fetch all three and let the user pick by name.
  const [agents, chunkers, embedders] = await Promise.all([
    get(`/api/v1/workspaces/${wsId}/agents`),
    get(`/api/v1/workspaces/${wsId}/chunking-services`),
    get(`/api/v1/workspaces/${wsId}/embedding-services`),
  ])

  const pick = async (label, items, idField, nameField = 'name') => {
    if (!items.length) { log.warn(`No ${label} found — skipping.`); return null }
    if (items.length === 1) {
      log.ok(`${label}: ${chalk.bold(items[0][nameField])}  ${chalk.dim('(only one available, auto-selected)')}`)
      return items[0][idField]
    }
    const { id } = await prompts({
      type:    'select',
      name:    'id',
      message: `Default ${label}?`,
      choices: items.map((i) => ({
        title: `${chalk.bold(i[nameField])}  ${chalk.dim(i.description ?? i[idField])}`,
        value: i[idField],
      })),
    })
    return id ?? null
  }

  const [agentId, chunkId, embedId] = await Promise.all([
    pick('agent',             agents,   'agentId'),
    pick('chunking service',  chunkers, 'chunkingServiceId'),
    pick('embedding service', embedders,'embeddingServiceId'),
  ])

  log.nl()

  const result = { WORKBENCH_WORKSPACE_ID: wsId }
  if (agentId)  result.WORKBENCH_DEFAULT_AGENT_ID             = agentId
  if (chunkId)  result.WORKBENCH_CHUNKING_SERVICE_ID          = chunkId
  if (embedId)  result.WORKBENCH_DEFAULT_EMBEDDING_SERVICE_ID = embedId
  return result
}

// ─── writeEnvLocal ───────────────────────────────────────────────────────────
// Reads .env.example as the base, writes .env.local with connection URLs and
// discovered IDs, collected API keys, and any non-blank values already in
// .env.local/.env (so re-running init never loses keys the user set previously).
//
// Backs up any pre-existing .env.local — but only once per session (the first
// time this function runs). Subsequent calls in the same session do incremental
// writes without overwriting the backup.
async function writeEnvLocal(backends, keys) {
  const examplePath = path.join(ROOT, '.env.example')
  const localPath   = path.join(ROOT, '.env.local')
  const backupPath  = path.join(ROOT, '.env.local.bak')

  if (!fs.existsSync(examplePath)) {
    log.warn('.env.example not found — skipping .env.local write.')
    return
  }

  // Read existing env files BEFORE we rename .env.local so we can carry
  // all non-blank values forward. .env.local wins over .env (same priority
  // as Next.js itself uses at runtime).
  const existingEnv = {
    ...loadEnvFile(path.join(ROOT, '.env')),
    ...loadEnvFile(localPath),
  }

  // Back up existing .env.local — only once per session (TASK-24).
  if (!backupDoneThisSession && fs.existsSync(localPath)) {
    fs.copyFileSync(localPath, backupPath)
    backupDoneThisSession = true
    log.info(`.env.local.bak created from previous .env.local`)
  }

  // Build the overrides map, in priority order (highest last wins):
  //   1. non-blank values already in .env / .env.local   — carry-forward
  //   2. URLs detected this run                          — always authoritative
  //   3. keys collected from the user this run           — explicit user input wins
  const carryForward = Object.fromEntries(
    Object.entries(existingEnv).filter(([, v]) => v)
  )
  const overrides = {
    ...carryForward,
    ...(backends.openrag   && { OPENRAG_URL:   backends.openragUrl }),
    ...(backends.workbench && { WORKBENCH_URL: backends.workbenchUrl }),
    ...Object.fromEntries(Object.entries(keys).filter(([, v]) => v)),
  }

  // Line-by-line replace in .env.example
  const lines = fs.readFileSync(examplePath, 'utf8').split('\n')
  const output = lines.map((line) => {
    const eq = line.indexOf('=')
    if (eq === -1 || line.trim().startsWith('#')) return line
    const key = line.slice(0, eq).trim()
    if (key in overrides) return `${key}=${overrides[key]}`
    return line
  })

  fs.writeFileSync(localPath, output.join('\n'), 'utf8')
  log.ok(`.env.local written  ${chalk.dim(localPath)}`)

  if (Object.keys(overrides).length) {
    log.ok(`Set: ${chalk.green(Object.keys(overrides).join(', '))}`)
  }
  log.nl()
}

// ─── launchApp ───────────────────────────────────────────────────────────────
async function launchApp() {
  // Kill any process already holding port 3001 — happens when a previous
  // wizard run crashed before the process exited cleanly.
  const pid = portPid(3001)
  if (pid) {
    log.warn(`Port 3001 is in use by PID ${pid} — stopping it first …`)
    try {
      process.kill(pid)
      // Give the OS a moment to release the port before we bind it again.
      await new Promise((r) => setTimeout(r, 1000))
      log.ok('Previous process stopped.')
    } catch {
      log.warn('Could not stop the process — you may need to free port 3001 manually.')
    }
    log.nl()
  }

  log.rule()
  console.log(` ${chalk.bold.cyan('Starting killrctx')} → ${chalk.underline('http://localhost:3001')}`)
  log.rule()
  log.nl()

  // detached: true gives next its own pgid so we can kill the whole group
  // (next + next-server) with a single negative-pid signal. This is necessary
  // because setup.mjs inherits its pgid from whatever launched the terminal
  // (e.g. Bob), so Ctrl-C from the terminal does NOT reach next's processes —
  // we have to forward the signal ourselves.
  const nextBin = path.join(ROOT, 'node_modules', '.bin', 'next')
  const child = spawn(nextBin, ['dev', '-p', '3001'], { stdio: 'inherit', cwd: ROOT, detached: true })

  let stopping = false
  const stop = (sig) => {
    if (stopping) return   // guard against double-signal
    stopping = true
    try {
      process.kill(-child.pid, sig)  // kill the entire next process group
    } catch {
      child.kill(sig)  // fallback if group kill fails
    }
  }
  process.on('SIGINT',  () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))
  child.on('exit', (code) => process.exit(code ?? 0))
}

// Returns the PID listening on `port`, or null if the port is free.
// Uses lsof which is available on macOS and most Linux distros.
function portPid(port) {
  try {
    const out = execSync(`lsof -ti tcp:${port}`, { stdio: 'pipe' }).toString().trim()
    const pid = parseInt(out, 10)
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null  // lsof exits non-zero when nothing is listening
  }
}
