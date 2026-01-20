/**
 * Module Graph for HMR
 *
 * Tracks import relationships and file change timestamps.
 * Used to determine which components need updating when a file changes,
 * and to rewrite imports with cache-busting timestamps.
 */

// =============================================================================
// Types
// =============================================================================

export interface ModuleGraph {
  /** Reverse dependency graph: file → Set of files that import it */
  importedBy: Map<string, Set<string>>
  /** Forward dependency graph: file → Set of files it imports */
  imports: Map<string, Set<string>>
  /** Last change timestamp for each file */
  changeTimestamps: Map<string, number>
  /** Set of files that are components (HMR boundaries) */
  componentFiles: Set<string>
}

// =============================================================================
// Graph Management
// =============================================================================

/**
 * Create a new empty module graph.
 *
 * @returns A new empty module graph
 */
export function createModuleGraph(): ModuleGraph {
  return {
    importedBy: new Map(),
    imports: new Map(),
    changeTimestamps: new Map(),
    componentFiles: new Set(),
  }
}

/**
 * Parse import paths from source code.
 * Only extracts local imports (starting with ./ or ../).
 *
 * @param source The source code to parse
 * @returns Array of import paths found
 */
export function parseImports(source: string): string[] {
  let imports: string[] = []

  // Match: import ... from './path' or import ... from "../path"
  // Also match: import './path' (side-effect imports)
  let importRegex = /import\s+(?:[^'"]*\s+from\s+)?['"](\.[^'"]+)['"]/g

  let match
  while ((match = importRegex.exec(source)) !== null) {
    imports.push(match[1])
  }

  return imports
}

/**
 * Resolve a relative import path to an absolute module URL.
 *
 * @param importPath The relative import path
 * @param fromFile The file doing the importing
 * @returns The resolved absolute module URL
 */
export function resolveImport(importPath: string, fromFile: string): string {
  // Get directory of the importing file
  let fromDir = fromFile.substring(0, fromFile.lastIndexOf('/'))

  // Handle ./ and ../ paths
  let parts = importPath.split('/')
  let resultParts = fromDir.split('/').filter(Boolean)

  for (let part of parts) {
    if (part === '.') {
      continue
    } else if (part === '..') {
      resultParts.pop()
    } else {
      resultParts.push(part)
    }
  }

  return '/' + resultParts.join('/')
}

/**
 * Track imports from a file and update the module graph.
 *
 * @param graph The module graph to update
 * @param filePath The path of the file being tracked
 * @param source The source code of the file
 */
export function trackImports(graph: ModuleGraph, filePath: string, source: string): void {
  let importPaths = parseImports(source)

  // Clear old imports for this file
  let oldImports = graph.imports.get(filePath)
  if (oldImports) {
    for (let oldImport of oldImports) {
      graph.importedBy.get(oldImport)?.delete(filePath)
    }
  }

  // Track new imports
  let resolvedImports = new Set<string>()
  for (let importPath of importPaths) {
    let resolved = resolveImport(importPath, filePath)
    resolvedImports.add(resolved)

    // Update reverse graph
    if (!graph.importedBy.has(resolved)) {
      graph.importedBy.set(resolved, new Set())
    }
    graph.importedBy.get(resolved)!.add(filePath)
  }

  graph.imports.set(filePath, resolvedImports)
}

/**
 * Mark a file as changed with a timestamp.
 *
 * @param graph The module graph to update
 * @param filePath The path of the changed file
 * @param timestamp The timestamp of the change
 */
export function markFileChanged(graph: ModuleGraph, filePath: string, timestamp: number): void {
  graph.changeTimestamps.set(filePath, timestamp)
}

/**
 * Get the change timestamp for a file.
 *
 * @param graph The module graph to query
 * @param filePath The path of the file
 * @returns The timestamp of the last change, or undefined if not tracked
 */
export function getChangeTimestamp(graph: ModuleGraph, filePath: string): number | undefined {
  return graph.changeTimestamps.get(filePath)
}

/**
 * Mark a file as a component (HMR boundary).
 *
 * @param graph The module graph to update
 * @param filePath The path of the component file
 */
export function markAsComponent(graph: ModuleGraph, filePath: string): void {
  graph.componentFiles.add(filePath)
}

/**
 * Check if a file is a component (HMR boundary).
 *
 * @param graph The module graph to query
 * @param filePath The path of the file
 * @returns True if the file is a component
 */
export function isComponentFile(graph: ModuleGraph, filePath: string): boolean {
  return graph.componentFiles.has(filePath)
}

// =============================================================================
// Import Rewriting
// =============================================================================

/**
 * Rewrite imports in source code to include timestamps for changed dependencies.
 * This ensures the browser fetches fresh versions of changed modules.
 *
 * @param graph The module graph with change timestamps
 * @param source The source code to rewrite
 * @param filePath The path of the file (for resolving relative imports)
 * @returns The source with rewritten imports
 */
export function rewriteImports(graph: ModuleGraph, source: string, filePath: string): string {
  // Match import statements and capture the path
  let importRegex = /(import\s+(?:[^'"]*\s+from\s+)?['"])(\.[^'"]+)(['"])/g

  return source.replace(importRegex, (match, before, importPath, after) => {
    // Strip query params for resolution
    let pathWithoutQuery = importPath.split('?')[0]
    let resolved = resolveImport(pathWithoutQuery, filePath)
    let timestamp = graph.changeTimestamps.get(resolved)

    if (timestamp) {
      // Add or update timestamp query param
      let separator = importPath.includes('?') ? '&' : '?'
      return `${before}${importPath}${separator}t=${timestamp}${after}`
    }

    return match
  })
}

// =============================================================================
// Graph Walking - Find Affected Components
// =============================================================================

/**
 * Find all components affected by a file change.
 * Walks up the import graph until it finds component boundaries.
 *
 * @param graph The module graph to traverse
 * @param changedFile The path of the changed file
 * @returns Array of component file paths that need updating
 */
export function findAffectedComponents(graph: ModuleGraph, changedFile: string): string[] {
  let affected = new Set<string>()
  let visited = new Set<string>()
  let queue = [changedFile]

  while (queue.length > 0) {
    let file = queue.shift()!

    if (visited.has(file)) continue
    visited.add(file)

    // If this file is a component, it's an HMR boundary - stop here
    if (graph.componentFiles.has(file)) {
      affected.add(file)
      continue // Don't bubble further
    }

    // Otherwise, bubble up to all importers
    let importers = graph.importedBy.get(file)
    if (importers) {
      for (let importer of importers) {
        queue.push(importer)
      }
    }
  }

  return [...affected]
}
