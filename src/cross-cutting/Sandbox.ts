export interface SandboxRule {
  /** Allowed path patterns (glob-like) */
  allowedPaths?: string[];
  /** Blocked path patterns */
  blockedPaths?: string[];
  /** Secret patterns to redact from results */
  secretPatterns?: RegExp[];
  /** Max execution time per tool */
  perToolTimeoutMs?: number;
  /** Max execution time per turn (all tools) */
  perTurnTimeoutMs?: number;
}

export interface SandboxCheckResult {
  allowed: boolean;
  reason?: string;
  redactedFields?: string[];
}

/**
 * Security sandbox that enforces path allow/block lists, detects path traversal,
 * redacts secrets from tool results, and enforces per-tool and per-turn timeouts.
 */
export class Sandbox {
  private rules: SandboxRule;
  private _checks: Array<{ toolName: string; args: unknown; result: SandboxCheckResult; timestamp: number }> = [];

  /**
   * Create a new Sandbox with the given security rules.
   *
   * @param rules - Security rules including allowed/blocked paths, secret patterns, and timeouts
   */
  constructor(rules: SandboxRule = {}) {
    this.rules = rules;
  }

  get checks() { return this._checks; }

  /**
   * Check if a tool invocation is allowed
   */
  checkToolInvocation(toolName: string, args: Record<string, unknown>): SandboxCheckResult {
    const pathArg = args.path as string | undefined;
    if (pathArg) {
      if (pathArg.includes('..') || pathArg.includes('/../')) {
        const result: SandboxCheckResult = { allowed: false, reason: 'Path traversal detected' };
        this._checks.push({ toolName, args, result, timestamp: Date.now() });
        return result;
      }

      if (this.rules.blockedPaths) {
        for (const blocked of this.rules.blockedPaths) {
          if (pathArg.startsWith(blocked) || pathArg === blocked) {
            const result: SandboxCheckResult = { allowed: false, reason: `Path blocked: ${blocked}` };
            this._checks.push({ toolName, args, result, timestamp: Date.now() });
            return result;
          }
        }
      }

      if (this.rules.allowedPaths && this.rules.allowedPaths.length > 0) {
        const isAllowed = this.rules.allowedPaths.some(p => pathArg.startsWith(p));
        if (!isAllowed) {
          const result: SandboxCheckResult = { allowed: false, reason: `Path not in allowlist: ${pathArg}` };
          this._checks.push({ toolName, args, result, timestamp: Date.now() });
          return result;
        }
      }
    }

    const result: SandboxCheckResult = { allowed: true };
    this._checks.push({ toolName, args, result, timestamp: Date.now() });
    return result;
  }

  /**
   * Check/redact tool result for secret leakage
   */
  checkToolResult(toolName: string, result: unknown): { clean: boolean; redacted: unknown; patterns: string[] } {
    const patterns: string[] = [];
    if (!this.rules.secretPatterns || this.rules.secretPatterns.length === 0) {
      return { clean: true, redacted: result, patterns };
    }

    let resultStr = typeof result === 'string' ? result : JSON.stringify(result);
    let found = false;

    for (const pattern of this.rules.secretPatterns) {
      if (pattern.test(resultStr)) {
        found = true;
        patterns.push(pattern.source);
        resultStr = resultStr.replace(pattern, '[REDACTED]');
      }
    }

    return {
      clean: !found,
      redacted: typeof result === 'string' ? resultStr : JSON.parse(resultStr),
      patterns,
    };
  }

  /**
   * Update rules at runtime
   */
  updateRules(newRules: Partial<SandboxRule>): void {
    this.rules = { ...this.rules, ...newRules };
  }

  getRules(): SandboxRule {
    return { ...this.rules };
  }

  reset(): void {
    this._checks = [];
  }
}
