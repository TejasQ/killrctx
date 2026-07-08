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
const prompts = require('prompts')
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

  // 1. Detect what's already running
  const backends = await detectBackends()

  // 2. If nothing found, ensure Docker then install a backend
  if (!backends.openrag && !backends.workbench) {
    if (!opts['skip-docker']) {
      await ensureDocker()
    }
    await handleNoBackends(backends)
    // Re-detect after install so collectKeys() knows what's live
    const redetected = await detectBackends()
    backends.openrag      = redetected.openrag
    backends.workbench    = redetected.workbench
    backends.openragUrl   = redetected.openragUrl
    backends.workbenchUrl = redetected.workbenchUrl
  }

  // 3. Gather API keys
  const keys = await collectKeys(backends)

  // 4. Write .env.local
  await writeEnvLocal(backends, keys)

  // 5. Launch (unless skipped)
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
    const val = trimmed.slice(eq + 1).trim()
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

// ─── handleNoBackends ────────────────────────────────────────────────────────
// Offers to install OpenRAG or AI Workbench into sibling directories by
// downloading their docker-compose.yml and running `docker compose up -d`.
async function handleNoBackends(backends) {
  const { choice } = await prompts({
    type:    'select',
    name:    'choice',
    message: 'No backend detected. Install one automatically?',
    choices: [
      { title: `${chalk.bold('OpenRAG')}        ${chalk.dim('open-source · Docker · ~5 min')}`,  value: 'openrag' },
      { title: `${chalk.bold('AI Workbench')}   ${chalk.dim('DataStax · Docker · ~3 min')}`,     value: 'workbench' },
      { title: chalk.dim('Skip for now'),                                                          value: 'skip' },
    ],
  })

  if (!choice || choice === 'skip') {
    log.warn('Skipping backend install. Some features will be unavailable.')
    log.nl()
    return
  }

  if (choice === 'openrag') {
    await installOpenRAG(backends)
  } else {
    await installWorkbench(backends)
  }
}

async function installOpenRAG(backends) {
  const dir = path.resolve(ROOT, '..', 'openrag')
  fs.mkdirSync(dir, { recursive: true })
  log.info(`Installing OpenRAG → ${chalk.dim(dir)}`)
  log.nl()

  // Download compose + env
  await downloadFile(
    'https://raw.githubusercontent.com/langflow-ai/openrag/main/docker-compose.yml',
    path.join(dir, 'docker-compose.yml')
  )
  await downloadFile(
    'https://raw.githubusercontent.com/langflow-ai/openrag/main/.env.example',
    path.join(dir, '.env')
  )

  // Need OpenAI key for OpenRAG to be useful
  const { openaiKey } = await prompts({
    type:    'invisible',
    name:    'openaiKey',
    message: 'OpenAI API key for OpenRAG (from platform.openai.com/api-keys):',
  })
  if (openaiKey) {
    injectEnvValue(path.join(dir, '.env'), 'OPENAI_API_KEY', openaiKey)
  }

  // Boot
  await runDockerCompose(dir)
  await pollHealth(backends.openragUrl, '/health', 'OpenRAG', 300)
  log.ok('OpenRAG is running.')
  log.nl()
}

async function installWorkbench(backends) {
  const dir = path.resolve(ROOT, '..', 'ai-workbench')
  fs.mkdirSync(dir, { recursive: true })
  log.info(`Installing AI Workbench → ${chalk.dim(dir)}`)
  log.nl()

  await downloadFile(
    'https://raw.githubusercontent.com/datastax/ai-workbench/main/docker-compose.yml',
    path.join(dir, 'docker-compose.yml')
  )

  await runDockerCompose(dir)
  await pollHealth(backends.workbenchUrl, '/healthz', 'AI Workbench', 180)
  log.ok('AI Workbench is running.')
  log.nl()
}

// ─── collectKeys ─────────────────────────────────────────────────────────────
// Gathers API keys via invisible prompts. Only asks for what's relevant
// based on which backends are detected.
async function collectKeys(backends) {
  log.rule()
  log.info('API keys — paste each one and press Enter. Leave blank to skip.')
  log.rule()
  log.nl()

  const questions = []

  if (backends.openrag) {
    questions.push({
      type:    'invisible',
      name:    'OPENAI_API_KEY',
      message: `OpenAI API key ${chalk.dim('(platform.openai.com/api-keys)')}:`,
    })
    questions.push({
      type:    'invisible',
      name:    'OPENRAG_API_KEY',
      message: `OpenRAG API key ${chalk.dim('(optional — leave blank for local installs)')}:`,
    })
  }

  if (backends.workbench) {
    questions.push({
      type:    'invisible',
      name:    'WORKBENCH_API_KEY',
      message: `AI Workbench API key ${chalk.dim('(optional — leave blank for local installs)')}:`,
    })
  }

  questions.push({
    type:    'invisible',
    name:    'ELEVENLABS_API_KEY',
    message: `ElevenLabs API key ${chalk.dim('(elevenlabs.io/app/settings/api-keys · optional)')}:`,
  })

  const answers = await prompts(questions)
  log.nl()
  return answers
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
  log.ok('.env.local written')

  const set     = Object.keys(overrides)
  const skipped = ['OPENAI_API_KEY', 'OPENRAG_API_KEY', 'WORKBENCH_API_KEY', 'ELEVENLABS_API_KEY']
    .filter((k) => !(k in overrides))

  if (set.length)     log.ok(`Keys set:     ${chalk.green(set.join(', '))}`)
  if (skipped.length) log.info(`Skipped:      ${chalk.dim(skipped.join(', '))}`)
  log.nl()
}

// ─── launchApp ───────────────────────────────────────────────────────────────
async function launchApp() {
  log.rule()
  console.log(` ${chalk.bold.cyan('Starting killrctx')} → ${chalk.underline('http://localhost:3001')}`)
  log.rule()
  log.nl()

  const child = spawn('npm', ['run', 'dev'], { stdio: 'inherit', cwd: ROOT })
  process.on('SIGINT',  () => child.kill('SIGINT'))
  process.on('SIGTERM', () => child.kill('SIGTERM'))
  child.on('exit', (code) => process.exit(code ?? 0))
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
  log.info('Running docker compose up -d …')
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
  process.exit(1)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
