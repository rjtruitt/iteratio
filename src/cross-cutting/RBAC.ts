export type Role = 'admin' | 'operator' | 'agent' | 'reader' | 'guest';

export interface Permission {
  resource: string;
  action: 'read' | 'write' | 'execute' | 'admin';
}

export interface RBACPolicy {
  roles: Map<Role, Permission[]>;
  inheritance: Map<Role, Role[]>; // role -> inherits from these roles
}

export interface AgentIdentityContext {
  agentId: string;
  orgId: string;
  role: Role;
  /** JWT or token expiry time */
  expiresAt?: number;
  /** Fencing token / epoch for stale leader rejection */
  fencingToken?: number;
}

export interface AccessAttempt {
  agentId: string;
  orgId: string;
  resource: string;
  action: string;
  allowed: boolean;
  reason: string;
  timestamp: number;
}

export interface RBACConfig {
  /** Default policy */
  policy: RBACPolicy;
  /** Enable audit logging */
  auditEnabled?: boolean;
  /** Separate rate limit buckets for auth */
  authRateLimitBuckets?: Map<string, number>;
}

export class RBAC {
  private policy: RBACPolicy;
  private agents = new Map<string, AgentIdentityContext>();
  private _auditLog: AccessAttempt[] = [];
  private auditEnabled: boolean;
  private revokedTokens = new Set<string>();
  private authRateLimits = new Map<string, { count: number; windowStart: number }>();
  private authRateLimitMax: number = 10;
  private priorityAgents = new Set<string>(); // Known-good agents bypass rate limits

  /**
   * Create a new RBAC policy engine.
   *
   * @param config - Configuration including the role/permission policy and audit settings
   */
  constructor(config: RBACConfig) {
    this.policy = config.policy;
    this.auditEnabled = config.auditEnabled ?? true;
    if (config.authRateLimitBuckets) {
      for (const [agentId] of config.authRateLimitBuckets) {
        this.priorityAgents.add(agentId);
      }
    }
  }

  get auditLog() { return this._auditLog; }

  /**
   * Register an agent with its identity
   */
  registerAgent(identity: AgentIdentityContext): void {
    this.agents.set(identity.agentId, identity);
  }

  /**
   * Check if an agent has permission for an action on a resource
   */
  checkPermission(agentId: string, resource: string, action: string): { allowed: boolean; reason: string } {
    const agent = this.agents.get(agentId);
    if (!agent) {
      const result = { allowed: false, reason: 'Agent not registered' };
      this.audit(agentId, 'unknown', resource, action, false, result.reason);
      return result;
    }

    if (agent.expiresAt && Date.now() > agent.expiresAt) {
      const result = { allowed: false, reason: 'Token expired' };
      this.audit(agentId, agent.orgId, resource, action, false, result.reason);
      return result;
    }

    if (this.revokedTokens.has(agentId)) {
      const result = { allowed: false, reason: 'Token revoked' };
      this.audit(agentId, agent.orgId, resource, action, false, result.reason);
      return result;
    }

    const effectivePermissions = this.getEffectivePermissions(agent.role);

    const hasPermission = effectivePermissions.some(
      p => (p.resource === resource || p.resource === '*') &&
           (p.action === action || p.action === 'admin')
    );

    const result = {
      allowed: hasPermission,
      reason: hasPermission ? 'Permission granted' : `Role '${agent.role}' lacks '${action}' on '${resource}'`,
    };

    this.audit(agentId, agent.orgId, resource, action, hasPermission, result.reason);
    return result;
  }

  /**
   * Check cross-org access
   */
  checkCrossOrgAccess(requestingAgentId: string, targetOrgId: string, resource: string, action: string): { allowed: boolean; reason: string } {
    const agent = this.agents.get(requestingAgentId);
    if (!agent) {
      return { allowed: false, reason: 'Agent not registered' };
    }

    if (agent.orgId !== targetOrgId) {
      const crossOrgResource = `cross-org:${targetOrgId}:${resource}`;
      const effectivePermissions = this.getEffectivePermissions(agent.role);
      const hasPermission = effectivePermissions.some(
        p => (p.resource === crossOrgResource || p.resource === `cross-org:${targetOrgId}:*` || p.resource === '*') &&
             (p.action === action || p.action === 'admin')
      );

      const result = {
        allowed: hasPermission,
        reason: hasPermission ? 'Cross-org access granted' : 'Cross-org access denied',
      };
      this.audit(requestingAgentId, agent.orgId, crossOrgResource, action, hasPermission, result.reason);
      return result;
    }

    return this.checkPermission(requestingAgentId, resource, action);
  }

  /**
   * Attempt privilege escalation (should be denied)
   */
  requestEscalation(agentId: string, requestedRole: Role): { allowed: boolean; reason: string } {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { allowed: false, reason: 'Agent not registered' };
    }

    const roleHierarchy: Role[] = ['guest', 'reader', 'agent', 'operator', 'admin'];
    const currentLevel = roleHierarchy.indexOf(agent.role);
    const requestedLevel = roleHierarchy.indexOf(requestedRole);

    if (requestedLevel > currentLevel) {
      const result = { allowed: false, reason: `Privilege escalation denied: ${agent.role} cannot become ${requestedRole}` };
      this.audit(agentId, agent.orgId, 'role-escalation', 'escalate', false, result.reason);
      return result;
    }

