import { ToolSecurityPolicy, ValidationResult } from './ToolSecurityTypes.js';

/**
 * Validates tool inputs against a security policy, checking for size limits,
 * forbidden patterns, null bytes, encoded traversal, and allowlisted paths/hosts.
 */
export class InputValidator {
  /**
   * Validate tool input against the given security policy.
   *
   * @param input - The raw input arguments to validate
   * @param policy - The security policy to enforce
   * @returns Validation result with errors or sanitized input
   */
  async validate(
    input: any,
    policy: ToolSecurityPolicy
  ): Promise<ValidationResult> {
    const errors: string[] = [];

    const inputStr = JSON.stringify(input);
    const inputSize = inputStr.length;
    const maxSize = policy.inputValidation?.maxInputSize ?? 1024 * 1024;
    if (inputSize > maxSize) {
      errors.push(`Input size (${inputSize} bytes) exceeds limit (${maxSize} bytes)`);
    }

    if (inputStr.includes('\x00') || inputStr.includes('\\u0000')) {
      errors.push('Input contains null bytes');
    }

    const decodedInput = this.decodeInputForCheck(inputStr);
    if (decodedInput !== inputStr) {
      const defaultTraversalPattern = /\.\.\//;
      if (defaultTraversalPattern.test(decodedInput)) {
        errors.push('Input contains encoded path traversal');
      }
    }

    const forbiddenPatterns = policy.inputValidation?.forbiddenPatterns ?? [];
    for (const pattern of forbiddenPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(inputStr)) {
        errors.push(`Input contains forbidden pattern: ${pattern}`);
      } else {
        pattern.lastIndex = 0;
        const rawValues = this.extractRawStringValues(input);
        for (const rawVal of rawValues) {
          pattern.lastIndex = 0;
          if (pattern.test(rawVal)) {
            errors.push(`Input contains forbidden pattern: ${pattern}`);
            break;
          }
        }
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return { valid: true, sanitizedInput: input };
  }

  /**
   * Check whether path-like values in arguments fall within the allowlist.
   *
   * @param args - Tool arguments that may contain path values
   * @param allowedPaths - Allowed path prefixes (use '*' for wildcard)
   * @returns Whether all paths are allowed, with reason on denial
   */
  checkPathAllowlist(
    args: Record<string, any>,
    allowedPaths: string[]
  ): { allowed: boolean; reason?: string } {
    if (allowedPaths.includes('*')) {
      return { allowed: true };
    }

    if (allowedPaths.length === 0) {
      return { allowed: false, reason: 'Empty allowlist blocks all paths' };
    }

    const paths = this.extractPaths(args);

    for (const path of paths) {
      const isAllowed = allowedPaths.some(allowed => path.startsWith(allowed));
      if (!isAllowed) {
        return { allowed: false, reason: `${path} not in allowlist` };
      }
    }

    return { allowed: true };
  }

  /**
   * Check whether URL/host values in arguments fall within the allowlist.
   *
   * @param args - Tool arguments that may contain URLs
   * @param allowedHosts - Allowed hostnames
   * @returns Whether all hosts are allowed, with reason on denial
   */
  checkHostAllowlist(
    args: Record<string, any>,
    allowedHosts: string[]
  ): { allowed: boolean; reason?: string } {
    const urls = this.extractUrls(args);

    for (const url of urls) {
      const hostname = this.extractHostname(url);
      if (hostname) {
        const isAllowed = allowedHosts.some(host => hostname === host);
        if (!isAllowed) {
          return { allowed: false, reason: `${hostname} not in allowlist` };
        }
      } else if (url.startsWith('http://') || url.startsWith('https://')) {
        return { allowed: false, reason: `Invalid URL: ${url}` };
      }
    }

    return { allowed: true };
  }

  /**
   * Check whether a tool name contains shell metacharacters that could
   * enable injection attacks.
   *
   * @param toolName - The tool name to validate
   * @returns Whether the tool name is safe
   */
  validateToolName(toolName: string): boolean {
    return !/[;&|`$(){}]/.test(toolName);
  }

  private decodeInputForCheck(input: string): string {
    try {
      return decodeURIComponent(input);
    } catch {
      return input;
    }
  }

  private extractRawStringValues(input: any): string[] {
    const values: string[] = [];
    if (typeof input === 'string') {
      values.push(input);
    } else if (input && typeof input === 'object') {
      for (const val of Object.values(input)) {
        if (typeof val === 'string') {
          values.push(val);
        } else if (val && typeof val === 'object') {
          values.push(...this.extractRawStringValues(val));
        }
      }
    }
    return values;
  }

  private extractPaths(args: Record<string, any>): string[] {
    const paths: string[] = [];
    const pathKeys = ['path', 'file', 'dir', 'directory', 'filepath', 'filename'];

    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string' && (pathKeys.includes(key.toLowerCase()) || value.startsWith('/'))) {
        paths.push(value);
      }
    }

    return paths;
  }

  private extractUrls(args: Record<string, any>): string[] {
    const urls: string[] = [];

    for (const [_key, value] of Object.entries(args)) {
      if (typeof value === 'string' && (value.startsWith('http://') || value.startsWith('https://'))) {
        urls.push(value);
      }
    }

    return urls;
  }

  private extractHostname(url: string): string | null {
    const match = url.match(/^https?:\/\/([^/:?#]+)/);
    return match ? match[1] : null;
  }
}
