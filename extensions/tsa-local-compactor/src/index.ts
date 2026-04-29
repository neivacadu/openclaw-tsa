/**
 * Public re-exports from the pure compactor module. Kept to avoid breaking
 * any consumer that still imports from "./src" or "./src/index". The SDK
 * entry point is /index.ts (definePluginEntry); the runtime adapter lives
 * at ./plugin.ts.
 */
export {
  compact,
  shouldCompact,
  estimateTokens,
  formatSummary,
  extractLastUserRequests,
  extractPendingWork,
  extractKeyFiles,
  inferCurrentWork,
  DEFAULT_CONFIG,
  type CompactConfig,
  type Message,
  type Role,
} from "./compact.js";
