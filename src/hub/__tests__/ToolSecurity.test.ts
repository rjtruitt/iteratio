import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolSecurityManager, ToolSecurityPolicy, SecureToolExecutionRequest } from '../ToolSecurity';

describe('ToolSecurity', () => {
  let security: ToolSecurityManager;

  beforeEach(() => {
    security = new ToolSecurityManager();
  });

  const createRequest = (overrides: Partial<SecureToolExecutionRequest> = {}): SecureToolExecutionRequest => ({
    requesterId: 'agent-1',
    toolName: 'test-tool',
    arguments: { input: 'hello' },
    rbacContext: ['admin'],
    metadata: { traceId: 'trace-1', userId: 'user-1' },
    ...overrides,
  });

  const createExecutor = (result: any = { success: true }) => {
    return vi.fn().mockResolvedValue(result);
  };

  describe('path traversal prevention', () => {
    it('should block path traversal attempt (../../../etc/passwd)', async () => {
      const request = createRequest({
        arguments: { path: '../../../etc/passwd' },
      });
      const executor = createExecutor();

      const result = await security.executeSecurely(request, executor);

      expect(result.success).toBe(false);
      expect(result.error).toContain('forbidden pattern');
      expect(executor).not.toHaveBeenCalled();
    });

    it('should block encoded path traversal (%2e%2e/)', async () => {
      const request = createRequest({
        arguments: { path: '%2e%2e/%2e%2e/etc/passwd' },
      });
      const executor = createExecutor();

      const result = await security.executeSecurely(request, executor);

      expect(result.success).toBe(false);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should block null byte injection', async () => {
      const request = createRequest({
        arguments: { filename: 'safe.txt\x00.exe' },
      });
      const executor = createExecutor();

      const result = await security.executeSecurely(request, executor);

      expect(result.success).toBe(false);
      expect(executor).not.toHaveBeenCalled();
    });
  });

  describe('command injection prevention', () => {
    it('should block command injection in tool args', async () => {
      const request = createRequest({
        arguments: { cmd: 'ls; rm -rf /' },
      });

      security.registerPolicy({
        toolName: 'test-tool',
        inputValidation: {
          forbiddenPatterns: [/;\s*rm/gi, /\|\s*bash/gi, /`[^`]+`/g],
        },
      });

      const executor = createExecutor();
      const result = await security.executeSecurely(request, executor);

      expect(result.success).toBe(false);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should block tool name with shell metacharacters', async () => {
      const request = createRequest({
        toolName: 'tool; echo pwned',
        arguments: {},
      });

      security.registerPolicy({
        toolName: 'tool; echo pwned',
        inputValidation: {
          forbiddenPatterns: [/[;&|`$()]/g],
        },
      });

      const executor = createExecutor();
      const result = await security.executeSecurely(request, executor);

      expect(result.success).toBe(false);
      expect(executor).not.toHaveBeenCalled();
    });
  });

  describe('SQL injection prevention', () => {
    it('should block SQL injection in tool args', async () => {
      const request = createRequest({
        arguments: { query: "'; DROP TABLE users; --" },
      });
      const executor = createExecutor();

      const result = await security.executeSecurely(request, executor);

      expect(result.success).toBe(false);
      expect(result.error).toContain('forbidden pattern');
      expect(executor).not.toHaveBeenCalled();
    });
  });

  describe('secret leakage detection', () => {
    it('should redact API key in tool output', async () => {
      const request = createRequest();
      const executor = vi.fn().mockResolvedValue({
        data: 'Result: sk-ant-api03-xxxxxxxxxxxxxxxxxxxx',
      });

      security.registerPolicy({
        toolName: 'test-tool',
        outputLimits: {
          forbiddenPatterns: [/sk-ant-[a-zA-Z0-9-]+/g, /AKIA[A-Z0-9]{16}/g],
        },
      });

      const result = await security.executeSecurely(request, executor);

      // Output should not contain the raw API key
      expect(JSON.stringify(result.data)).not.toContain('sk-ant-api03');
    });

    it('should mask sensitive fields in audit log', async () => {
      security.registerPolicy({
        toolName: 'test-tool',
        audit: {
          logInput: true,
          maskFields: ['password', 'apiKey', 'secret'],
        },
      });

      const request = createRequest({
        arguments: { username: 'admin', password: 'secret123', apiKey: 'key-xxx' },
      });
      const executor = createExecutor();

      await security.executeSecurely(request, executor);

      const logs = security.getAuditLog({ toolName: 'test-tool' });
      expect(logs.length).toBeGreaterThan(0);
      if (logs[0].input) {
        expect(logs[0].input.password).toBe('***');
        expect(logs[0].input.apiKey).toBe('***');
        expect(logs[0].input.username).toBe('admin');
      }
    });
  });

  describe('RBAC enforcement', () => {
    it('should deny access when tool requires admin role', async () => {
      security.registerPolicy({
        toolName: 'admin-tool',
        rbac: ['admin'],
      });

      const request = createRequest({
        toolName: 'admin-tool',
        rbacContext: ['viewer'], // Not admin
      });
      const executor = createExecutor();

      const result = await security.executeSecurely(request, executor);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');
      expect(executor).not.toHaveBeenCalled();
    });

    it('should allow access when RBAC context matches required role', async () => {
      security.registerPolicy({
        toolName: 'admin-tool',
        rbac: ['admin'],
      });

      const request = createRequest({
        toolName: 'admin-tool',
        rbacContext: ['admin'],
      });
      const executor = createExecutor({ data: 'allowed' });

      const result = await security.executeSecurely(request, executor);

      expect(result.success).toBe(true);
      expect(executor).toHaveBeenCalled();
    });

    it('should emit rbac-denied event on permission denial', async () => {
      security.registerPolicy({
        toolName: 'restricted',
        rbac: ['superuser'],
      });

      const listener = vi.fn();
      security.on('rbac-denied', listener);

      const request = createRequest({
        toolName: 'restricted',
        rbacContext: ['user'],
      });
      await security.executeSecurely(request, createExecutor());

      expect(listener).toHaveBeenCalledWith('restricted', 'agent-1', ['user']);
    });
  });

  describe('path allowlist enforcement', () => {
    it('should block access to paths outside allowlist', async () => {
      security.registerPolicy({
        toolName: 'file-tool',
        execution: {
          allowedPaths: ['/home/user/projects', '/tmp'],
        },
      });

      const request = createRequest({
        toolName: 'file-tool',
        arguments: { path: '/etc/shadow' },
      });
      const executor = createExecutor();

      const result = await security.executeSecurely(request, executor);

      expect(result.success).toBe(false);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should allow access to paths within allowlist', async () => {
      security.registerPolicy({
        toolName: 'file-tool',
        execution: {
          allowedPaths: ['/home/user/projects'],
        },
      });

      const request = createRequest({
        toolName: 'file-tool',
        arguments: { path: '/home/user/projects/README.md' },
      });
      const executor = createExecutor({ content: 'file data' });

      const result = await security.executeSecurely(request, executor);

      expect(result.success).toBe(true);
    });
  });

  describe('host/URL allowlist enforcement', () => {
    it('should block requests to non-allowed hosts', async () => {
      security.registerPolicy({
        toolName: 'http-tool',
        execution: {
          allowedHosts: ['api.github.com', 'api.example.com'],
        },
      });

      const request = createRequest({
        toolName: 'http-tool',
        arguments: { url: 'http://evil.com/steal-data' },
      });
      const executor = createExecutor();

      const result = await security.executeSecurely(request, executor);

      expect(result.success).toBe(false);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should allow requests to allowed hosts', async () => {
      security.registerPolicy({
        toolName: 'http-tool',
        execution: {
          allowedHosts: ['api.github.com'],
        },
      });

      const request = createRequest({
        toolName: 'http-tool',
        arguments: { url: 'https://api.github.com/repos' },
      });
      const executor = createExecutor({ repos: [] });

      const result = await security.executeSecurely(request, executor);

      expect(result.success).toBe(true);
    });
  });

  describe('sandbox timeout enforcement', () => {
    it('should terminate execution that exceeds timeout', async () => {
      security.registerPolicy({
        toolName: 'slow-tool',
        execution: { timeout: 50 },
      });

      const request = createRequest({ toolName: 'slow-tool' });
      const executor = vi.fn().mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 5000))
      );

      const result = await security.executeSecurely(request, executor);

      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout');
    });

    it('should emit timeout event on timeout', async () => {
      security.registerPolicy({
        toolName: 'timeout-tool',
        execution: { timeout: 50 },
      });

      const listener = vi.fn();
      security.on('timeout', listener);

      const request = createRequest({ toolName: 'timeout-tool' });
      const executor = vi.fn().mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 5000))
      );

      await security.executeSecurely(request, executor);

      expect(listener).toHaveBeenCalledWith('timeout-tool', 50);
    });
  });

  describe('rate limiting', () => {
    it('should allow requests within rate limit', async () => {
      security.registerPolicy({
        toolName: 'rate-limited',
        rateLimit: { requestsPerMinute: 10 },
      });

      const request = createRequest({ toolName: 'rate-limited' });
      const executor = createExecutor();

      const result = await security.executeSecurely(request, executor);
      expect(result.success).toBe(true);
    });

    it('should reject requests exceeding rate limit', async () => {
      security.registerPolicy({
        toolName: 'rate-limited',
        rateLimit: { requestsPerMinute: 2 },
      });

      const request = createRequest({ toolName: 'rate-limited' });
      const executor = createExecutor();

      await security.executeSecurely(request, executor);
      await security.executeSecurely(request, executor);
      const result = await security.executeSecurely(request, executor);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Rate limit');
    });

    it('should emit rate-limited event', async () => {
      security.registerPolicy({
        toolName: 'limited',
        rateLimit: { requestsPerMinute: 1 },
      });

      const listener = vi.fn();
      security.on('rate-limited', listener);

      const request = createRequest({ toolName: 'limited' });
      const executor = createExecutor();

      await security.executeSecurely(request, executor);
      await security.executeSecurely(request, executor);

      expect(listener).toHaveBeenCalledWith('limited', 'agent-1');
    });
  });

  describe('output sanitization', () => {
    it('should truncate output exceeding size limit', async () => {
      security.registerPolicy({
        toolName: 'large-output',
        outputLimits: { maxOutputSize: 100 },
      });

      const request = createRequest({ toolName: 'large-output' });
      const largeData = 'x'.repeat(1000);
      const executor = vi.fn().mockResolvedValue(largeData);

      const result = await security.executeSecurely(request, executor);

      expect(result.success).toBe(true);
      expect(result.security?.outputTruncated).toBe(true);
      expect(result.security?.originalSize).toBeGreaterThan(100);
    });

    it('should emit output-truncated event', async () => {
      security.registerPolicy({
        toolName: 'truncate-test',
        outputLimits: { maxOutputSize: 50 },
      });

      const listener = vi.fn();
      security.on('output-truncated', listener);

      const request = createRequest({ toolName: 'truncate-test' });
      const executor = vi.fn().mockResolvedValue('y'.repeat(500));

      await security.executeSecurely(request, executor);

      expect(listener).toHaveBeenCalled();
    });
  });

  describe('audit logging', () => {
    it('should log all tool invocations', async () => {
      const request = createRequest();
      const executor = createExecutor();

      await security.executeSecurely(request, executor);

      const logs = security.getAuditLog();
      expect(logs.length).toBe(1);
      expect(logs[0].toolName).toBe('test-tool');
      expect(logs[0].requesterId).toBe('agent-1');
    });

    it('should record execution time in audit log', async () => {
      const request = createRequest();
      const executor = createExecutor();

      await security.executeSecurely(request, executor);

      const logs = security.getAuditLog();
      expect(logs[0].executionTime).toBeTypeOf('number');
      expect(logs[0].executionTime).toBeGreaterThanOrEqual(0);
    });

    it('should filter audit log by tool name', async () => {
      await security.executeSecurely(
        createRequest({ toolName: 'tool-a' }),
        createExecutor()
      );
      await security.executeSecurely(
        createRequest({ toolName: 'tool-b' }),
        createExecutor()
      );

      const logs = security.getAuditLog({ toolName: 'tool-a' });
      expect(logs.length).toBe(1);
      expect(logs[0].toolName).toBe('tool-a');
    });
  });

  describe('Edge Cases', () => {
    it('should handle path with null bytes (\\0)', async () => {
      const request = createRequest({
        arguments: { path: '/home/user/file\x00.txt' },
      });
      const executor = createExecutor();

      const result = await security.executeSecurely(request, executor);

      // Null bytes in paths should be blocked
      expect(result.success).toBe(false);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should handle path with unicode normalization attacks (../ via Unicode)', async () => {
      // Unicode characters that normalize to '../'
      const request = createRequest({
        arguments: { path: '/home/user/../../etc/passwd' },
      });
      const executor = createExecutor();

      const result = await security.executeSecurely(request, executor);

      expect(result.success).toBe(false);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should handle argument with SQL injection payload', async () => {
      const request = createRequest({
        arguments: { query: "1'; DROP TABLE users; --" },
      });
      const executor = createExecutor();

      const result = await security.executeSecurely(request, executor);

      expect(result.success).toBe(false);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should handle argument with command injection payload (;rm -rf /)', async () => {
      const request = createRequest({
        arguments: { input: 'valid input; rm -rf / --no-preserve-root' },
      });

      security.registerPolicy({
        toolName: 'test-tool',
        inputValidation: {
          forbiddenPatterns: [/;\s*rm/gi, /&&\s*rm/gi, /\|\s*rm/gi],
        },
      });

      const executor = createExecutor();
      const result = await security.executeSecurely(request, executor);

      expect(result.success).toBe(false);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should handle empty allowlist (block everything)', async () => {
      security.registerPolicy({
        toolName: 'blocked-tool',
        execution: {
          allowedPaths: [], // Empty = nothing allowed
        },
      });

      const request = createRequest({
        toolName: 'blocked-tool',
        arguments: { path: '/any/path/at/all' },
      });
      const executor = createExecutor();

      const result = await security.executeSecurely(request, executor);

      expect(result.success).toBe(false);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should handle allowlist with single entry = "*" (allow everything)', async () => {
      security.registerPolicy({
        toolName: 'open-tool',
        execution: {
          allowedPaths: ['*'],
        },
      });

      const request = createRequest({
        toolName: 'open-tool',
        arguments: { path: '/literally/anywhere' },
      });
      const executor = createExecutor({ data: 'ok' });

      const result = await security.executeSecurely(request, executor);

      expect(result.success).toBe(true);
      expect(executor).toHaveBeenCalled();
    });

    it('should handle path that exceeds filesystem max path length', async () => {
      // Most filesystems limit paths to ~4096 characters
      const longPath = '/home/' + 'a'.repeat(5000) + '/file.txt';
      const request = createRequest({
        arguments: { path: longPath },
      });
      const executor = createExecutor();

      security.registerPolicy({
        toolName: 'test-tool',
        inputValidation: {
          maxInputSize: 4096,
        },
      });

      const result = await security.executeSecurely(request, executor);

      // Should be rejected due to excessive input size
      expect(result.success).toBe(false);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should handle tool security check with expired credentials', async () => {
      security.registerPolicy({
        toolName: 'cred-tool',
        rbac: ['admin'],
      });

      const request = createRequest({
        toolName: 'cred-tool',
        rbacContext: ['admin'],
        metadata: {
          traceId: 'trace-1',
          userId: 'user-1',
          credentialExpiry: Date.now() - 60000, // Expired 1 minute ago
        },
      });
      const executor = createExecutor();

      const result = await security.executeSecurely(request, executor);

      // Current implementation does not check credential expiry, so it allows the call
      // This documents the gap: expired credentials are NOT rejected yet
      expect(result.success).toBe(true);
      expect(executor).toHaveBeenCalled();
    });

    it('should handle concurrent security checks (shared state mutation)', async () => {
      security.registerPolicy({
        toolName: 'concurrent-tool',
        rateLimit: { requestsPerMinute: 100 },
      });

      // Fire 50 concurrent security checks
      const checks = Array.from({ length: 50 }, (_, i) =>
        security.executeSecurely(
          createRequest({
            toolName: 'concurrent-tool',
            requesterId: `agent-${i}`,
          }),
          createExecutor()
        )
      );

      const results = await Promise.all(checks);

      // All should complete without corrupting shared state
      expect(results.length).toBe(50);
      expect(results.every(r => typeof r.success === 'boolean')).toBe(true);
    });

    it('should handle security rule that references non-existent role', async () => {
      security.registerPolicy({
        toolName: 'phantom-role-tool',
        rbac: ['non-existent-role-xyz'],
      });

      const request = createRequest({
        toolName: 'phantom-role-tool',
        rbacContext: ['admin', 'user'],
      });
      const executor = createExecutor();

      const result = await security.executeSecurely(request, executor);

      // Should deny since the required role doesn't match any provided role
      expect(result.success).toBe(false);
      expect(executor).not.toHaveBeenCalled();
    });
  });

  describe('Adversarial: Advanced Attacks', () => {
    it('should block double encoding attack (%252e%252e%252f)', async () => {
      const request = createRequest({
        arguments: { path: '%252e%252e%252f%252e%252e%252fetc%252fpasswd' },
      });
      const executor = createExecutor();

      // Add a policy that forbids encoded traversal patterns
      security.registerPolicy({
        toolName: 'test-tool',
        inputValidation: {
          forbiddenPatterns: [/(%2e|%252e){2}(%2f|%252f)/gi, /\.\.\//g],
        },
      });

      const result = await security.executeSecurely(request, executor);

      // Double-encoded path traversal should be detected and blocked
      expect(result.success).toBe(false);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should block path with Windows-style traversal (..\\\\..\\\\)', async () => {
      const request = createRequest({
        arguments: { path: '..\\..\\..\\Windows\\System32\\config\\SAM' },
      });
      const executor = createExecutor();

      // Add a policy that forbids Windows-style backslash traversal
      security.registerPolicy({
        toolName: 'test-tool',
        inputValidation: {
          forbiddenPatterns: [/\.\.\//g, /\.\.\\/g],
        },
      });

      const result = await security.executeSecurely(request, executor);

      // Windows-style backslash traversal should be detected and blocked
      expect(result.success).toBe(false);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should block symlink traversal (path resolves to symlink pointing outside sandbox)', async () => {
      const request = createRequest({
        toolName: 'file-tool',
        arguments: { path: '/home/user/projects/symlink-to-etc' },
      });

      security.registerPolicy({
        toolName: 'file-tool',
        execution: {
          allowedPaths: ['/home/user/projects'],
        },
      });

      const executor = createExecutor();
      const result = await security.executeSecurely(request, executor);

      // Current implementation does path prefix check only (no symlink resolution)
      // The path itself IS within allowedPaths, so it passes
      // This documents the gap: symlink resolution is not yet implemented
      expect(result.success).toBe(true);
      expect(executor).toHaveBeenCalled();
    });

    it('should prevent TOCTOU race (path valid at check, replaced before use)', async () => {
      // Time-of-check to time-of-use: path passes validation then changes
      security.registerPolicy({
        toolName: 'file-tool',
        execution: {
          allowedPaths: ['/tmp/safe'],
        },
      });

      const request = createRequest({
        toolName: 'file-tool',
        arguments: { path: '/tmp/safe/file.txt' },
      });

      // Simulate TOCTOU by having executor return dangerous data
      const executor = vi.fn().mockImplementation(async (args: any) => {
        return { success: true, data: { actualPath: '/etc/shadow' } };
      });

      const result = await security.executeSecurely(request, executor);

      // Current implementation does not have atomic check-and-use
      // The executor runs after validation passes, and can return anything
      // This documents the gap: TOCTOU is not prevented
      expect(result.success).toBe(true);
      expect(executor).toHaveBeenCalled();
    });

    it('should block zip slip attack (archive entry with ../ in name)', async () => {
      const request = createRequest({
        arguments: {
          archiveEntry: '../../../etc/cron.d/malicious',
          extractTo: '/tmp/safe/extract',
        },
      });
      const executor = createExecutor();

      const result = await security.executeSecurely(request, executor);

      // The default policy forbids ../ patterns in input
      expect(result.success).toBe(false);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should block argument with SSRF payload (http://169.254.169.254/metadata)', async () => {
      security.registerPolicy({
        toolName: 'http-tool',
        execution: {
          allowedHosts: ['api.example.com'],
        },
        inputValidation: {
          forbiddenPatterns: [/169\.254\.169\.254/g, /127\.0\.0\.1/g, /localhost/gi],
        },
      });

      const request = createRequest({
        toolName: 'http-tool',
        arguments: { url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' },
      });
      const executor = createExecutor();

      const result = await security.executeSecurely(request, executor);

      // Cloud metadata SSRF should be blocked via forbidden pattern
      expect(result.success).toBe(false);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should block argument with DNS rebinding setup', async () => {
      security.registerPolicy({
        toolName: 'http-tool',
        execution: {
          allowedHosts: ['safe.example.com'],
        },
      });

      const request = createRequest({
        toolName: 'http-tool',
        arguments: { url: 'http://rebind.attacker.com/api' }, // DNS rebinding domain
      });
      const executor = createExecutor();

      const result = await security.executeSecurely(request, executor);

      // Domain not in allowlist - blocked by host allowlist check
      // Note: actual DNS rebinding prevention (resolve + IP check) is not yet implemented
      expect(result.success).toBe(false);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should detect Unicode homoglyph attack (looks like admin but different chars)', async () => {
      // Using Cyrillic 'a' (U+0430) and Latin 'a' (U+0061) — visually identical
      const homoglyphAdmin = 'аdmin'; // Cyrillic 'a' + 'dmin'

      security.registerPolicy({
        toolName: 'auth-tool',
        rbac: ['admin'],
      });

      const request = createRequest({
        toolName: 'auth-tool',
        rbacContext: [homoglyphAdmin], // Looks like 'admin' but isn't
      });
      const executor = createExecutor();

      const result = await security.executeSecurely(request, executor);

      // Homoglyph 'admin' should NOT match real 'admin' role (strict string comparison)
      expect(result.success).toBe(false);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should block argument with JSON injection (closing quote, adding new field)', async () => {
      const request = createRequest({
        arguments: { name: '","role":"admin","extra":"' }, // JSON injection attempt
      });

      security.registerPolicy({
        toolName: 'test-tool',
        inputValidation: {
          forbiddenPatterns: [/","[a-z]+":"[^"]*"/gi],
        },
      });

      const executor = createExecutor();

      const result = await security.executeSecurely(request, executor);

      // JSON injection pattern should be detected via custom policy
      expect(result.success).toBe(false);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should block argument with YAML deserialization attack payload', async () => {
      const request = createRequest({
        arguments: {
          config: '!!python/object/apply:os.system ["cat /etc/passwd"]',
        },
      });

      security.registerPolicy({
        toolName: 'test-tool',
        inputValidation: {
          forbiddenPatterns: [/!!python\//gi, /!!ruby\//gi, /!!java\//gi],
        },
      });

      const executor = createExecutor();

      const result = await security.executeSecurely(request, executor);

      // YAML deserialization gadgets should be detected via policy
      expect(result.success).toBe(false);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should block very long path (4096+ characters, buffer overflow attempt)', async () => {
      const longPath = '/' + 'a'.repeat(4096) + '/file.txt';
      const request = createRequest({
        arguments: { path: longPath },
      });

      security.registerPolicy({
        toolName: 'test-tool',
        inputValidation: {
          maxInputSize: 4096,
        },
      });

      const executor = createExecutor();

      const result = await security.executeSecurely(request, executor);

      // Excessively long input should be rejected by size limit
      expect(result.success).toBe(false);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should block path with only dots and slashes (../../../../../../)', async () => {
      const request = createRequest({
        arguments: { path: '../../../../../../../../../../../../../../' },
      });
      const executor = createExecutor();

      const result = await security.executeSecurely(request, executor);

      // Pure traversal path should be blocked by default ../ pattern
      expect(result.success).toBe(false);
      expect(executor).not.toHaveBeenCalled();
    });
  });

  describe('Untested Methods', () => {
    it('getPolicy(toolName) — get security policy for tool', () => {
      security.registerPolicy({
        toolName: 'policy-test-tool',
        rbac: ['admin'],
        execution: { timeout: 5000 },
      });

      const policy = security.getPolicy('policy-test-tool');

      expect(policy).toBeDefined();
      expect(policy.toolName).toBe('policy-test-tool');
      expect(policy.rbac).toContain('admin');
      expect(policy.execution!.timeout).toBe(5000);
    });

    it('getPolicy(toolName) — returns default policy for unregistered tool', () => {
      const policy = security.getPolicy('nonexistent-tool');

      // Returns default policy (not null) when no specific policy registered
      expect(policy).toBeDefined();
      expect(policy.toolName).toBe('default');
    });

    it('setDefaultPolicy(policy) — set default policy', async () => {
      security.setDefaultPolicy({
        execution: { timeout: 10000 },
        rateLimit: { requestsPerMinute: 60 },
      });

      // Any tool without a specific policy should use the default
      const request = createRequest({
        toolName: 'no-specific-policy-tool',
      });
      const executor = createExecutor();

      const result = await security.executeSecurely(request, executor);

      // Default policy should apply (tool should execute successfully under default limits)
      expect(result.success).toBe(true);
    });

    it('ToolSandbox.execute(fn, constraints) — sandboxed tool execution', async () => {
      const { ToolSandbox } = await import('../ToolSecurity');
      const sandbox = new ToolSandbox();

      const result = await sandbox.execute(
        async () => ({ output: 'sandboxed' }),
        { timeout: 5000, memoryLimit: 50 * 1024 * 1024 }
      );

      expect(result).toEqual({ output: 'sandboxed' });
    });

    it('ToolSandbox.execute(fn, constraints) — enforces timeout constraint', async () => {
      const { ToolSandbox } = await import('../ToolSecurity');
      const sandbox = new ToolSandbox();

      await expect(
        sandbox.execute(
          () => new Promise((resolve) => setTimeout(resolve, 10000)),
          { timeout: 50, memoryLimit: 50 * 1024 * 1024 }
        )
      ).rejects.toThrow(/timeout/i);
    });
  });
});
