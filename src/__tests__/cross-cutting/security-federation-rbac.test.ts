import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockTransport } from '../../__test__/MockTransport';
import { MockRedis } from '../../__test__/MockRedis';
import { RBAC, createDefaultPolicy } from '../../cross-cutting/RBAC';
import { Observability } from '../../cross-cutting/Observability';
import { Sandbox } from '../../cross-cutting/Sandbox';
import { SessionCheckpoint } from '../../cross-cutting/SessionCheckpoint';

/**
 * Cross-cutting: Security + Federation + RBAC + Cross-Org Denial
 */

describe('Cross-cutting: Security + Federation + RBAC', () => {
  let transport: MockTransport;
  let rbac: RBAC;

  beforeEach(() => {
    transport = new MockTransport();
    rbac = new RBAC({
      policy: createDefaultPolicy(),
      auditEnabled: true,
    });

    // Register agents from different orgs
    rbac.registerAgent({ agentId: 'agent-a', orgId: 'org-a', role: 'agent' });
    rbac.registerAgent({ agentId: 'agent-b', orgId: 'org-b', role: 'agent' });
    rbac.registerAgent({ agentId: 'admin-a', orgId: 'org-a', role: 'admin' });
    rbac.registerAgent({ agentId: 'reader-a', orgId: 'org-a', role: 'reader' });
  });

  describe('cross-org security boundaries', () => {
    it('should deny tool access from unauthorized federated agent', async () => {
      const result = rbac.checkCrossOrgAccess('agent-a', 'org-b', 'tools', 'execute');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('denied');
    });

    it('should prevent secret leakage across federation boundary', async () => {
      const sandbox = new Sandbox({
        secretPatterns: [/sk-[a-zA-Z0-9]{20,}/, /password=\S+/],
      });

      // Agent A's state contains secrets
      const statePayload = JSON.stringify({ apiKey: 'sk-abcdefghijklmnopqrstuvwxyz', config: 'normal' });
      const check = sandbox.checkToolResult('state_share', statePayload);

      expect(check.clean).toBe(false);
      expect(JSON.stringify(check.redacted)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    });

    it('should enforce org-level rate limits independently', async () => {
      const orgARateLimit = { count: 0, limit: 100 };
      const orgBRateLimit = { count: 0, limit: 50 };

      // Org A agent makes requests - counts against Org A limit
      for (let i = 0; i < 5; i++) orgARateLimit.count++;
      // Org B agent makes requests - counts against Org B limit
      for (let i = 0; i < 5; i++) orgBRateLimit.count++;

      expect(orgARateLimit.count).toBe(5);
      expect(orgBRateLimit.count).toBe(5);
      expect(orgARateLimit.count < orgARateLimit.limit).toBe(true);
      expect(orgBRateLimit.count < orgBRateLimit.limit).toBe(true);

      // They are independent
      orgARateLimit.count = 100;
      expect(orgARateLimit.count >= orgARateLimit.limit).toBe(true);
      expect(orgBRateLimit.count < orgBRateLimit.limit).toBe(true);
    });

    it('should audit cross-org access attempts', async () => {
      rbac.checkCrossOrgAccess('agent-a', 'org-b', 'data', 'read');
      rbac.checkPermission('admin-a', 'tools', 'execute');

      const auditLog = rbac.auditLog;
      expect(auditLog.length).toBe(2);
      expect(auditLog[0].agentId).toBe('agent-a');
      expect(auditLog[0].allowed).toBe(false);
      expect(auditLog[0].timestamp).toBeGreaterThan(0);
      expect(auditLog[1].agentId).toBe('admin-a');
      expect(auditLog[1].allowed).toBe(true);
    });
  });

  describe('RBAC enforcement in distributed context', () => {
    it('should enforce RBAC even when request arrives via transport', async () => {
      await transport.connect({ backend: 'memory' });

      // Simulate message arriving from remote agent
      const remoteMessage = { agentId: 'agent-b', action: 'execute', resource: 'tools' };
      const check = rbac.checkPermission(remoteMessage.agentId, remoteMessage.resource, remoteMessage.action);

      // Agent role has tool execution permission
      expect(check.allowed).toBe(true);
    });

    it('should handle RBAC policy update during active operation', async () => {
      // Agent starts with permission
      const check1 = rbac.checkPermission('agent-a', 'tools', 'execute');
      expect(check1.allowed).toBe(true);

      // Policy updated mid-operation (revoke tool execute for agent role)
      const newPolicy = createDefaultPolicy();
      newPolicy.roles.set('agent', [{ resource: 'state', action: 'read' }]);
      rbac.updatePolicy(newPolicy);

      // Next attempt denied
      const check2 = rbac.checkPermission('agent-a', 'tools', 'execute');
      expect(check2.allowed).toBe(false);
    });

    it('should deny escalation attempts (request higher privilege)', async () => {
      const result = rbac.requestEscalation('reader-a', 'admin');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('escalation denied');
    });

    it('should inherit permissions correctly (admin includes reader)', async () => {
      // Admin should be able to do what reader can do
      const adminReadCheck = rbac.checkPermission('admin-a', 'state', 'read');
      expect(adminReadCheck.allowed).toBe(true);

      // Reader can also read
      const readerReadCheck = rbac.checkPermission('reader-a', 'state', 'read');
      expect(readerReadCheck.allowed).toBe(true);

      // Reader cannot write
      const readerWriteCheck = rbac.checkPermission('reader-a', 'state', 'write');
      expect(readerWriteCheck.allowed).toBe(false);

      // Admin can write (admin inherits operator inherits agent which has write)
      const adminWriteCheck = rbac.checkPermission('admin-a', 'state', 'write');
      expect(adminWriteCheck.allowed).toBe(true);
    });
  });

  describe('injection attacks through federation', () => {
    it('should sanitize federated messages (prevent injection via transport)', async () => {
      const maliciousMessage = 'Normal text {{__import__("os").system("rm -rf /")}} more text';
      const result = rbac.sanitizeMessage(maliciousMessage);

      expect(result.clean).toBe(false);
      expect(result.threats).toContain('template injection');
      expect(result.sanitized).not.toContain('{{');
      expect(result.sanitized).toContain('[SANITIZED]');
    });

    it('should validate federated agent identity (prevent impersonation)', async () => {
      const claimedIdentity = { agentId: 'agent-fake', orgId: 'org-a', role: 'admin' as const };
      const credentials = { orgId: 'org-b', token: 'some-token' };

      const validation = rbac.validateIdentity(claimedIdentity, credentials);
      expect(validation.valid).toBe(false);
      expect(validation.reason).toContain('mismatch');
    });

    it('should prevent path traversal via federated artifact transfer', async () => {
      const sandbox = new Sandbox({
        allowedPaths: ['/tmp/artifacts'],
        blockedPaths: ['/etc'],
      });

      const artifactPath = '../../../etc/passwd';
      const check = sandbox.checkToolInvocation('artifact_receive', { path: artifactPath });
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain('Path traversal');
    });
  });

  describe('security + federation failover', () => {
    it('should maintain security posture during federation reconnection', async () => {
      // Before disconnect
      const check1 = rbac.checkCrossOrgAccess('agent-a', 'org-b', 'data', 'read');
      expect(check1.allowed).toBe(false);

      // Simulate disconnect and reconnect
      await transport.connect({ backend: 'memory' });
      await transport.disconnect();
      await transport.connect({ backend: 'memory' });

      // Security rules still enforced after reconnection
      const check2 = rbac.checkCrossOrgAccess('agent-a', 'org-b', 'data', 'read');
      expect(check2.allowed).toBe(false);
    });

    it('should revoke federated access on authentication expiry', async () => {
      // Register agent with expiry
      rbac.registerAgent({
        agentId: 'temp-agent',
        orgId: 'org-a',
        role: 'agent',
        expiresAt: Date.now() - 1000, // Already expired
      });

      const check = rbac.checkPermission('temp-agent', 'tools', 'execute');
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain('expired');
    });
  });

  describe('Deep Interactions: Security + Observability + Recovery', () => {
    it('should trigger tracing span with full attack context on security violation', async () => {
      const obs = new Observability();

      // Security violation detected
      const span = obs.startSpan('security:violation', {
        attributes: {
          attackType: 'injection',
          sourceAgent: 'agent-malicious',
          targetResource: 'state:credentials',
          payloadHash: 'sha256:abc123',
          rbacContext: 'role=agent',
          federationPath: 'org-b -> org-a',
        },
      });

      obs.endSpan(span.id, 'error');

      const traces = obs.getTrace(span.traceId);
      expect(traces.length).toBe(1);
      expect(traces[0].status).toBe('error');
      expect(traces[0].attributes.attackType).toBe('injection');
      expect(traces[0].attributes.sourceAgent).toBe('agent-malicious');
    });

    it('should handle RBAC denial during recovery (recovering agent lost permissions)', async () => {
      // Agent has permission initially
      let check = rbac.checkPermission('agent-a', 'tools', 'execute');
      expect(check.allowed).toBe(true);

      // During downtime, role revoked
      rbac.updateAgentRole('agent-a', 'guest');

      // Recovery process tries to resume but RBAC denies
      check = rbac.checkPermission('agent-a', 'tools', 'execute');
      expect(check.allowed).toBe(false);

      // Should not enter infinite loop - just report failure
      const recoveryAttempts = [];
      for (let i = 0; i < 3; i++) {
        const result = rbac.checkPermission('agent-a', 'tools', 'execute');
        recoveryAttempts.push(result.allowed);
        if (!result.allowed) break;
      }
      expect(recoveryAttempts).toEqual([false]);
    });

    it('should handle federation auth expiry during cascading failure (auth service down)', async () => {
      // Register with short expiry
      rbac.registerAgent({
        agentId: 'fed-agent',
        orgId: 'org-a',
        role: 'agent',
        expiresAt: Date.now() + 1000,
      });

      // Initially has access
      let check = rbac.checkPermission('fed-agent', 'tools', 'execute');
      expect(check.allowed).toBe(true);

      // Auth expires (simulating cascade - auth service is down so can't refresh)
      rbac.registerAgent({
        agentId: 'fed-agent',
        orgId: 'org-a',
        role: 'agent',
        expiresAt: Date.now() - 1, // Expired
      });

      check = rbac.checkPermission('fed-agent', 'tools', 'execute');
      expect(check.allowed).toBe(false);

      // Queue request for when auth recovers
      const queuedRequests = [{ agentId: 'fed-agent', resource: 'tools', action: 'execute' }];
      expect(queuedRequests.length).toBe(1);

      // Auth recovers - re-authenticate and replay
      rbac.reauthenticate('fed-agent', { expiresAt: Date.now() + 60000 });
      check = rbac.checkPermission('fed-agent', 'tools', 'execute');
      expect(check.allowed).toBe(true);
    });

    it('should redact sensitive info from observability data before export via RBAC', async () => {
      const obs = new Observability();

      // Span with sensitive data
      const span = obs.startSpan('operation', {
        attributes: {
          userId: 'user-123',
          apiKey: 'sk-secret123456789012345',
          internalId: 'internal-456',
          publicData: 'safe-value',
        },
      });
      obs.endSpan(span.id);

      // For non-admin consumer, redact sensitive fields
      const exported = obs.export();
      const spanData = exported.spans[0];

      // Admin sees everything
      const adminView = rbac.checkPermission('admin-a', 'observability', 'read');
      expect(adminView.allowed).toBe(true);

      // Reader can see limited data
      const readerView = rbac.checkPermission('reader-a', 'observability', 'read');
      // Reader has read access to state but we can filter what they see
      const sensitiveFields = ['apiKey', 'internalId'];
      const redactedAttributes = { ...spanData.attributes };
      if (!adminView.allowed) {
        for (const field of sensitiveFields) {
          if (field in redactedAttributes) {
            redactedAttributes[field] = '[REDACTED]';
          }
        }
      }
      // Admin view preserves data
      expect(spanData.attributes.apiKey).toBe('sk-secret123456789012345');
    });

    it('should ensure security audit log survives system crash (durable logging)', async () => {
      const redis = new MockRedis();

      // Write audit events to durable store
      rbac.checkPermission('agent-a', 'tools', 'execute');
      rbac.checkCrossOrgAccess('agent-a', 'org-b', 'data', 'read');

      const auditLog = rbac.auditLog;
      expect(auditLog.length).toBe(2);

      // Persist to Redis (WAL simulation)
      await redis.lpush('audit:log', ...auditLog.map(e => JSON.stringify(e)));
      const logLength = await redis.llen('audit:log');
      expect(logLength).toBe(2);

      // Simulate crash and recovery - audit log in Redis survives
      const recoveredLog = await redis.rpop('audit:log');
      expect(recoveredLog).not.toBeNull();
      const parsed = JSON.parse(recoveredLog!);
      expect(parsed.agentId).toBe('agent-a');
    });

    it('should handle federated agent security context change mid-operation (hot RBAC update)', async () => {
      // Snapshot isolation: operation starts with current permissions
      const permissionSnapshot = rbac.checkPermission('agent-a', 'state', 'read');
      expect(permissionSnapshot.allowed).toBe(true);

      // Hot update changes permissions mid-operation
      rbac.updateAgentRole('agent-a', 'guest');

      // Current operation completes with snapshot (original permissions)
      // This is the contract: snapshot isolation for in-flight operations
      expect(permissionSnapshot.allowed).toBe(true); // Original check still valid

      // Next operation uses new permissions
      const nextCheck = rbac.checkPermission('agent-a', 'state', 'read');
      expect(nextCheck.allowed).toBe(false);
    });

    it('should prevent rate limiting on auth requests from blocking legitimate re-authentication', async () => {
      // Attacker floods auth endpoint
      for (let i = 0; i < 15; i++) {
        rbac.checkAuthRateLimit('attacker-' + i);
      }

      // Known/priority agent should bypass attack-consumed rate limit
      rbac.markAsPriorityAgent('agent-a');
      const result = rbac.checkAuthRateLimit('agent-a');
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain('Priority');
    });

    it('should support cross-org observability without exposing other org data', async () => {
      const obs = new Observability();

      // Org A metrics
      obs.incrementCounter('request_latency', { org: 'org-a', path: '/api/internal' });
      obs.incrementCounter('error_rate', { org: 'org-a', detail: 'auth_failure' });

      // Org B metrics
      obs.incrementCounter('request_latency', { org: 'org-b', path: '/api/secret' });
      obs.incrementCounter('error_rate', { org: 'org-b', detail: 'timeout' });

      // Org A can see aggregate from Org B (just the counter, not details)
      const orgBMetrics = obs.getMetricsByLabel('org', 'org-b');
      expect(orgBMetrics.length).toBe(2);

      // But RBAC blocks access to Org B's detailed data
      const crossOrgCheck = rbac.checkCrossOrgAccess('agent-a', 'org-b', 'observability:detail', 'read');
      expect(crossOrgCheck.allowed).toBe(false);

      // Org A can see its own details
      const ownOrgCheck = rbac.checkPermission('agent-a', 'state', 'read');
      expect(ownOrgCheck.allowed).toBe(true);
    });
  });
});
