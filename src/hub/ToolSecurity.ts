import { EventEmitter } from 'events';
import { InputValidator } from './InputValidator.js';
import { OutputSanitizer } from './OutputSanitizer.js';
import {
  ToolSecurityPolicy,
  ValidationResult,
  SecureToolExecutionRequest,
  SecureToolExecutionResult,
  AuditLogEntry,
  RateLimitState,
} from './ToolSecurityTypes.js';

// Re-export all types so existing consumers can import from this module.
export type {
  ToolSecurityPolicy,
  ValidationResult,
  SecureToolExecutionRequest,
  SecureToolExecutionResult,
  AuditLogEntry,
} from './ToolSecurityTypes.js';

/** Enforces security policies for tool execution in a multi-instance hub. */
export class ToolSecurityManager extends EventEmitter {
  private policies: Map<string, ToolSecurityPolicy> = new Map();
  private rateLimits: Map<string, RateLimitState> = new Map();
  private auditLog: AuditLogEntry[] = [];
  private inputValidator = new InputValidator();
  private outputSanitizer = new OutputSanitizer();

  private defaultPolicy: ToolSecurityPolicy = {
    toolName: 'default',
    inputValidation: {
      maxInputSize: 1024 * 1024,
      forbiddenPatterns: [/\.\.\//g, /eval\(/gi, /<script/gi, /DROP TABLE/gi],
    },
    outputLimits: {
      maxOutputSize: 1024 * 1024,
      maxArrayLength: 10000,
      maxObjectDepth: 20,
    },
    execution: { timeout: 30000, sandbox: false },
    rateLimit: {
      requestsPerMinute: 60,
      requestsPerHour: 1000,
      requestsPerDay: 10000,
      burstSize: 10,
    },
    audit: {
      logInvocations: true,
      logInput: false,
      logOutput: false,
      logErrors: true,
      maskFields: ['password', 'token', 'apiKey', 'secret'],
    },
  };

  constructor() {
    super();
  }

  /** Register a security policy for a tool, merging with the default policy. */
  registerPolicy(policy: ToolSecurityPolicy): void {
    console.log(`[ToolSecurity] Registering policy for tool: ${policy.toolName}`);
    const mergedPolicy: ToolSecurityPolicy = {
      ...this.defaultPolicy,
      ...policy,
      inputValidation: { ...this.defaultPolicy.inputValidation, ...policy.inputValidation },
      outputLimits: { ...this.defaultPolicy.outputLimits, ...policy.outputLimits },
      execution: { ...this.defaultPolicy.execution, ...policy.execution },
      rateLimit: { ...this.defaultPolicy.rateLimit, ...policy.rateLimit },
      audit: { ...this.defaultPolicy.audit, ...policy.audit },
    };
    this.policies.set(policy.toolName, mergedPolicy);
  }

  /** Get the effective policy for a tool (returns default if none registered). */
  getPolicy(toolName: string): ToolSecurityPolicy {
    return this.policies.get(toolName) ?? this.defaultPolicy;
  }

  /** Override fields on the default policy applied to all tools. */
  setDefaultPolicy(policy: Partial<ToolSecurityPolicy>): void {
    this.defaultPolicy = { ...this.defaultPolicy, ...policy };
  }

  /** Execute a tool with full security enforcement. */
  async executeSecurely(
    request: SecureToolExecutionRequest,
    executor: (args: any) => Promise<any>
  ): Promise<SecureToolExecutionResult> {
    const startTime = Date.now();
    const requestId = this.generateRequestId();
    const policy = this.getPolicy(request.toolName);

    console.log(`[ToolSecurity] Executing tool ${request.toolName} securely (request: ${requestId})`);

    try {
      // 1. RBAC check
      if (!this.checkRBAC(request.toolName, request.rbacContext ?? [], policy)) {
        const error = 'RBAC: Permission denied';
        this.emit('rbac-denied', request.toolName, request.requesterId, request.rbacContext);
        await this.logAudit({
          timestamp: Date.now(), requestId, toolName: request.toolName,
          requesterId: request.requesterId, userId: request.metadata?.userId,
          error, executionTime: Date.now() - startTime,
          securityEvents: [{ type: 'rbac_denied', message: error }],
          rbacContext: request.rbacContext,
        });
        return { success: false, error, metadata: { duration: Date.now() - startTime, instanceId: request.requesterId } };
      }

      // 2. Rate limit check
      const rateLimitKey = `${request.toolName}:${request.requesterId}`;
      if (!this.checkRateLimit(rateLimitKey, policy)) {
        const error = 'Rate limit exceeded';
        this.emit('rate-limited', request.toolName, request.requesterId);
        await this.logAudit({
          timestamp: Date.now(), requestId, toolName: request.toolName,
          requesterId: request.requesterId, userId: request.metadata?.userId,
          error, executionTime: Date.now() - startTime,
          securityEvents: [{ type: 'rate_limited', message: error }],
          rbacContext: request.rbacContext,
        });
        return { success: false, error, metadata: { duration: Date.now() - startTime, instanceId: request.requesterId } };
      }

      // 3. Input validation
      const validation = await this.inputValidator.validate(request.arguments, policy);
      if (!validation.valid) {
        const error = `Input validation failed: ${validation.errors?.join(', ')}`;
        this.emit('validation-failed', request.toolName, validation.errors);
        await this.logAudit({
          timestamp: Date.now(), requestId, toolName: request.toolName,
          requesterId: request.requesterId, userId: request.metadata?.userId,
          input: policy.audit?.logInput ? this.outputSanitizer.maskSensitive(request.arguments, policy) : undefined,
          error, executionTime: Date.now() - startTime,
          securityEvents: [{ type: 'validation_failed', message: error }],
          rbacContext: request.rbacContext,
        });
        return { success: false, error, metadata: { duration: Date.now() - startTime, instanceId: request.requesterId } };
      }

      // 3b. Path allowlist check
      if (policy.execution?.allowedPaths !== undefined) {
        const pathCheckResult = this.inputValidator.checkPathAllowlist(request.arguments, policy.execution.allowedPaths);
        if (!pathCheckResult.allowed) {
          const error = `Path not allowed: ${pathCheckResult.reason}`;
          this.emit('validation-failed', request.toolName, [error]);
          return { success: false, error, metadata: { duration: Date.now() - startTime, instanceId: request.requesterId } };
        }
      }

      // 3c. Host allowlist check
      if (policy.execution?.allowedHosts !== undefined) {
        const hostCheckResult = this.inputValidator.checkHostAllowlist(request.arguments, policy.execution.allowedHosts);
        if (!hostCheckResult.allowed) {
          const error = `Host not allowed: ${hostCheckResult.reason}`;
          this.emit('validation-failed', request.toolName, [error]);
          return { success: false, error, metadata: { duration: Date.now() - startTime, instanceId: request.requesterId } };
        }
      }

      // 3d. Tool name validation
      if (!this.inputValidator.validateToolName(request.toolName)) {
        const error = 'Tool name contains shell metacharacters';
        this.emit('validation-failed', request.toolName, [error]);
        return { success: false, error, metadata: { duration: Date.now() - startTime, instanceId: request.requesterId } };
      }

      // 4. Execute with timeout
      const timeout = policy.execution?.timeout ?? 30000;
      let output: any;
      let timedOut = false;

      try {
        output = await this.executeWithTimeout(
          () => executor(validation.sanitizedInput ?? request.arguments),
          timeout
        );
      } catch (error: any) {
        if (error.message === 'Execution timeout') {
          timedOut = true;
          this.emit('timeout', request.toolName, timeout);
        }
        const errorMsg = error.message || 'Execution failed';
        await this.logAudit({
          timestamp: Date.now(), requestId, toolName: request.toolName,
          requesterId: request.requesterId, userId: request.metadata?.userId,
          input: policy.audit?.logInput ? this.outputSanitizer.maskSensitive(request.arguments, policy) : undefined,
          error: errorMsg, executionTime: Date.now() - startTime,
          securityEvents: timedOut ? [{ type: 'timeout', message: errorMsg }] : [],
          rbacContext: request.rbacContext,
        });
        return { success: false, error: errorMsg, metadata: { duration: Date.now() - startTime, instanceId: request.requesterId } };
      }

      // 5. Sanitize output
      const sanitized = this.outputSanitizer.sanitize(output, policy);
      if (sanitized.truncated) {
        this.emit('output-truncated', policy.toolName, sanitized.originalSize, sanitized.truncatedSize);
      }

      // 6. Log audit
      await this.logAudit({
        timestamp: Date.now(), requestId, toolName: request.toolName,
        requesterId: request.requesterId, userId: request.metadata?.userId,
        input: policy.audit?.logInput ? this.outputSanitizer.maskSensitive(request.arguments, policy) : undefined,
        output: policy.audit?.logOutput ? this.outputSanitizer.maskSensitive(sanitized.data, policy) : undefined,
        executionTime: Date.now() - startTime, rbacContext: request.rbacContext,
        securityEvents: sanitized.truncated
          ? [{ type: 'output_truncated', message: 'Output was truncated due to size limit' }]
          : [],
      });

      // 7. Return result
      return {
        success: true,
        data: sanitized.data,
        security: {
          outputTruncated: sanitized.truncated,
          originalSize: sanitized.originalSize,
          truncatedSize: sanitized.truncatedSize,
          executionTime: Date.now() - startTime,
          sandboxed: policy.execution?.sandbox ?? false,
          warnings: sanitized.warnings,
        },
        metadata: { duration: Date.now() - startTime, instanceId: request.requesterId },
      };
    } catch (error: any) {
      console.error(`[ToolSecurity] Execution error for ${request.toolName}:`, error);
      await this.logAudit({
        timestamp: Date.now(), requestId, toolName: request.toolName,
        requesterId: request.requesterId, userId: request.metadata?.userId,
        error: error.message || 'Unknown error', executionTime: Date.now() - startTime,
        rbacContext: request.rbacContext,
      });
      return { success: false, error: error.message || 'Unknown error', metadata: { duration: Date.now() - startTime, instanceId: request.requesterId } };
    }
  }

  /** Retrieve audit log entries, optionally filtered. */
  getAuditLog(filter?: {
    toolName?: string;
    requesterId?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): AuditLogEntry[] {
    let logs = this.auditLog;
    if (filter) {
      if (filter.toolName) logs = logs.filter((log) => log.toolName === filter.toolName);
      if (filter.requesterId) logs = logs.filter((log) => log.requesterId === filter.requesterId);
      if (filter.startTime) logs = logs.filter((log) => log.timestamp >= filter.startTime!);
      if (filter.endTime) logs = logs.filter((log) => log.timestamp <= filter.endTime!);
      if (filter.limit) logs = logs.slice(0, filter.limit);
    }
    return logs;
  }

  /**
   * Check whether the requester has the required RBAC roles for the tool.
   *
   * @param _toolName - Tool name (unused, kept for interface consistency)
   * @param rbacContext - Requester's RBAC roles/contexts
   * @param policy - The security policy being enforced
   * @returns true if the requester has sufficient permissions
   */
  private checkRBAC(_toolName: string, rbacContext: string[], policy: ToolSecurityPolicy): boolean {
    const requiredRoles = policy.rbac ?? [];
    if (requiredRoles.length === 0) return true;
    return rbacContext.some((ctx) => requiredRoles.includes(ctx));
  }

  /**
   * Check whether the requester has exceeded rate limits for a tool.
   * Uses sliding windows for per-minute, per-hour, and per-day counts.
   *
   * @param key - Rate limit key (toolName:requesterId)
   * @param policy - The security policy containing rate limit thresholds
   * @returns true if the request is within rate limits
   */
  private checkRateLimit(key: string, policy: ToolSecurityPolicy): boolean {
    const now = Date.now();
    let state = this.rateLimits.get(key);
    if (!state) {
      state = {
        requestsPerMinute: 0, requestsPerHour: 0, requestsPerDay: 0,
        lastRequest: now, windows: { minute: now, hour: now, day: now },
      };
      this.rateLimits.set(key, state);
    }
    if (now - state.windows.minute >= 60000) { state.requestsPerMinute = 0; state.windows.minute = now; }
    if (now - state.windows.hour >= 3600000) { state.requestsPerHour = 0; state.windows.hour = now; }
    if (now - state.windows.day >= 86400000) { state.requestsPerDay = 0; state.windows.day = now; }

    const limits = policy.rateLimit ?? {};
    if (limits.requestsPerMinute && state.requestsPerMinute >= limits.requestsPerMinute) return false;
    if (limits.requestsPerHour && state.requestsPerHour >= limits.requestsPerHour) return false;
    if (limits.requestsPerDay && state.requestsPerDay >= limits.requestsPerDay) return false;

    state.requestsPerMinute++;
    state.requestsPerHour++;
    state.requestsPerDay++;
    state.lastRequest = now;
    return true;
  }

  /**
   * Execute a function with a timeout guard.
   * Throws if the function does not complete within the specified timeout.
   *
   * @param fn - The function to execute
   * @param timeout - Maximum execution time in milliseconds
   * @returns The function's return value
   */
  private async executeWithTimeout<T>(fn: () => Promise<T>, timeout: number): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Execution timeout')), timeout);
    });
    return Promise.race([fn(), timeoutPromise]);
  }

  /**
   * Write an entry to the audit log and emit the 'audit-log' event.
   *
   * @param entry - The audit log entry to record
   */
  private async logAudit(entry: AuditLogEntry): Promise<void> {
    this.auditLog.push(entry);
    this.emit('audit-log', entry);
    console.log(`[ToolSecurity] Audit: ${entry.toolName} by ${entry.requesterId} (${entry.executionTime}ms)`);
  }

  /**
   * Generate a unique request ID for tracking and correlation.
   *
   * @returns A unique request ID string
   */
  private generateRequestId(): string {
    return `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

export { ToolSandbox } from './ToolSandbox.js';
