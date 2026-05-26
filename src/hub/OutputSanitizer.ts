import { ToolSecurityPolicy } from './ToolSecurityTypes.js';

/** Result of output sanitization. */
export interface SanitizeResult {
  /** The sanitized output data. */
  data: any;

  /** Whether output was truncated. */
  truncated: boolean;

  /** Original serialized size in bytes. */
  originalSize: number;

  /** Sanitized serialized size in bytes. */
  truncatedSize: number;

  /** Non-fatal warnings generated during sanitization. */
  warnings?: string[];
}

/**
 * Sanitizes tool output by enforcing size limits, redacting forbidden patterns,
 * and providing masked copies for audit logging.
 */
export class OutputSanitizer {
  /**
   * Sanitize tool output according to the security policy.
   *
   * Truncates oversized output and redacts matches of forbidden patterns.
   *
   * @param output - Raw tool output to sanitize
   * @param policy - Security policy governing output limits
   * @returns Sanitized result with metadata about transformations applied
   */
  sanitize(output: any, policy: ToolSecurityPolicy): SanitizeResult {
    const warnings: string[] = [];
    let truncated = false;

    const outputStr = JSON.stringify(output);
    const originalSize = outputStr.length;
    const maxSize = policy.outputLimits?.maxOutputSize ?? 1024 * 1024;

    let sanitized = output;

    if (originalSize > maxSize) {
      sanitized = outputStr.substring(0, maxSize) + '... [truncated]';
      truncated = true;
      warnings.push(`Output truncated from ${originalSize} to ${maxSize} bytes`);
    }

    const outputForbiddenPatterns = policy.outputLimits?.forbiddenPatterns ?? [];
    if (outputForbiddenPatterns.length > 0) {
      let sanitizedStr = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);
      for (const pattern of outputForbiddenPatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(sanitizedStr)) {
          pattern.lastIndex = 0;
          sanitizedStr = sanitizedStr.replace(pattern, '[REDACTED]');
          warnings.push(`Output contained forbidden pattern and was redacted`);
        }
      }
      sanitized = sanitizedStr;
    }

    return {
      data: sanitized,
      truncated,
      originalSize,
      truncatedSize: typeof sanitized === 'string' ? sanitized.length : JSON.stringify(sanitized).length,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Create a copy of data with sensitive fields replaced by '***'.
   *
   * Recursively traverses objects and replaces values at keys listed
   * in the policy's maskFields configuration.
   *
   * @param data - Data to mask
   * @param policy - Security policy specifying which fields to mask
   * @returns A shallow copy with sensitive fields masked
   */
  maskSensitive(data: any, policy: ToolSecurityPolicy): any {
    const maskFields = policy.audit?.maskFields ?? [];

    if (!data || typeof data !== 'object') {
      return data;
    }

    const masked = Array.isArray(data) ? [...data] : { ...data };

    for (const key of Object.keys(masked)) {
      if (maskFields.includes(key)) {
        masked[key] = '***';
      } else if (typeof masked[key] === 'object') {
        masked[key] = this.maskSensitive(masked[key], policy);
      }
    }

    return masked;
  }
}
