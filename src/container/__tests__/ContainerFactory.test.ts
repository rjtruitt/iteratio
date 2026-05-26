import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContainerFactory } from '../ContainerFactory';
import { TOKENS } from '../../types/Tokens';

describe('ContainerFactory', () => {
  describe('createDefault()', () => {
    it('should return a container', () => {
      const container = ContainerFactory.createDefault();
      expect(container).toBeDefined();
      expect(container).toHaveProperty('bind');
      expect(container).toHaveProperty('get');
    });

    it('should return a container that can resolve AgentLoop after binding', () => {
      const container = ContainerFactory.createDefault();

      // FAILS: createDefault() returns an empty container; AgentLoop is not pre-bound
      // This test asserts the desired behavior where createDefault() registers core services
      expect(container.isBound(TOKENS.IAgentLoop)).toBe(true);
    });

    it('should return a container that can resolve EventBus after binding', () => {
      const container = ContainerFactory.createDefault();

      // FAILS: createDefault() returns an empty container
      expect(container.isBound(TOKENS.IEventBus)).toBe(true);
    });

    it('should return a container that can resolve StateManager after binding', () => {
      const container = ContainerFactory.createDefault();

      // FAILS: createDefault() returns an empty container
      expect(container.isBound(TOKENS.IStateManager)).toBe(true);
    });

    it('should return a container that can resolve MessageManager after binding', () => {
      const container = ContainerFactory.createDefault();

      // FAILS: createDefault() returns an empty container
      expect(container.isBound(TOKENS.IMessageManager)).toBe(true);
    });
  });

  describe('createChild()', () => {
    it('should create a child container from parent', () => {
      const parent = ContainerFactory.createDefault();
      const child = ContainerFactory.createChild(parent);

      expect(child).toBeDefined();
      expect(child).not.toBe(parent);
    });

    it('should inherit parent bindings', () => {
      const parent = ContainerFactory.createDefault();
      const testToken = Symbol.for('TestService');
      parent.bind(testToken).toConstantValue('parent-value');

      const child = ContainerFactory.createChild(parent);

      expect(child.get(testToken)).toBe('parent-value');
    });

    it('should allow child to override parent bindings', () => {
      const parent = ContainerFactory.createDefault();
      const testToken = Symbol.for('OverridableService');
      parent.bind(testToken).toConstantValue('parent-value');

      const child = ContainerFactory.createChild(parent);
      child.bind(testToken).toConstantValue('child-value');

      expect(child.get(testToken)).toBe('child-value');
    });
  });

  describe('validate()', () => {
    it('should not throw for a valid container with all required bindings', () => {
      const container = ContainerFactory.createDefault();
      const token = Symbol.for('ValidToken');
      container.bind(token).toConstantValue('value');

      expect(() => ContainerFactory.validate(container, [token])).not.toThrow();
    });

    it('should throw if required bindings are missing', () => {
      const container = ContainerFactory.createDefault();
      const missingToken = Symbol.for('MissingService');

      expect(() => ContainerFactory.validate(container, [missingToken])).toThrow(/missing/i);
    });
  });
});
