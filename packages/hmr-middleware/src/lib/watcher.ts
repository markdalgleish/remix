/**
 * File Watcher for HMR
 *
 * Watches a directory for file changes and notifies subscribers.
 * Uses chokidar for reliable cross-platform file watching.
 */

import * as path from 'node:path'
import { watch, type FSWatcher } from 'chokidar'

export interface WatcherOptions {
  /** Directory to watch (absolute path) */
  root: string
  /** Debounce delay in milliseconds (default: 100) */
  debounce?: number
  /** File extensions to watch (default: ['.js', '.jsx', '.ts', '.tsx', '.css']) */
  extensions?: string[]
}

export interface FileChangeEvent {
  /** The relative path from root (e.g., 'app/Counter.js') */
  relativePath: string
  /** The absolute file path on disk */
  filePath: string
  /** Timestamp of the change */
  timestamp: number
}

export type FileChangeCallback = (event: FileChangeEvent) => void

export interface HmrWatcher {
  /** Start watching for file changes */
  start(): void
  /** Stop watching */
  stop(): Promise<void>
  /** Register a callback for file changes */
  onFileChange(callback: FileChangeCallback): void
}

/**
 * Create a file watcher for HMR.
 *
 * @param options The watcher configuration options
 * @returns An HMR file watcher
 */
export function createWatcher(options: WatcherOptions): HmrWatcher {
  let {
    root,
    debounce: debounceMs = 100,
    extensions = ['.js', '.jsx', '.ts', '.tsx', '.css'],
  } = options

  let watcher: FSWatcher | null = null
  let callbacks: FileChangeCallback[] = []

  // Debounce state: track pending changes
  let pendingChanges = new Map<string, NodeJS.Timeout>()

  function handleChange(filePath: string) {
    // Check extension
    let ext = path.extname(filePath)
    if (!extensions.includes(ext)) {
      return
    }

    // Debounce: clear any pending timeout for this file
    let existing = pendingChanges.get(filePath)
    if (existing) {
      clearTimeout(existing)
    }

    // Schedule the actual notification
    let timeout = setTimeout(() => {
      pendingChanges.delete(filePath)

      // Calculate relative path from root
      let relativePath = path.relative(root, filePath)
      // Normalize to forward slashes
      relativePath = relativePath.split(path.sep).join('/')

      let event: FileChangeEvent = {
        relativePath,
        filePath,
        timestamp: Date.now(),
      }

      // Notify all callbacks
      for (let callback of callbacks) {
        try {
          callback(event)
        } catch (error) {
          console.error('[HMR] Error in file change callback:', error)
        }
      }
    }, debounceMs)

    pendingChanges.set(filePath, timeout)
  }

  return {
    start() {
      if (watcher) return // Already started

      watcher = watch(root, {
        ignoreInitial: true,
        ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
      })

      watcher.on('change', handleChange)
      watcher.on('add', handleChange)

      console.log(`[HMR] Watching ${root} for changes...`)
    },

    async stop() {
      // Clear any pending debounced changes
      for (let timeout of pendingChanges.values()) {
        clearTimeout(timeout)
      }
      pendingChanges.clear()

      if (watcher) {
        await watcher.close()
        watcher = null
      }
    },

    onFileChange(callback: FileChangeCallback) {
      callbacks.push(callback)
    },
  }
}
