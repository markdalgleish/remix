import * as assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import {
  createModuleGraph,
  parseImports,
  resolveImport,
  trackImports,
  markFileChanged,
  getChangeTimestamp,
  markAsComponent,
  isComponentFile,
  rewriteImports,
  findAffectedComponents,
  type ModuleGraph,
} from './module-graph.ts'

describe('Module Graph', () => {
  let graph: ModuleGraph

  beforeEach(() => {
    graph = createModuleGraph()
  })

  // ===========================================================================
  // Import Parsing
  // ===========================================================================

  describe('parseImports', () => {
    it('parses named imports', () => {
      let source = `import { helper } from './utils.ts'`
      assert.deepEqual(parseImports(source), ['./utils.ts'])
    })

    it('parses default imports', () => {
      let source = `import Counter from './Counter.tsx'`
      assert.deepEqual(parseImports(source), ['./Counter.tsx'])
    })

    it('parses namespace imports', () => {
      let source = `import * as utils from './utils.ts'`
      assert.deepEqual(parseImports(source), ['./utils.ts'])
    })

    it('parses side-effect imports', () => {
      let source = `import './styles.css'`
      assert.deepEqual(parseImports(source), ['./styles.css'])
    })

    it('parses multiple imports', () => {
      let source = `
        import { helper } from './utils.ts'
        import Counter from './Counter.tsx'
        import './styles.css'
      `
      assert.deepEqual(parseImports(source), ['./utils.ts', './Counter.tsx', './styles.css'])
    })

    it('parses parent directory imports', () => {
      let source = `import { shared } from '../shared/utils.ts'`
      assert.deepEqual(parseImports(source), ['../shared/utils.ts'])
    })

    it('ignores external package imports', () => {
      let source = `
        import { Handle } from '@remix-run/component'
        import React from 'react'
        import { helper } from './utils.ts'
      `
      assert.deepEqual(parseImports(source), ['./utils.ts'])
    })

    it('handles double quotes', () => {
      let source = `import { helper } from "./utils.ts"`
      assert.deepEqual(parseImports(source), ['./utils.ts'])
    })
  })

  // ===========================================================================
  // Import Resolution
  // ===========================================================================

  describe('resolveImport', () => {
    it('resolves same-directory import', () => {
      assert.equal(resolveImport('./utils.ts', '/app/Counter.tsx'), '/app/utils.ts')
    })

    it('resolves parent directory import', () => {
      assert.equal(
        resolveImport('../shared/utils.ts', '/app/components/Counter.tsx'),
        '/app/shared/utils.ts',
      )
    })

    it('resolves nested import', () => {
      assert.equal(resolveImport('./lib/helpers.ts', '/app/utils.ts'), '/app/lib/helpers.ts')
    })

    it('resolves multiple parent traversals', () => {
      assert.equal(
        resolveImport('../../utils.ts', '/app/components/ui/Button.tsx'),
        '/app/utils.ts',
      )
    })
  })

  // ===========================================================================
  // Graph Tracking
  // ===========================================================================

  describe('trackImports', () => {
    it('builds reverse dependency graph', () => {
      trackImports(graph, '/app/Counter.tsx', `import { helper } from './utils.ts'`)

      assert.ok(graph.importedBy.get('/app/utils.ts')?.has('/app/Counter.tsx'))
    })

    it('tracks multiple importers', () => {
      trackImports(graph, '/app/Counter.tsx', `import { helper } from './utils.ts'`)
      trackImports(graph, '/app/Dashboard.tsx', `import { format } from './utils.ts'`)

      let importers = graph.importedBy.get('/app/utils.ts')
      assert.ok(importers?.has('/app/Counter.tsx'))
      assert.ok(importers?.has('/app/Dashboard.tsx'))
    })

    it('tracks forward dependencies', () => {
      trackImports(
        graph,
        '/app/Counter.tsx',
        `
        import { helper } from './utils.ts'
        import { Button } from './Button.tsx'
      `,
      )

      let imports = graph.imports.get('/app/Counter.tsx')
      assert.ok(imports?.has('/app/utils.ts'))
      assert.ok(imports?.has('/app/Button.tsx'))
    })

    it('updates graph when imports change', () => {
      // Initial imports
      trackImports(graph, '/app/Counter.tsx', `import { helper } from './utils.ts'`)
      assert.ok(graph.importedBy.get('/app/utils.ts')?.has('/app/Counter.tsx'))

      // Update imports (removed utils, added other)
      trackImports(graph, '/app/Counter.tsx', `import { other } from './other.ts'`)

      // utils.ts should no longer have Counter as importer
      assert.ok(!graph.importedBy.get('/app/utils.ts')?.has('/app/Counter.tsx'))
      // other.ts should have Counter as importer
      assert.ok(graph.importedBy.get('/app/other.ts')?.has('/app/Counter.tsx'))
    })
  })

  // ===========================================================================
  // Timestamps
  // ===========================================================================

  describe('timestamps', () => {
    it('tracks file change timestamps', () => {
      markFileChanged(graph, '/app/utils.ts', 123)
      assert.equal(getChangeTimestamp(graph, '/app/utils.ts'), 123)
    })

    it('returns undefined for unchanged files', () => {
      assert.equal(getChangeTimestamp(graph, '/app/utils.ts'), undefined)
    })

    it('updates timestamp on subsequent changes', () => {
      markFileChanged(graph, '/app/utils.ts', 100)
      markFileChanged(graph, '/app/utils.ts', 200)
      assert.equal(getChangeTimestamp(graph, '/app/utils.ts'), 200)
    })
  })

  // ===========================================================================
  // Component Detection
  // ===========================================================================

  describe('component detection', () => {
    it('marks files as components', () => {
      markAsComponent(graph, '/app/Counter.tsx')
      assert.equal(isComponentFile(graph, '/app/Counter.tsx'), true)
    })

    it('returns false for non-components', () => {
      assert.equal(isComponentFile(graph, '/app/utils.ts'), false)
    })
  })

  // ===========================================================================
  // Import Rewriting
  // ===========================================================================

  describe('rewriteImports', () => {
    it('rewrites imports for changed dependencies', () => {
      markFileChanged(graph, '/app/utils.ts', 123)

      let source = `import { helper } from './utils.ts'`
      let rewritten = rewriteImports(graph, source, '/app/Counter.tsx')

      assert.equal(rewritten, `import { helper } from './utils.ts?t=123'`)
    })

    it('does not rewrite imports for unchanged dependencies', () => {
      let source = `import { helper } from './utils.ts'`
      let rewritten = rewriteImports(graph, source, '/app/Counter.tsx')

      assert.equal(rewritten, `import { helper } from './utils.ts'`)
    })

    it('rewrites only changed dependencies', () => {
      markFileChanged(graph, '/app/utils.ts', 123)

      let source = `
import { helper } from './utils.ts'
import { Button } from './Button.tsx'
      `.trim()

      let rewritten = rewriteImports(graph, source, '/app/Counter.tsx')

      assert.ok(rewritten.includes(`from './utils.ts?t=123'`))
      assert.ok(rewritten.includes(`from './Button.tsx'`))
      assert.ok(!rewritten.includes(`Button.tsx?t=`))
    })

    it('handles imports with existing query params', () => {
      markFileChanged(graph, '/app/utils.ts', 123)

      let source = `import { helper } from './utils.ts?foo=bar'`
      let rewritten = rewriteImports(graph, source, '/app/Counter.tsx')

      assert.equal(rewritten, `import { helper } from './utils.ts?foo=bar&t=123'`)
    })

    it('rewrites default imports', () => {
      markFileChanged(graph, '/app/Counter.tsx', 456)

      let source = `import Counter from './Counter.tsx'`
      let rewritten = rewriteImports(graph, source, '/app/App.tsx')

      assert.equal(rewritten, `import Counter from './Counter.tsx?t=456'`)
    })

    it('rewrites side-effect imports', () => {
      markFileChanged(graph, '/app/styles.css', 789)

      let source = `import './styles.css'`
      let rewritten = rewriteImports(graph, source, '/app/Counter.tsx')

      assert.equal(rewritten, `import './styles.css?t=789'`)
    })
  })

  // ===========================================================================
  // Finding Affected Components
  // ===========================================================================

  describe('findAffectedComponents', () => {
    it('finds direct component importers', () => {
      // Setup: Counter imports utils
      trackImports(graph, '/app/Counter.tsx', `import { helper } from './utils.ts'`)
      markAsComponent(graph, '/app/Counter.tsx')

      let affected = findAffectedComponents(graph, '/app/utils.ts')
      assert.deepEqual(affected, ['/app/Counter.tsx'])
    })

    it('bubbles through non-component files', () => {
      // Setup: Counter → utils → helpers
      trackImports(graph, '/app/Counter.tsx', `import { format } from './utils.ts'`)
      trackImports(graph, '/app/utils.ts', `import { helper } from './helpers.ts'`)
      markAsComponent(graph, '/app/Counter.tsx')

      // helpers.ts changed
      let affected = findAffectedComponents(graph, '/app/helpers.ts')
      assert.deepEqual(affected, ['/app/Counter.tsx'])
    })

    it('stops at component boundaries', () => {
      // Setup: App → Counter → utils
      trackImports(graph, '/app/App.tsx', `import Counter from './Counter.tsx'`)
      trackImports(graph, '/app/Counter.tsx', `import { helper } from './utils.ts'`)
      markAsComponent(graph, '/app/App.tsx')
      markAsComponent(graph, '/app/Counter.tsx')

      // utils.ts changed - should affect Counter but NOT App
      let affected = findAffectedComponents(graph, '/app/utils.ts')
      assert.deepEqual(affected, ['/app/Counter.tsx'])
      assert.ok(!affected.includes('/app/App.tsx'))
    })

    it('handles multiple affected components', () => {
      // Setup: Counter and Dashboard both import utils
      trackImports(graph, '/app/Counter.tsx', `import { helper } from './utils.ts'`)
      trackImports(graph, '/app/Dashboard.tsx', `import { format } from './utils.ts'`)
      markAsComponent(graph, '/app/Counter.tsx')
      markAsComponent(graph, '/app/Dashboard.tsx')

      let affected = findAffectedComponents(graph, '/app/utils.ts')
      assert.ok(affected.includes('/app/Counter.tsx'))
      assert.ok(affected.includes('/app/Dashboard.tsx'))
      assert.equal(affected.length, 2)
    })

    it('handles diamond dependencies', () => {
      // Setup: Counter → [utils, helpers], utils → helpers
      trackImports(
        graph,
        '/app/Counter.tsx',
        `
        import { format } from './utils.ts'
        import { helper } from './helpers.ts'
      `,
      )
      trackImports(graph, '/app/utils.ts', `import { helper } from './helpers.ts'`)
      markAsComponent(graph, '/app/Counter.tsx')

      // helpers.ts changed - should affect Counter once (not twice)
      let affected = findAffectedComponents(graph, '/app/helpers.ts')
      assert.deepEqual(affected, ['/app/Counter.tsx'])
    })

    it('returns empty array for files with no importers', () => {
      let affected = findAffectedComponents(graph, '/app/orphan.ts')
      assert.deepEqual(affected, [])
    })

    it('includes the changed file if it is a component', () => {
      // Counter.tsx itself changed
      markAsComponent(graph, '/app/Counter.tsx')

      let affected = findAffectedComponents(graph, '/app/Counter.tsx')
      assert.deepEqual(affected, ['/app/Counter.tsx'])
    })
  })
})
