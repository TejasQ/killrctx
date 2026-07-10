// ============================================================================
// setup.mjs — interactive setup wizard for killrctx
// ============================================================================
//
// _Basically_, this is the "npm run init" experience. A developer who just
// cloned the repo runs this once and ends up with a working app at
// http://localhost:3001 — no manual .env editing required.
//
// Flow:
//   1. printBanner()       — show the title
//   2. detectBackends()    — probe OpenRAG + AI Workbench (reads env vars)
//   3. ensureDocker()      — if no backend found, make sure Docker is running
//   4. handleNoBackends()  — if no backend found, install one via Docker
//   5. collectKeys()       — gather API keys for detected/installed backends
//   6. writeEnvLocal()     — merge into .env.local (backs up existing)
//   7. launchApp()         — npm run dev (unless --skip-launch)
//
// Flags (via cac): --skip-docker  --skip-launch  --help  --version
// ============================================================================

import { createRequire } from 'module'
import { execSync, spawn, spawnSync } from 'child_process'
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
cli.option('--skip-docker', 'Skip Docker runtime check and install')
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

  // 1. Detect what's already running and what's installed (but stopped)
  const backends = await detectBackends()
  const installed = detectInstalledDirs()

  // 2. Always ask the user which backend to use — detection is shown as
  //    context in the prompt, but the user is never skipped past this.
  if (!opts['skip-docker']) {
    await ensureDocker()
  }
  const choice = await promptBackendChoice(backends, installed)

  // 3. If they picked a stopped install, start it now
  if (choice.action === 'start') {
    await startBackend(choice.key, backends)
  }

  // 4. Gather API keys and write .env.local immediately — before any further
  //    Docker work. File exists even if a later step fails.
  const keys = await collectKeys(backends, choice.key)

  // 4a. If workbench is the chosen backend, auto-discover its workspace/agent/
  //     service IDs from the live API so the user never has to paste UUIDs.
  if (choice.key === 'workbench') {
    const discovered = await discoverWorkbenchConfig(backends.workbenchUrl)
    Object.assign(keys, discovered)
  }

  await writeEnvLocal(backends, keys)

  // 5. Fresh install — only reached when user picked a backend not yet installed
  if (choice.action === 'install') {
    if (choice.key === 'openrag') {
      await installOpenRAG(backends, keys)
    } else {
      await installWorkbench(backends, keys)
    }
  }

  // 6. Launch (unless skipped)
  if (!opts['skip-launch']) {
    await launchApp(keys)
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

// ─── ensureDocker ─────────────────────────────────────────────────────────────
// _Basically_, make sure `docker info` works before we try to pull/run images.
//
// Resolution order:
//   1. docker info succeeds              → already running, nothing to do
//   2. colima on PATH, not started yet   → colima start
//   3. colima not on PATH                → brew install colima docker → colima start
//   4. user chooses Docker Desktop       → pause and wait for them to start it
async function ensureDocker() {
  // Case 1 — Docker is already reachable
  if (dockerRunning()) return

  const colimaOnPath = spawnSync('which', ['colima'], { stdio: 'pipe' }).status === 0

  if (colimaOnPath) {
    // Case 2 — Colima installed but not started
    log.warn('Colima found but Docker is not reachable. Starting Colima…')
    log.nl()
    const child = spawn('colima', ['start'], { stdio: 'inherit' })
    await waitForChild(child, 'colima start')
  } else {
    // Case 3/4 — nothing present: ask which runtime to use
    log.warn('No Docker runtime detected.')
    log.nl()

    const { choice } = await prompts({
      type:    'select',
      name:    'choice',
      message: 'Docker is needed to install a backend. Install one now?',
      choices: [
        { title: `${chalk.bold('Colima')}         ${chalk.dim('recommended · lightweight · macOS/Linux · ~2 min')}`, value: 'colima' },
        { title: `${chalk.bold('Docker Desktop')} ${chalk.dim('GUI app · macOS/Windows/Linux · ~5 min')}`,           value: 'desktop' },
        { title: chalk.dim('Cancel setup'),                                                                            value: 'cancel' },
      ],
    })

    if (!choice || choice === 'cancel') {
      log.nl()
      log.info('Setup cancelled. Run npm run init when Docker is ready.')
      process.exit(0)
    }

    if (choice === 'colima') {
      await installAndStartColima()
    } else {
      await waitForDockerDesktop()
    }
  }

  // Final check — confirm docker info works after whatever we did
  if (!dockerRunning()) {
    log.fail('Docker still not reachable. Please start it manually and re-run npm run init.')
    process.exit(1)
  }

  log.ok('Docker is running.')
  log.nl()
}

// Returns true if `docker info` exits cleanly (daemon is reachable)
function dockerRunning() {
  try {
    execSync('docker info', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function installAndStartColima() {
  // Ensure Homebrew is present first
  const brewCheck = spawnSync('which', ['brew'], { stdio: 'pipe' })
  if (brewCheck.status !== 0) {
    log.info('Installing Homebrew first…')
    log.nl()
    const brewInstall = spawn(
      '/bin/bash',
      ['-c', '$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)'],
      { stdio: 'inherit' }
    )
    await waitForChild(brewInstall, 'Homebrew install')
  }

  log.info('Installing Colima + Docker CLI via Homebrew…')
  log.nl()
  const brewColima = spawn('brew', ['install', 'colima', 'docker'], { stdio: 'inherit' })
  await waitForChild(brewColima, 'brew install colima docker')

  log.nl()
  log.info('Starting Colima…')
  const colimaStart = spawn('colima', ['start'], { stdio: 'inherit' })
  await waitForChild(colimaStart, 'colima start')
}

async function waitForDockerDesktop() {
  log.nl()
  log.info('Download Docker Desktop: https://docs.docker.com/desktop/setup/install/mac-install/')
  log.info('Install it, start it, then come back here.')
  log.nl()
  await prompts({ type: 'invisible', name: '_', message: 'Press Enter when Docker Desktop is running…' })
}

// ─── detectInstalledDirs ─────────────────────────────────────────────────────
// Returns which sibling backend dirs exist on disk (installed but possibly
// stopped). This is separate from detectBackends() which probes HTTP health.
function detectInstalledDirs() {
  return {
    openrag:   fs.existsSync(path.join(ROOT, '..', 'openrag',      'docker-compose.yml')),
    workbench: fs.existsSync(path.join(ROOT, '..', 'ai-workbench', 'docker-compose.yml')),
  }
}

// ─── promptBackendChoice ─────────────────────────────────────────────────────
// _Basically_, always asks the user which backend to use. Detection results
// are shown inline as status hints so the user can make an informed choice,
// but nothing is auto-selected or auto-skipped.
// Returns { key: 'openrag'|'workbench'|'skip', action: 'none'|'start'|'install' }
async function promptBackendChoice(backends, installed) {
  const label = (key, displayName, url) => {
    if (backends[key])  return `${chalk.bold(displayName)}  ${chalk.green('● running')}  ${chalk.dim(url)}`
    if (installed[key]) return `${chalk.bold(displayName)}  ${chalk.yellow('● installed, not running')}  ${chalk.dim(url)}`
    return                     `${chalk.bold(displayName)}  ${chalk.dim('not installed · Docker · ~5 min')}`
  }

  const { choice } = await prompts({
    type:    'select',
    name:    'choice',
    message: 'Which backend would you like to use?',
    choices: [
      { title: label('openrag',   'OpenRAG       ', backends.openragUrl),   value: 'openrag' },
      { title: label('workbench', 'AI Workbench  ', backends.workbenchUrl), value: 'workbench' },
      { title: chalk.dim('Skip for now'),                                    value: 'skip' },
    ],
  })

  if (!choice || choice === 'skip') {
    log.warn('Skipping backend selection. Some features will be unavailable.')
    log.nl()
    return { key: 'skip', action: 'none' }
  }

  if (backends[choice])  return { key: choice, action: 'none' }
  if (installed[choice]) return { key: choice, action: 'start' }
  return                        { key: choice, action: 'install' }
}

// ─── startBackend ────────────────────────────────────────────────────────────
// Starts a stopped but already-installed backend. Mutates `backends` in place.
async function startBackend(key, backends) {
  const isWorkbench = key === 'workbench'
  const dir         = path.resolve(ROOT, '..', isWorkbench ? 'ai-workbench' : 'openrag')
  const displayName = isWorkbench ? 'AI Workbench' : 'OpenRAG'
  const suffix      = isWorkbench ? '/healthz' : '/health'
  const timeout     = isWorkbench ? 180 : 300
  const url         = isWorkbench ? backends.workbenchUrl : backends.openragUrl

  log.info(`Starting existing ${displayName} install at ${chalk.cyan(dir)}`)
  log.nl()
  await runDockerCompose(dir)
  await pollHealth(url, suffix, displayName, timeout)
  backends[key] = true
  log.ok(`${displayName} is running.`)
  log.nl()
}

// keys come from collectKeys() — already written to .env.local, now also
// injected into the workbench's own sibling .env for docker compose.
async function installOpenRAG(backends, keys) {
  const dir = path.resolve(ROOT, '..', 'openrag')
  log.rule()
  log.info(`Installing OpenRAG`)
  log.info(`  Location  ${chalk.cyan(dir)}`)
  log.info(`  This dir is a sibling of ${chalk.dim(path.basename(ROOT))} — not inside it`)
  log.rule()
  log.nl()

  fs.mkdirSync(dir, { recursive: true })
  log.info('Downloading docker-compose.yml …')
  await downloadFile(
    'https://raw.githubusercontent.com/langflow-ai/openrag/main/docker-compose.yml',
    path.join(dir, 'docker-compose.yml')
  )
  log.info('Downloading .env template …')
  await downloadFile(
    'https://raw.githubusercontent.com/langflow-ai/openrag/main/.env.example',
    path.join(dir, '.env')
  )

  // Seed the OpenAI key into the sibling .env so docker compose picks it up
  if (keys.OPENAI_API_KEY) {
    injectEnvValue(path.join(dir, '.env'), 'OPENAI_API_KEY', keys.OPENAI_API_KEY)
    log.ok(`OPENAI_API_KEY written to ${chalk.dim(path.join(dir, '.env'))}`)
  }
  log.nl()

  await runDockerCompose(dir)
  await pollHealth(backends.openragUrl, '/health', 'OpenRAG', 300)
  log.ok('OpenRAG is running.')
  log.info(`  Compose files  ${chalk.dim(dir)}`)
  log.nl()
}

async function installWorkbench(backends, keys) {
  const dir = path.resolve(ROOT, '..', 'ai-workbench')
  log.rule()
  log.info(`Installing AI Workbench`)
  log.info(`  Location  ${chalk.cyan(dir)}`)
  log.info(`  This dir is a sibling of ${chalk.dim(path.basename(ROOT))} — not inside it`)
  log.rule()
  log.nl()

  fs.mkdirSync(dir, { recursive: true })
  log.info('Downloading docker-compose.yml …')
  await downloadFile(
    'https://raw.githubusercontent.com/datastax/ai-workbench/main/docker-compose.yml',
    path.join(dir, 'docker-compose.yml')
  )
  log.info('Downloading .env template …')
  await downloadFile(
    'https://raw.githubusercontent.com/datastax/ai-workbench/main/.env.example',
    path.join(dir, '.env')
  )

  // Seed credentials into the sibling .env so docker compose picks them up.
  // Keys were already collected in collectKeys() and written to .env.local.
  const envPath = path.join(dir, '.env')
  if (keys.OPENROUTER_API_KEY)         injectEnvValue(envPath, 'OPENROUTER_API_KEY',         keys.OPENROUTER_API_KEY)
  if (keys.ASTRA_DB_API_ENDPOINT)      injectEnvValue(envPath, 'ASTRA_DB_API_ENDPOINT',      keys.ASTRA_DB_API_ENDPOINT)
  if (keys.ASTRA_DB_APPLICATION_TOKEN) injectEnvValue(envPath, 'ASTRA_DB_APPLICATION_TOKEN', keys.ASTRA_DB_APPLICATION_TOKEN)

  // Always write OLLAMA_BASE_URL pointing at host.docker.internal.
  // Inside the container, `localhost` is the container itself — Ollama runs on
  // the host. The docker-compose.yml adds the `host.docker.internal:host-gateway`
  // extra_host so this alias resolves on both macOS and Linux Docker Engine.
  // Without this explicit value, the Workbench falls back to http://localhost:11434
  // and every Ollama chat request fails with "fetch failed".
  injectEnvValue(envPath, 'OLLAMA_BASE_URL', 'http://host.docker.internal:11434/v1')
  log.ok(`Credentials written to ${chalk.dim(envPath)}`)
  log.nl()

  await runDockerCompose(dir)
  await pollHealth(backends.workbenchUrl, '/healthz', 'AI Workbench', 180)
  log.ok('AI Workbench is running.')
  log.info(`  Compose files  ${chalk.dim(dir)}`)
  log.nl()
}

// ─── discoverWorkbenchConfig ─────────────────────────────────────────────────
// _Basically_, queries the live workbench API to find workspaces, agents, and
// services — then lets the user pick by name instead of pasting UUIDs.
// Returns a partial env object ready to merge into keys.
//
// Docker networking gotcha: the Workbench runs inside a container. When an
// Ollama LLM service is created via the UI while the workbench is running in
// Docker, `endpointBaseUrl` is often stored as null in the backing database —
// the UI shows OLLAMA_BASE_URL as a placeholder, but saving null means the
// runtime falls back to its compiled-in default of http://localhost:11434,
// which is the *container's* localhost (Ollama isn't there). We detect any
// Ollama services with a null endpoint and fix them automatically.
async function discoverWorkbenchConfig(baseUrl) {
  log.rule()
  log.info('Discovering AI Workbench configuration from live API …')
  log.nl()

  const get = async (path) => {
    try {
      const res = await fetch(`${baseUrl}${path}`)
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

  // Steps 2-5 — pick agent, chunking service, embedding service, and check
  // LLM services in parallel
  const [agents, chunkers, embedders, llmServices] = await Promise.all([
    get(`/api/v1/workspaces/${wsId}/agents`),
    get(`/api/v1/workspaces/${wsId}/chunking-services`),
    get(`/api/v1/workspaces/${wsId}/embedding-services`),
    get(`/api/v1/workspaces/${wsId}/llm-services`),
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

  // Fix any Ollama LLM services whose endpointBaseUrl is null.
  // When null, the Workbench container hits http://localhost:11434 (itself),
  // not the host. host.docker.internal resolves to the host gateway via the
  // extra_hosts mapping in docker-compose.yml.
  await fixOllamaEndpoints(baseUrl, wsId, llmServices)

  log.nl()

  const result = { WORKBENCH_WORKSPACE_ID: wsId }
  if (agentId)  result.WORKBENCH_DEFAULT_AGENT_ID             = agentId
  if (chunkId)  result.WORKBENCH_CHUNKING_SERVICE_ID          = chunkId
  if (embedId)  result.WORKBENCH_DEFAULT_EMBEDDING_SERVICE_ID = embedId
  return result
}

// ─── fixOllamaEndpoints ───────────────────────────────────────────────────────
// _Basically_, ensures every Ollama LLM service in the workspace has an explicit
// endpointBaseUrl pointing at host.docker.internal. Without it, the Workbench
// container falls back to http://localhost:11434 — its own loopback — and every
// chat request fails with "ollama request failed: fetch failed".
async function fixOllamaEndpoints(baseUrl, wsId, llmServices) {
  const HOST_OLLAMA = 'http://host.docker.internal:11434/v1'

  const broken = llmServices.filter(
    (s) => s.provider === 'ollama' && !s.endpointBaseUrl
  )
  if (!broken.length) return

  log.warn(`Found ${broken.length} Ollama LLM service(s) with no endpoint URL — fixing for Docker …`)

  for (const svc of broken) {
    try {
      const res = await fetch(
        `${baseUrl}/api/v1/workspaces/${wsId}/llm-services/${svc.llmServiceId}`,
        {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ endpointBaseUrl: HOST_OLLAMA }),
        }
      )
      if (res.ok) {
        log.ok(`  ${chalk.bold(svc.name)}  endpoint → ${chalk.dim(HOST_OLLAMA)}`)
      } else {
        log.warn(`  ${chalk.bold(svc.name)}  PATCH failed (${res.status}) — set endpointBaseUrl manually`)
      }
    } catch (err) {
      log.warn(`  ${chalk.bold(svc.name)}  PATCH error: ${err.message}`)
    }
  }
}

// ─── collectKeys ─────────────────────────────────────────────────────────────
// Gathers API keys for the chosen backend. Reads any existing .env.local first
// — if a key already has a value, shows a masked preview and asks whether to
// keep it or replace it. Only prompts for the new value if replacing.
async function collectKeys(backends, backendKey) {
  // Load whatever is already in .env.local so we can show existing values
  const existing = loadEnvFile(path.join(ROOT, '.env.local'))

  log.rule()
  log.info('API keys — existing values shown masked. Press Enter to keep.')
  log.rule()
  log.nl()

  // Which keys are relevant for this backend selection
  const needed = []
  if (backends.openrag || backendKey === 'openrag') {
    needed.push({ name: 'OPENAI_API_KEY',   label: `OpenAI API key ${chalk.dim('(platform.openai.com/api-keys)')}` })
    needed.push({ name: 'OPENRAG_API_KEY',  label: `OpenRAG API key ${chalk.dim('(optional)')}` })
  }
  if (backends.workbench || backendKey === 'workbench') {
    needed.push({ name: 'WORKBENCH_API_KEY',          label: `AI Workbench API key ${chalk.dim('(optional — leave blank for local installs)')}` })
    needed.push({ name: 'OPENROUTER_API_KEY',         label: `OpenRouter API key ${chalk.dim('(openrouter.ai/keys · needed for chat)')}` })
    needed.push({ name: 'ASTRA_DB_API_ENDPOINT',      label: `Astra DB endpoint ${chalk.dim('(optional)')}` })
    needed.push({ name: 'ASTRA_DB_APPLICATION_TOKEN', label: `Astra DB token ${chalk.dim('(optional · AstraCS:…)')}` })
    // WORKBENCH_WORKSPACE_ID, WORKBENCH_DEFAULT_AGENT_ID, WORKBENCH_CHUNKING_SERVICE_ID,
    // and WORKBENCH_DEFAULT_EMBEDDING_SERVICE_ID are auto-discovered in discoverWorkbenchConfig()
  }
  needed.push({ name: 'ELEVENLABS_API_KEY', label: `ElevenLabs API key ${chalk.dim('(elevenlabs.io/app/settings/api-keys · optional)')}` })

  const result = {}

  for (const { name, label } of needed) {
    // Treat blank/whitespace as absent — .env.example seeds empty placeholders
    const current = existing[name]?.trim() || null

    if (current) {
      // Show masked: first 4 chars + asterisks + last 4 chars
      const masked = maskKey(current)
      const { action } = await prompts({
        type:    'select',
        name:    'action',
        message: `${label}:  ${chalk.dim(masked)}`,
        choices: [
          { title: chalk.dim(`Keep  ${masked}`), value: 'keep'    },
          { title: 'Replace',                    value: 'replace' },
        ],
      })
      if (!action || action === 'keep') {
        result[name] = current  // carry the existing value forward
        continue
      }
    }

    // No existing value, or user chose to replace — prompt for the new value
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

// Returns a masked version of a key: first 4 + ****** + last 4.
// Short values (≤8 chars) are fully masked.
function maskKey(val) {
  if (val.length <= 8) return '*'.repeat(val.length)
  return val.slice(0, 4) + '••••••••' + val.slice(-4)
}

// ─── writeEnvLocal ───────────────────────────────────────────────────────────
// Reads .env.example as the base, replaces values with wizard answers, writes
// .env.local. Backs up any pre-existing .env.local first.
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

  // Build the merged values map
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

  const set     = Object.keys(overrides)
  const skipped = [
    'OPENAI_API_KEY', 'OPENRAG_API_KEY',
    'WORKBENCH_API_KEY', 'WORKBENCH_WORKSPACE_ID', 'WORKBENCH_DEFAULT_AGENT_ID',
    'WORKBENCH_CHUNKING_SERVICE_ID', 'WORKBENCH_DEFAULT_EMBEDDING_SERVICE_ID',
    'OPENROUTER_API_KEY', 'ASTRA_DB_API_ENDPOINT', 'ASTRA_DB_APPLICATION_TOKEN',
    'ELEVENLABS_API_KEY',
  ].filter((k) => !(k in overrides))

  if (set.length)     log.ok(`Keys set:     ${chalk.green(set.join(', '))}`)
  if (skipped.length) log.info(`Skipped:      ${chalk.dim(skipped.join(', '))}`)
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
      // Give the OS a moment to release the port before we bind it again
      await sleep(1000)
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

// ─── helpers ─────────────────────────────────────────────────────────────────

// Download a URL to a local file path using fetch
async function downloadFile(url, dest) {
  const spinner = ora(`Downloading ${chalk.dim(path.basename(dest))}…`).start()
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
    fs.writeFileSync(dest, await res.text(), 'utf8')
    spinner.succeed(`Downloaded ${chalk.dim(path.basename(dest))}`)
  } catch (err) {
    spinner.fail(`Failed to download ${url}`)
    throw err
  }
}

// Replace (or append) a KEY=value line in an env file
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

// Run `docker compose up -d` in a directory, streaming output
function runDockerCompose(cwd) {
  log.info(`Running docker compose up -d`)
  log.info(`  Working dir  ${chalk.dim(cwd)}`)
  log.nl()
  const child = spawn('docker', ['compose', 'up', '-d'], { cwd, stdio: 'inherit' })
  return waitForChild(child, 'docker compose up -d')
}

// Promise wrapper for a child process — rejects on non-zero exit
function waitForChild(child, label) {
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => {
      if (code === 0 || code === null) resolve()
      else reject(new Error(`${label} exited with code ${code}`))
    })
    child.on('error', reject)
  })
}

// Poll a health endpoint every 5 s up to `maxSeconds`, with a braille spinner
async function pollHealth(baseUrl, suffix, label, maxSeconds) {
  const deadline = Date.now() + maxSeconds * 1000
  const spinner  = ora(`Starting ${label}…`).start()
  let elapsed    = 0

  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 4000)
      const res = await fetch(`${baseUrl}${suffix}`, { signal: ctrl.signal })
      clearTimeout(timer)
      if (res.ok) {
        spinner.succeed(`${label} is ready  ${chalk.dim(`(${elapsed}s)`)}`)
        return
      }
    } catch {
      // not yet ready
    }
    await sleep(5000)
    elapsed += 5
    spinner.text = `Starting ${label}… ${chalk.dim(`(${elapsed}s elapsed)`)}`
  }

  spinner.fail(`${label} did not become ready within ${maxSeconds}s.`)
  log.warn(`Check logs: docker compose logs -f  (in the install directory)`)
  // Throw instead of process.exit so main() can still write .env.local before stopping.
  throw new Error(`${label} health check timed out after ${maxSeconds}s`)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
