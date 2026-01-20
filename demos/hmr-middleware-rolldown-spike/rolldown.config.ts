import { defineConfig } from 'rolldown'
import * as path from 'node:path'

let isDev = process.env.NODE_ENV !== 'production'

// Find the monorepo root (where packages/ lives)
let monorepoRoot = path.resolve(import.meta.dirname, '../..')

// Pure "preserve modules" spike - every module becomes its own file
// This demonstrates a bundler-free dev experience similar to Vite
export default defineConfig({
  input: {
    entry: 'app/assets/entry.tsx',
    Counter: 'app/assets/Counter.tsx',
    utils: 'app/assets/utils.ts',
  },
  output: {
    dir: 'public/assets',
    format: 'esm',
    preserveModules: true,
    // Strip the monorepo root so paths become relative
    // e.g. /Users/.../remix/packages/component/... → packages/component/...
    preserveModulesRoot: monorepoRoot,
    sourcemap: isDev ? 'inline' : false,
    minify: !isDev,
  },
  external: [
    // Dynamic imports reference built files
    /^\/assets\//,
  ],
  jsx: {
    mode: 'automatic',
    importSource: '@remix-run/component',
  },
})
