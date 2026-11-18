import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { createServer, ListenOptions, Server } from 'node:net'
import { basename, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** A shared snapshot whose read/modify/write transactions are serialized across extension hosts. */
export class SharedJsonStorage<T> {
  private readonly directory: string
  private readonly filename: string
  private readonly path: string

  constructor(directory: string, filename = 'monthly-profit-ledger.json') {
    if (!filename || basename(filename) !== filename || filename === '.' || filename === '..') {
      throw new Error('Shared storage filename must be a file name')
    }
    this.directory = resolve(directory)
    this.filename = filename
    this.path = join(this.directory, filename)
  }

  read(): T | undefined {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      // A damaged or inaccessible ledger must never be mistaken for a new account.
      throw error
    }
  }

  /** Call inside runExclusive when updating a value derived from an existing snapshot. */
  async write(value: T): Promise<void> {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error('Shared storage value must be JSON serializable')
    await mkdir(this.directory, { recursive: true })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(serialized, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      // Readers see either complete snapshot, including while another window is rendering.
      await rename(temporary, this.path)
    } finally {
      await unlink(temporary).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
  }

  private async lockAddress(): Promise<ListenOptions> {
    await mkdir(this.directory, { recursive: true })
    let identity = join(await realpath(this.directory), this.filename)
    if (process.platform === 'win32') identity = identity.toLowerCase()
    const digest = createHash('sha256').update(identity).digest()
    const name = `money-glitch-${digest.toString('hex')}`
    if (process.platform === 'win32') return { path: `\\\\.\\pipe\\${name}`, exclusive: true }
    if (process.platform === 'linux') return { path: `\0${name}`, exclusive: true }
    // Other platforms lack abstract sockets; an OS-owned loopback port avoids stale socket files.
    // A rare hash collision only serializes unrelated stores, or safely times out if a port is busy.
    return { host: '127.0.0.1', port: 49152 + digest.readUInt16BE(0) % 16384, exclusive: true }
  }

  private async acquire(): Promise<Server> {
    const address = await this.lockAddress()
    const deadline = performance.now() + 15000
    while (true) {
      const server = createServer(socket => socket.destroy())
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => reject(error)
          server.once('error', onError)
          server.listen(address, () => {
            server.off('error', onError)
            resolve()
          })
        })
        return server
      } catch (error) {
        server.close()
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
        if (performance.now() >= deadline) throw new Error('等待其他窗口保存月收益超时，请稍后重试')
        await delay(25 + Math.floor(Math.random() * 51))
      }
    }
  }

  async runExclusive(operation: () => Promise<void>): Promise<void> {
    const lock = await this.acquire()
    try {
      await operation()
    } finally {
      // The operating system also releases this lock if an extension host crashes.
      await new Promise<void>((resolve, reject) => lock.close(error => error ? reject(error) : resolve()))
    }
  }
}
