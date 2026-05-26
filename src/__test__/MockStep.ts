import type { StepContext } from '../interfaces/IStep.js';

export interface MockStepOptions {
  name?: string;
  shouldThrow?: boolean;
  throwError?: Error;
  delayMs?: number;
  modifyContext?: (ctx: StepContext) => StepContext;
  setShouldContinue?: boolean;
  dependsOn?: string[];
}

export class MockStep {
  readonly name: string;
  readonly dependsOn?: string[];
  private options: MockStepOptions;
  private _executeCalls: StepContext[] = [];

  constructor(options: MockStepOptions = {}) {
    this.name = options.name ?? 'mock-step';
    this.dependsOn = options.dependsOn;
    this.options = options;
  }

  get executeCalls() { return this._executeCalls; }
  get callCount() { return this._executeCalls.length; }

  async execute(context: StepContext): Promise<StepContext> {
    this._executeCalls.push({ ...context });

    if (this.options.shouldThrow) {
      throw this.options.throwError ?? new Error(`MockStep(${this.name}): execution failed`);
    }

    if (this.options.delayMs) {
      await new Promise(resolve => setTimeout(resolve, this.options.delayMs));
    }

    let result = { ...context };

    if (this.options.modifyContext) {
      result = this.options.modifyContext(result);
    }

    if (this.options.setShouldContinue !== undefined) {
      result.shouldContinue = this.options.setShouldContinue;
    }

    return result;
  }

  reset(): void {
    this._executeCalls = [];
  }
}

export function createMockStep(name: string, options?: Partial<MockStepOptions>): MockStep {
  return new MockStep({ name, ...options });
}

export function createMockSteps(...names: string[]): MockStep[] {
  return names.map(name => new MockStep({ name }));
}