    return { allowed: true, reason: 'Role already held or lower' };
  }

  /**
   * Revoke an agent's access
   */
  revokeAccess(agentId: string): void {
    this.revokedTokens.add(agentId);
  }

  /**
   * Re-authenticate an agent (clear revocation)
   */
  reauthenticate(agentId: string, newIdentity?: Partial<AgentIdentityContext>): void {
    this.revokedTokens.delete(agentId);
    if (newIdentity) {
      const existing = this.agents.get(agentId);
      if (existing) {
        this.agents.set(agentId, { ...existing, ...newIdentity });
      }
    }
  }

  /**
   * Update policy at runtime (hot update)
   */
  updatePolicy(newPolicy: Partial<RBACPolicy>): void {
    if (newPolicy.roles) this.policy.roles = newPolicy.roles;
    if (newPolicy.inheritance) this.policy.inheritance = newPolicy.inheritance;
  }

  /**
   * Update agent role
   */
  updateAgentRole(agentId: string, newRole: Role): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.role = newRole;
    }
  }

  /**
   * Check auth rate limit
   */
  checkAuthRateLimit(agentId: string): { allowed: boolean; reason: string } {
    if (this.priorityAgents.has(agentId)) {
      return { allowed: true, reason: 'Priority agent' };
    }

    const now = Date.now();
    const bucket = this.authRateLimits.get(agentId) || { count: 0, windowStart: now };

    if (now - bucket.windowStart > 60000) {
      bucket.count = 0;
      bucket.windowStart = now;
    }

    bucket.count++;
    this.authRateLimits.set(agentId, bucket);

    if (bucket.count > this.authRateLimitMax) {
      return { allowed: false, reason: 'Auth rate limit exceeded' };
    }

    return { allowed: true, reason: 'Within rate limit' };
  }

  /**
   * Mark agent as known/priority (separate rate limit lane)
   */
  markAsPriorityAgent(agentId: string): void {
    this.priorityAgents.add(agentId);
  }

  /**
   * Validate agent identity (prevent impersonation)
   */
  validateIdentity(claimedIdentity: AgentIdentityContext, credentials: { orgId: string; token?: string }): { valid: boolean; reason: string } {
    if (claimedIdentity.orgId !== credentials.orgId) {
      return { valid: false, reason: 'Org ID mismatch: possible impersonation' };
    }
    return { valid: true, reason: 'Identity validated' };
  }

  /**
   * Sanitize message for injection attacks
   */
  sanitizeMessage(message: string): { clean: boolean; sanitized: string; threats: string[] } {
    const threats: string[] = [];
    let sanitized = message;

    const injectionPatterns = [
      { pattern: /\{\{.*?\}\}/g, name: 'template injection' },
      { pattern: /<script.*?>.*?<\/script>/gi, name: 'XSS injection' },
      { pattern: /;\s*(DROP|DELETE|UPDATE|INSERT)\s/gi, name: 'SQL injection' },
      { pattern: /\$\{.*?\}/g, name: 'expression injection' },
    ];

    for (const { pattern, name } of injectionPatterns) {
      if (pattern.test(sanitized)) {
        threats.push(name);
        sanitized = sanitized.replace(pattern, '[SANITIZED]');
      }
    }

    return {
      clean: threats.length === 0,
      sanitized,
      threats,
    };
  }

  /**
   * Get effective permissions for a role (with inheritance)
   */
  /**
   * Get effective permissions for a role, including inherited permissions from parent roles.
   *
   * @param role - The role to resolve permissions for
   * @returns Array of resolved Permission objects
   */
  private getEffectivePermissions(role: Role): Permission[] {
    const directPermissions = this.policy.roles.get(role) || [];
    const inherited: Permission[] = [];

    const parentRoles = this.policy.inheritance.get(role) || [];
    for (const parentRole of parentRoles) {
      inherited.push(...this.getEffectivePermissions(parentRole));
    }

    return [...directPermissions, ...inherited];
  }

  /**
   * Record an access attempt in the audit log if audit logging is enabled.
   *
   * @param agentId - The agent that attempted access
   * @param orgId - The organization ID
   * @param resource - The resource being accessed
   * @param action - The action being performed
   * @param allowed - Whether access was granted
   * @param reason - Human-readable reason for the decision
   */
  private audit(agentId: string, orgId: string, resource: string, action: string, allowed: boolean, reason: string): void {
    if (!this.auditEnabled) return;
    this._auditLog.push({
      agentId,
      orgId,
      resource,
      action,
      allowed,
      reason,
      timestamp: Date.now(),
    });
  }

  getAgent(agentId: string): AgentIdentityContext | undefined {
    return this.agents.get(agentId);
  }

  reset(): void {
    this.agents.clear();
    this._auditLog = [];
    this.revokedTokens.clear();
    this.authRateLimits.clear();
  }
}

/**
 * Create a default RBAC policy with role hierarchy
 */
export function createDefaultPolicy(): RBACPolicy {
  const roles = new Map<Role, Permission[]>();

  roles.set('admin', [{ resource: '*', action: 'admin' }]);
  roles.set('operator', [
    { resource: '*', action: 'read' },
    { resource: '*', action: 'write' },
    { resource: '*', action: 'execute' },
  ]);
  roles.set('agent', [
    { resource: 'tools', action: 'execute' },
    { resource: 'state', action: 'read' },
    { resource: 'state', action: 'write' },
    { resource: 'memory', action: 'read' },
    { resource: 'memory', action: 'write' },
  ]);
  roles.set('reader', [
    { resource: 'state', action: 'read' },
    { resource: 'memory', action: 'read' },
    { resource: 'tools', action: 'read' },
  ]);
  roles.set('guest', []);

  const inheritance = new Map<Role, Role[]>();
  inheritance.set('admin', ['operator']);
  inheritance.set('operator', ['agent']);
  inheritance.set('agent', ['reader']);
  inheritance.set('reader', ['guest']);

  return { roles, inheritance };
}
