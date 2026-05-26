import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TestAgentFactory,
  MockLLMProvider,
  MockEventBus,
  MockStateManager,
  MockToolExecutor,
  createMockTool,
  TestClock,
  TestScheduler,
} from '../../__test__';

// --- E2E Scenario 29: Security Hardening ---
// Tests injection prevention, path traversal, SQL injection, XSS sanitization,
// secret leakage, permission escalation, RBAC, sandbox escape, rate limit bypass,
// replay attacks, DoS, and recursive bomb protection.

describe('E2E Scenario 29: Security Hardening', () => {
  let eventBus: MockEventBus;
  let stateManager: MockStateManager;
  let llm: MockLLMProvider;
  let toolExecutor: MockToolExecutor;
  let clock: TestClock;
  let scheduler: TestScheduler;

  beforeEach(() => {
    const ctx = TestAgentFactory.create();
    eventBus = ctx.eventBus;
    stateManager = ctx.stateManager;
    llm = ctx.llm;
    toolExecutor = ctx.toolExecutor;
    clock = new TestClock();
    scheduler = new TestScheduler();
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
    scheduler.reset();
  });

  describe('Command Injection Prevention', () => {
    it('should block command injection in tool arguments', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.setToolExecutor(toolExecutor);
      agent.start();

      // LLM tries to inject shell command via tool args
      llm.invoke = async () => MockLLMProvider.toolCallResponse([
        { id: 'tc-1', name: 'run-command', arguments: '{"cmd": "ls; rm -rf /"}' },
      ]);

      const result = await agent.runTurn('do something');

      expect(result.securityBlocked).toBe(true);
      expect(result.securityViolation.type).toBe('command-injection');
      expect(eventBus.emitted('security:blocked')).toBe(true);
    });

    it('should block backtick injection in arguments', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.setToolExecutor(toolExecutor);
      agent.start();

      llm.invoke = async () => MockLLMProvider.toolCallResponse([
        { id: 'tc-1', name: 'shell', arguments: '{"input": "`whoami`"}' },
      ]);

      const result = await agent.runTurn('test');

      expect(result.securityBlocked).toBe(true);
    });

    it('should allow safe command arguments', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      toolExecutor.setResult('safe-tool', { success: true, data: 'ok' });
      agent.setToolExecutor(toolExecutor);
      agent.start();

      llm.invoke = async () => MockLLMProvider.toolCallResponse([
        { id: 'tc-1', name: 'safe-tool', arguments: '{"input": "hello world"}' },
      ]);

      const result = await agent.runTurn('test');

      expect(result.securityBlocked).toBeUndefined();
    });
  });

  describe('Path Traversal Prevention', () => {
    it('should block path traversal in file tool arguments', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.setToolExecutor(toolExecutor);
      agent.start();

      llm.invoke = async () => MockLLMProvider.toolCallResponse([
        { id: 'tc-1', name: 'file-read', arguments: '{"path": "../../../etc/passwd"}' },
      ]);

      const result = await agent.runTurn('read file');

      expect(result.securityBlocked).toBe(true);
      expect(result.securityViolation.type).toBe('path-traversal');
    });

    it('should block encoded path traversal (..%2F..%2F)', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.setToolExecutor(toolExecutor);
      agent.start();

      llm.invoke = async () => MockLLMProvider.toolCallResponse([
        { id: 'tc-1', name: 'file-read', arguments: '{"path": "..%2F..%2Fetc%2Fpasswd"}' },
      ]);

      const result = await agent.runTurn('read');

      expect(result.securityBlocked).toBe(true);
    });

    it('should allow paths within allowed directory', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.setAllowedPaths(['/workspace']);
      toolExecutor.setResult('file-read', { success: true, data: 'contents' });
      agent.setToolExecutor(toolExecutor);
      agent.start();

      llm.invoke = async () => MockLLMProvider.toolCallResponse([
        { id: 'tc-1', name: 'file-read', arguments: '{"path": "/workspace/src/index.ts"}' },
      ]);

      const result = await agent.runTurn('read');

      expect(result.securityBlocked).toBeUndefined();
    });
  });

  describe('SQL Injection Prevention', () => {
    it('should block SQL injection in database tool arguments', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.setToolExecutor(toolExecutor);
      agent.start();

      llm.invoke = async () => MockLLMProvider.toolCallResponse([
        { id: 'tc-1', name: 'db-query', arguments: '{"query": "SELECT * FROM users; DROP TABLE users;--"}' },
      ]);

      const result = await agent.runTurn('query db');

      expect(result.securityBlocked).toBe(true);
      expect(result.securityViolation.type).toBe('sql-injection');
    });

    it('should block UNION-based SQL injection', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.setToolExecutor(toolExecutor);
      agent.start();

      llm.invoke = async () => MockLLMProvider.toolCallResponse([
        { id: 'tc-1', name: 'db-query', arguments: '{"query": "SELECT name FROM products UNION SELECT password FROM users"}' },
      ]);

      const result = await agent.runTurn('query');

      expect(result.securityBlocked).toBe(true);
    });
  });

  describe('XSS Sanitization', () => {
    it('should sanitize XSS in LLM output', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.start();

      llm.invoke = async () => MockLLMProvider.simpleResponse(
        'Here is the result: <script>alert("xss")</script>'
      );

      const result = await agent.runTurn('hello');

      expect(result.content).not.toContain('<script>');
      expect(result.sanitized).toBe(true);
    });

    it('should sanitize event handler attributes in output', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.start();

      llm.invoke = async () => MockLLMProvider.simpleResponse(
        '<img src=x onerror="alert(1)">'
      );

      const result = await agent.runTurn('test');

      expect(result.content).not.toContain('onerror');
    });
  });

  describe('Secret Leakage Prevention', () => {
    it('should redact API keys in LLM response', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.setSecretPatterns([/sk-[a-zA-Z0-9]{32,}/, /AKIA[A-Z0-9]{16}/]);
      agent.start();

      llm.invoke = async () => MockLLMProvider.simpleResponse(
        'The API key is sk-abcdefghijklmnopqrstuvwxyz123456 and AWS key is AKIAIOSFODNN7EXAMPLE'
      );

      const result = await agent.runTurn('show keys');

      expect(result.content).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
      expect(result.content).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(result.content).toContain('[REDACTED]');
      expect(eventBus.emitted('security:secretRedacted')).toBe(true);
    });

    it('should redact secrets in tool output before returning to LLM', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.setSecretPatterns([/password=\S+/]);
      toolExecutor.setResult('env-reader', {
        success: true,
        data: 'DATABASE_URL=postgres://user:password=s3cr3t@host/db',
      });
      agent.setToolExecutor(toolExecutor);
      agent.start();

      llm.invoke = async () => MockLLMProvider.toolCallResponse([
        { id: 'tc-1', name: 'env-reader', arguments: '{}' },
      ]);

      const result = await agent.runTurn('read env');

      // Tool result sent back to LLM should be redacted
      expect(result.toolResults[0].data).not.toContain('s3cr3t');
    });
  });

  describe('Permission Escalation Prevention', () => {
    it('should deny permission escalation attempt', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.setRole('reader'); // read-only role
      agent.setToolExecutor(toolExecutor);
      agent.start();

      llm.invoke = async () => MockLLMProvider.toolCallResponse([
        { id: 'tc-1', name: 'set-role', arguments: '{"role": "admin"}' },
      ]);

      const result = await agent.runTurn('escalate');

      expect(result.securityBlocked).toBe(true);
      expect(result.securityViolation.type).toBe('privilege-escalation');
    });

    it('should log escalation attempt with agent context', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.setAgentId('suspicious-agent');
      agent.setRole('reader');
      agent.setToolExecutor(toolExecutor);
      agent.start();

      llm.invoke = async () => MockLLMProvider.toolCallResponse([
        { id: 'tc-1', name: 'modify-permissions', arguments: '{"grant": "admin"}' },
      ]);

      await agent.runTurn('escalate');

      const log = eventBus.lastEmitted<any>('security:blocked');
      expect(log.agentId).toBe('suspicious-agent');
      expect(log.attemptedAction).toContain('permission');
    });
  });

  describe('Unauthorized Tool Access (RBAC)', () => {
    it('should block agent from using tool not in its allowed list', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.setAllowedTools(['calculator', 'web-search']);
      agent.setToolExecutor(toolExecutor);
      agent.start();

      llm.invoke = async () => MockLLMProvider.toolCallResponse([
        { id: 'tc-1', name: 'delete-database', arguments: '{}' },
      ]);

      const result = await agent.runTurn('delete everything');

      expect(result.securityBlocked).toBe(true);
      expect(result.securityViolation.type).toBe('unauthorized-tool');
    });

    it('should allow agent to use tools in its allowed list', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.setAllowedTools(['calculator']);
      toolExecutor.setResult('calculator', { success: true, data: { result: 42 } });
      agent.setToolExecutor(toolExecutor);
      agent.start();

      llm.invoke = async () => MockLLMProvider.toolCallResponse([
        { id: 'tc-1', name: 'calculator', arguments: '{"expr": "6*7"}' },
      ]);

      const result = await agent.runTurn('calculate');

      expect(result.securityBlocked).toBeUndefined();
    });
  });

  describe('Sandbox Escape Prevention', () => {
    it('should contain sandbox escape attempt', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.enableSandbox();
      agent.setToolExecutor(toolExecutor);
      agent.start();

      // Tool tries to access outside sandbox
      llm.invoke = async () => MockLLMProvider.toolCallResponse([
        { id: 'tc-1', name: 'code-exec', arguments: '{"code": "require(\\\"child_process\\\").execSync(\\\"cat /etc/shadow\\\")"}' },
      ]);

      const result = await agent.runTurn('run code');

      expect(result.securityBlocked).toBe(true);
      expect(result.securityViolation.type).toBe('sandbox-escape');
    });

    it('should block require/import of dangerous modules', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.enableSandbox();
      agent.setBlockedModules(['child_process', 'fs', 'net']);
      agent.setToolExecutor(toolExecutor);
      agent.start();

      llm.invoke = async () => MockLLMProvider.toolCallResponse([
        { id: 'tc-1', name: 'code-exec', arguments: '{"code": "const fs = require(\\\"fs\\\"); fs.readFileSync(\\\"/etc/passwd\\\")"}' },
      ]);

      const result = await agent.runTurn('exec');

      expect(result.securityBlocked).toBe(true);
    });
  });

  describe('Rate Limit Bypass Detection', () => {
    it('should detect rate limit bypass attempt', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.start();

      // Attempt to bypass rate limit by forging headers/tokens
      const result = await agent.handleRequest({
        input: 'test',
        headers: { 'X-Rate-Limit-Bypass': 'true', 'X-Forwarded-For': '127.0.0.1' },
      });

      expect(result.securityBlocked).toBe(true);
      expect(result.securityViolation.type).toBe('rate-limit-bypass');
    });
  });

  describe('Replay Attack Prevention', () => {
    it('should reject reuse of expired auth token', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.start();

      const token = agent.generateAuthToken({ agentId: 'a', expiresIn: 1000 });

      // Use token successfully
      const first = await agent.authenticateRequest({ token });
      expect(first.authenticated).toBe(true);

      // Token expires
      clock.advance(1500);

      // Replay with expired token
      const replay = await agent.authenticateRequest({ token });
      expect(replay.authenticated).toBe(false);
      expect(replay.reason).toContain('expired');
    });

    it('should reject duplicate request nonce', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.start();

      const nonce = 'unique-nonce-123';

      const first = await agent.handleRequest({ input: 'test', nonce });
      expect(first.securityBlocked).toBeUndefined();

      // Same nonce reused
      const replay = await agent.handleRequest({ input: 'test', nonce });
      expect(replay.securityBlocked).toBe(true);
      expect(replay.securityViolation.type).toBe('replay-attack');
    });
  });

  describe('DoS Prevention', () => {
    it('should enforce payload size limit', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.setMaxPayloadSize(1024); // 1KB
      agent.start();

      const largeInput = 'x'.repeat(10000); // 10KB

      const result = await agent.handleRequest({ input: largeInput });

      expect(result.securityBlocked).toBe(true);
      expect(result.securityViolation.type).toBe('payload-too-large');
    });

    it('should reject payload exceeding limit with appropriate error', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.setMaxPayloadSize(512);
      agent.start();

      const result = await agent.handleRequest({ input: 'y'.repeat(1000) });

      expect(result.securityViolation.maxAllowed).toBe(512);
      expect(result.securityViolation.actual).toBeGreaterThan(512);
    });
  });

  describe('Recursive Tool Call Bomb Prevention', () => {
    it('should enforce depth limit on recursive tool calls', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.setMaxToolDepth(5);
      agent.setToolExecutor(toolExecutor);
      agent.start();

      // LLM keeps requesting tool calls recursively
      let callCount = 0;
      llm.invoke = async () => {
        callCount++;
        return MockLLMProvider.toolCallResponse([
          { id: `tc-${callCount}`, name: 'recursive-tool', arguments: '{}' },
        ]);
      };

      const result = await agent.runTurn('start recursion');

      expect(callCount).toBeLessThanOrEqual(5);
      expect(result.securityViolation?.type).toBe('depth-limit-exceeded');
    });

    it('should emit warning at 80% of depth limit', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.setMaxToolDepth(10);
      agent.setToolExecutor(toolExecutor);
      agent.start();

      let callCount = 0;
      llm.invoke = async () => {
        callCount++;
        if (callCount > 10) return MockLLMProvider.simpleResponse('done');
        return MockLLMProvider.toolCallResponse([
          { id: `tc-${callCount}`, name: 'deep-tool', arguments: '{}' },
        ]);
      };

      await agent.runTurn('go deep');

      expect(eventBus.emitted('security:depthWarning')).toBe(true);
    });

    it('should count nested tool calls toward the depth limit', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableSecurityHardening();
      agent.setMaxToolDepth(3);
      agent.setToolExecutor(toolExecutor);
      agent.start();

      // Each turn has tool calls
      let callCount = 0;
      llm.invoke = async () => {
        callCount++;
        if (callCount > 5) return MockLLMProvider.simpleResponse('done');
        return MockLLMProvider.toolCallResponse([
          { id: `tc-${callCount}`, name: 'nested', arguments: '{}' },
        ]);
      };

      const result = await agent.runTurn('nest deeply');

      expect(callCount).toBeLessThanOrEqual(4); // 3 tool calls + final response
    });
  });
});
