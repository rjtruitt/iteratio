import { Container } from 'inversify';
import 'reflect-metadata';

/**
 * Factory for creating and configuring InversifyJS DI containers.
 *
 * Provides static methods for creating default containers (with Singleton scope),
 * spawning child containers from a parent, and validating that required bindings
 * are present.
 */
export class ContainerFactory {
  /**
   * Create a new container with Singleton default scope and auto-bind injectables.
   *
   * @returns A new InversifyJS Container configured with Singleton as the default scope.
   */
  static createDefault(): Container {
    const container = new Container({
      defaultScope: 'Singleton',
      autoBindInjectable: true
    });

    return container;
  }

  /**
   * Create a child container from an existing parent.
   *
   * Child containers inherit all parent bindings but can override them locally.
   *
   * @param parent - The parent InversifyJS Container.
   * @returns A new child Container linked to the parent.
   */
  static createChild(parent: Container): Container {
    return parent.createChild();
  }

  /**
   * Validate that the container has all required bindings.
   *
   * Iterates over the provided tokens and throws if any are not bound.
   *
   * @param container - The InversifyJS Container to validate.
   * @param requiredTokens - Array of Symbol tokens that must be bound.
   * @throws {Error} If any required token is missing from the container.
   */
  static validate(container: Container, requiredTokens: symbol[]): void {
    const missing: symbol[] = [];

    for (const token of requiredTokens) {
      if (!container.isBound(token)) {
        missing.push(token);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `Container missing required bindings: ${missing.map(s => s.toString()).join(', ')}`
      );
    }
  }
}
