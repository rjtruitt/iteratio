import { z } from 'zod';

/**
 * Security policy governing a tool's input validation, output limits,
 * execution constraints, rate limiting, audit logging, and RBAC requirements.
 */
export interface ToolSecurityPolicy {
  /** Tool name this policy applies to. */
  toolName: string;

  /** Input validation rules applied before tool execution. */
  inputValidation?: {
    /** JSON Schema for structural validation. */
    schema?: any;

    /** Zod schema for runtime type validation. */
    zodSchema?: z.ZodSchema<any>;

    /** Custom async validator for domain-specific rules. */
    customValidator?: (input: any) => Promise<ValidationResult>;

    /** Maximum serialized input size in bytes. */
    maxInputSize?: number;

    /** Regex patterns that must not appear in serialized input. */
    forbiddenPatterns?: RegExp[];
  };

  /** Constraints on tool output to prevent resource exhaustion. */
  outputLimits?: {
    /** Maximum serialized output size in bytes (default: 1MB). */
    maxOutputSize?: number;

    /** Maximum array length in output. */
    maxArrayLength?: number;

    /** Maximum object nesting depth in output. */
    maxObjectDepth?: number;

    /** Patterns that trigger redaction in output. */
    forbiddenPatterns?: RegExp[];
  };

  /** Execution environment constraints. */
  execution?: {
    /** Maximum execution time in milliseconds (default: 30000). */
    timeout?: number;

    /** Whether to run in a sandboxed environment. */
    sandbox?: boolean;

    /** Filesystem paths the tool is allowed to access. */
    allowedPaths?: string[];

    /** Network hosts the tool is allowed to contact. */
    allowedHosts?: string[];
  };

  /** Rate limiting thresholds. */
  rateLimit?: {
    /** Maximum requests per minute. */
    requestsPerMinute?: number;

    /** Maximum requests per hour. */
    requestsPerHour?: number;

    /** Maximum requests per day. */
    requestsPerDay?: number;

    /** Burst capacity above per-minute rate. */
    burstSize?: number;
  };

  /** Audit logging configuration. */
  audit?: {
    /** Whether to log all invocations. */
    logInvocations?: boolean;

    /** Whether to include input in audit logs (may contain secrets). */
    logInput?: boolean;

    /** Whether to include output in audit logs. */
    logOutput?: boolean;

    /** Whether to log errors. */
    logErrors?: boolean;

    /** Field names to mask with '***' in logs. */
    maskFields?: string[];
  };

  /** RBAC role names required to invoke this tool. Empty means unrestricted. */
  rbac?: string[];
}

/**
 * Result of input validation, indicating whether input passed checks
 * and providing sanitized input on success or error messages on failure.
 */
export interface ValidationResult {
  /** Whether the input passed all validation checks. */
  valid: boolean;

  /** Validation error messages (present when valid is false). */
  errors?: string[];

  /** The validated and potentially sanitized input (present when valid is true). */
  sanitizedInput?: any;
}

/**
 * A tool execution request enriched with security context including
 * requester identity, RBAC roles, and distributed consistency tokens.
 */
export interface SecureToolExecutionRequest {
  /** ID of the instance requesting tool execution. */
  requesterId: string;

  /** Name of the tool to execute. */
  toolName: string;

  /** Arguments to pass to the tool. */
  arguments: Record<string, any>;

  /** RBAC roles/contexts the requester holds. */
  rbacContext?: string[];

  /** Request metadata for tracing and attribution. */
  metadata?: {
    traceId?: string;
    userId?: string;
    appId?: string;
    [key: string]: any;
  };

  /** Fencing token for distributed consistency enforcement. */
  fencingToken?: number;
}

/**
 * Result of a secure tool execution, including the outcome, any security
 * annotations (truncation, warnings), and execution metadata.
 */
export interface SecureToolExecutionResult {
  /** Whether tool execution completed successfully. */
  success: boolean;

  /** Tool output data (sanitized). Present on success. */
  data?: any;

  /** Error description. Present on failure. */
  error?: string;

  /** Security-related annotations about the execution. */
  security?: {
    /** Whether output was truncated due to size limits. */
    outputTruncated?: boolean;

    /** Original output size in bytes before truncation. */
    originalSize?: number;

    /** Output size in bytes after truncation. */
    truncatedSize?: number;

    /** Non-fatal security warnings. */
    warnings?: string[];

    /** Actual execution duration in milliseconds. */
    executionTime?: number;

    /** Whether tool ran in a sandbox. */
    sandboxed?: boolean;
  };

  /** Artifacts produced by the tool execution. */
  artifacts?: Array<{
    id: string;
    name: string;
    type: string;
    path?: string;
    url?: string;
  }>;

  /** Execution metadata. */
  metadata?: {
    duration: number;
    instanceId: string;
    [key: string]: any;
  };
}

/**
 * A single entry in the security audit log, recording a tool invocation
 * with timing, identity, and any security events that occurred.
 */
export interface AuditLogEntry {
  /** Unix timestamp of the audit event. */
  timestamp: number;

  /** Unique request ID for correlation. */
  requestId: string;

  /** Name of the tool that was invoked. */
  toolName: string;

  /** ID of the requesting instance. */
  requesterId: string;

  /** User ID if available from request metadata. */
  userId?: string;

  /** Input data (possibly masked). */
  input?: any;

  /** Output data (possibly masked). */
  output?: any;

  /** Error message if execution failed. */
  error?: string;

  /** Total execution time in milliseconds. */
  executionTime: number;

  /** Security events that occurred during execution. */
  securityEvents?: Array<{
    type: 'validation_failed' | 'output_truncated' | 'timeout' | 'rate_limited' | 'rbac_denied';
    message: string;
  }>;

  /** RBAC context provided with the request. */
  rbacContext?: string[];
}

/**
 * Internal rate limit tracking state for a (tool, requester) pair.
 */
export interface RateLimitState {
  /** Request count in current minute window. */
  requestsPerMinute: number;

  /** Request count in current hour window. */
  requestsPerHour: number;

  /** Request count in current day window. */
  requestsPerDay: number;

  /** Timestamp of last request. */
  lastRequest: number;

  /** Window start timestamps for each granularity. */
  windows: {
    minute: number;
    hour: number;
    day: number;
  };
}
