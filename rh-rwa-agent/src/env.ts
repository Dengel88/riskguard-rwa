import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECT_ROOT, WORKSPACE_ROOT } from './config.js'

export function loadDotEnv(): void {
  const candidates = [resolve(PROJECT_ROOT, '.env'), resolve(WORKSPACE_ROOT, '.env')]
  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue
    const lines = readFileSync(filePath, 'utf-8').split(/\r?\n/)
    for (const raw of lines) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      const val = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
      if (key && process.env[key] === undefined) {
        process.env[key] = val
      }
    }
  }
}
