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
// Flow:
//   1. printBanner()           — show the title
//   2. detectBackends()        — probe OpenRAG + AI Workbench (3s timeout each)
//   3. promptBackendChoice()   — pick from running backends; exit 0 if none
//   4. collectKeys(choice)     — gather API keys for the chosen backend
//   5. discoverWorkbenchConfig — (Workbench only) query live API for UUIDs
//   6. writeEnvLocal()         — merge into .env.local (backs up existing)
//   7. launchApp()             — npm run dev (unless --skip-launch)
//
// Flags (via cac): --skip-launch  --help  --version
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
cli.option('--skip-launch', 'Write .env.local but do not start the app')
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

  // 1. Probe what's running — if nothing is found we print instructions and stop.
  const backends = await detectBackends()

  // 2. Ask which backend to use. This prints start instructions and exits if
  //    nothing is running, so the return value is always a live backend choice.
  const choice = await promptBackendChoice(backends)

  // 3. Collect API keys and connection details for the chosen backend.
  const keys = await collectKeys(choice.key)

  // 4. For Workbench, query the live API to auto-discover workspace/agent/service
  //    IDs so the user never has to paste UUIDs into .env.local.
  if (choice.key === 'workbench') {
    const discovered = await discoverWorkbenchConfig(backends.workbenchUrl)
    Object.assign(keys, discovered)
  }

  // 5. Write .env.local with the connection URLs + keys + discovered IDs.
  await writeEnvLocal(backends, keys)

  // 6. Launch (unless skipped).
  if (!opts['skip-launch']) {
    await launchApp()
  } else {
    log.nl()
    log.ok('.env.local written. Skipping launch (--skip-launch).')
  }
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
    vars[key] = val
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

// ─── promptBackendChoice ─────────────────────────────────────────────────────
// _Basically_, shows only the backends that are currently running. If nothing
// is running we print per-platform start instructions and exit — the user needs
// to start a backend before this wizard can do anything useful.
// Returns { key: 'openrag'|'workbench'|'skip' }
async function promptBackendChoice(backends) {
  const running = []
  if (backends.openrag)   running.push({ title: `${chalk.bold('OpenRAG')}       ${chalk.dim(backends.openragUrl)}`,   value: 'openrag' })
  if (backends.workbench) running.push({ title: `${chalk.bold('AI Workbench')}  ${chalk.dim(backends.workbenchUrl)}`, value: 'workbench' })
  running.push({ title: chalk.dim('Skip for now'), value: 'skip' })

  // Nothing running — print instructions so the developer knows exactly what to do.
  if (!backends.openrag && !backends.workbench) {
    log.info('No backend is running. Start one first, then re-run npm run init.')
    log.nl()
    console.log(`  ${chalk.bold('OpenRAG')} (recommended):`)
    console.log(`    https://github.com/langflow-ai/openrag — follow Quick Start`)
    console.log(`    Default URL: ${chalk.cyan('http://localhost:3000')}`)
    log.nl()
    console.log(`  ${chalk.bold('AI Workbench')}:`)
    console.log(`    https://github.com/datastax/ai-workbench — follow Quick Start`)
    console.log(`    Default URL: ${chalk.cyan('http://localhost:8080')}`)
    log.nl()
    process.exit(0)
  }

  const { choice } = await prompts({
    type:    'select',
    name:    'choice',
    message: 'Which backend would you like to use?',
    choices: running,
  })

  if (!choice || choice === 'skip') {
    log.warn('Skipping backend selection. Some features will be unavailable.')
    log.nl()
    return { key: 'skip' }
  }

  return { key: choice }
}

// ─── collectKeys ─────────────────────────────────────────────────────────────
// _Basically_, prompts only for the keys killrctx itself needs to talk to the
// chosen backend — not for the keys the backend uses internally (those were
// configured when the user set up the backend).
async function collectKeys(backendKey) {
  log.rule()
  log.info('API keys for killrctx:')
  log.rule()
  log.nl()

  const needed = []
  if (backendKey === 'openrag') {
    needed.push({ name: 'OPENAI_API_KEY',  label: `OpenAI API key ${chalk.dim('(platform.openai.com/api-keys)')}` })
    needed.push({ name: 'OPENRAG_API_KEY', label: `OpenRAG API key ${chalk.dim('(optional)')}` })
  }
  // Workbench connection URL is already known from detectBackends — no key prompts.
  needed.push({ name: 'ELEVENLABS_API_KEY', label: `ElevenLabs API key ${chalk.dim('(elevenlabs.io/app/settings/api-keys · optional)')}` })

  const result = {}
  for (const { name, label } of needed) {
    const { value } = await prompts({
      type:    'invisible',
      name:    'value',
      message: `${label}:`,
    })
    if (value) result[name] = value
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
// discovered IDs. For fresh installs, also writes the collected API keys.
// Backs up any pre-existing .env.local first.
async function writeEnvLocal(backends, keys) {
  const examplePath = path.join(ROOT, '.env.example')
  const localPath   = path.join(ROOT, '.env.local')
  const backupPath  = path.join(ROOT, '.env.local.bak')

  if (!fs.existsSync(examplePath)) {
    log.warn('.env.example not found — skipping .env.local write.')
    return
  }

  // Back up existing .env.local
  if (fs.existsSync(localPath)) {
    fs.renameSync(localPath, backupPath)
    log.info(`.env.local.bak created from previous .env.local`)
  }

  // Build the overrides map: connection URLs + discovered IDs + fresh-install keys.
  // Existing installs only contribute URLs and IDs — keys stay in the platform.
  const overrides = {
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

// Replace (or append) a KEY=value line in an env file.
// Used by tests and external scripts that patch .env.local directly.
function injectEnvValue(filePath, key, value) {
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''
  const lines   = content.split('\n')
  let found     = false
  const updated = lines.map((line) => {
    const eq = line.indexOf('=')
    if (eq !== -1 && line.slice(0, eq).trim() === key) {
      found = true
      return `${key}=${value}`
    }
    return line
  })
  if (!found) updated.push(`${key}=${value}`)
  fs.writeFileSync(filePath, updated.join('\n'), 'utf8')
}
