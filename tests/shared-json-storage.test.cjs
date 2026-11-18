const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, readdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve, sep } = require('node:path')
const { spawn } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const { SharedJsonStorage } = require('../out/utils/shared-json-storage')

function fixture(t) {
  const parent = resolve(tmpdir())
  const directory = mkdtempSync(join(parent, 'money-glitch-shared-'))
  t.after(() => {
    assert.ok(resolve(directory).startsWith(parent + sep))
    rmSync(directory, { recursive: true, force: true })
  })
  return { directory, storage: new SharedJsonStorage(directory) }
}

const childSource = `
  const { SharedJsonStorage } = require(process.env.SHARED_STORAGE_MODULE)
  const { setTimeout: delay } = require('node:timers/promises')
  const storage = new SharedJsonStorage(process.argv[1])
  async function main() {
    if (process.argv[2] === 'hold') {
      await storage.runExclusive(async () => {
        process.send('acquired')
        await new Promise(resolve => process.once('message', resolve))
      })
    } else {
      for (let i = 0; i < 8; i++) {
        await storage.runExclusive(async () => {
          const previous = storage.read()?.count ?? 0
          await delay(2)
          await storage.write({ count: previous + 1 })
        })
      }
    }
    process.send('done')
    process.disconnect()
  }
  main().catch(error => { console.error(error); process.exit(1) })
`

function startChild(t, directory, mode = 'increment') {
  const child = spawn(process.execPath, ['-e', childSource, directory, mode], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, SHARED_STORAGE_MODULE: require.resolve('../out/utils/shared-json-storage') }
  })
  let errors = ''
  child.stderr.on('data', data => { errors += data })
  const messages = []
  child.on('message', value => messages.push(value))
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal, errors }))
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
  })
  return { child, exited, messages }
}

test('independent storage instances serialize read-modify-write transactions', async t => {
  const { directory, storage } = fixture(t)
  const writers = Array.from({ length: 4 }, () => new SharedJsonStorage(directory))
  await Promise.all(writers.map(async writer => {
    for (let i = 0; i < 5; i++) {
      await writer.runExclusive(async () => {
        const current = writer.read()?.count ?? 0
        await delay(1)
        await writer.write({ count: current + 1 })
      })
    }
  }))
  assert.deepEqual(storage.read(), { count: 20 })
  assert.deepEqual(readdirSync(directory), ['monthly-profit-ledger.json'])
})

test('separate processes share the mutex and preserve all updates', { timeout: 15000 }, async t => {
  const { directory, storage } = fixture(t)
  const children = Array.from({ length: 3 }, () => startChild(t, directory))
  const exits = await Promise.all(children.map(child => child.exited))
  for (const exit of exits) assert.equal(exit.code, 0, exit.errors)
  assert.deepEqual(storage.read(), { count: 24 })
})

test('a crashed lock holder releases the mutex without deleting a stale lock file', { timeout: 15000 }, async t => {
  const { directory, storage } = fixture(t)
  const holder = startChild(t, directory, 'hold')
  await new Promise((resolve, reject) => {
    holder.child.once('message', value => value === 'acquired' ? resolve() : reject(new Error('Unexpected message')))
    holder.child.once('exit', () => reject(new Error('Lock holder exited before acquiring')))
    holder.child.once('error', reject)
  })
  let entered = false
  const waiting = storage.runExclusive(async () => {
    entered = true
    await storage.write({ recovered: true })
  })
  await delay(100)
  assert.equal(entered, false)
  holder.child.kill('SIGKILL')
  await holder.exited
  await waiting
  assert.equal(entered, true)
  assert.deepEqual(storage.read(), { recovered: true })
})

test('a rejected operation releases the lock; corrupt JSON is not treated as an empty store', async t => {
  const { directory, storage } = fixture(t)
  assert.equal(storage.read(), undefined)
  await assert.rejects(storage.runExclusive(async () => { throw new Error('failed transaction') }), /failed transaction/)
  await storage.runExclusive(() => storage.write({ count: 1 }))
  assert.deepEqual(storage.read(), { count: 1 })
  writeFileSync(join(directory, 'monthly-profit-ledger.json'), '{broken')
  assert.throws(() => storage.read(), SyntaxError)
  assert.deepEqual(readdirSync(directory), ['monthly-profit-ledger.json'])
})

test('readers observe only complete snapshots while atomic replacements are in progress', async t => {
  const { directory, storage } = fixture(t)
  const reader = new SharedJsonStorage(directory)
  const errors = []
  const inspect = () => {
    try {
      const snapshot = reader.read()
      if (snapshot) {
        assert.equal(snapshot.payload, String(snapshot.revision).repeat(4096))
      }
    } catch (error) { errors.push(error) }
  }
  const timer = setInterval(inspect, 1)
  try {
    for (let revision = 0; revision < 20; revision++) {
      await storage.runExclusive(() => storage.write({ revision, payload: String(revision).repeat(4096) }))
    }
  } finally {
    clearInterval(timer)
  }
  inspect()
  assert.deepEqual(errors, [])
  assert.equal(reader.read().revision, 19)
})
