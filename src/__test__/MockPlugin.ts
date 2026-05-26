import type { IPlugin, PluginConfig, TurnContext } from '../interfaces/IPlugin.js';

export interface MockPluginOptions {
  name?: string;
  version?: string;
  beforeTurnShouldThrow?: boolean;
  afterTurnShouldThrow?: boolean;
  initializeShouldThrow?: boolean;
  shutdownShouldThrow?: boolean;
}

export class MockPlugin implements IPlugin {
  readonly name: string;
  readonly version: string;

  private options: MockPluginOptions;
  private _initializeCalls = 0;
  private _configureCalls = 0;
  private _beforeTurnCalls: TurnContext[] = [];
  private _afterTurnCalls: TurnContext[] = [];
  private _shutdownCalls = 0;
  private _config?: PluginConfig;

  constructor(options: MockPluginOptions = {}) {
    this.name = options.name ?? 'mock-plugin';
    this.version = options.version ?? '1.0.0';
    this.options = options;
  }

  get initializeCalls() { return this._initializeCalls; }
  get configureCalls() { return this._configureCalls; }
  get beforeTurnCalls() { return this._beforeTurnCalls; }
  get afterTurnCalls() { return this._afterTurnCalls; }
  get shutdownCalls() { return this._shutdownCalls; }
  get lastConfig() { return this._config; }

  async initialize(container: any): Promise<void> {
    this._initializeCalls++;
    if (this.options.initializeShouldThrow) {
      throw new Error(`MockPlugin(${this.name}): initialize failed`);
    }
  }

  configure(config: PluginConfig): void {
    this._configureCalls++;
    this._config = config;
  }

  async beforeTurn(context: TurnContext): Promise<void> {
    this._beforeTurnCalls.push({ ...context });
    if (this.options.beforeTurnShouldThrow) {
      throw new Error(`MockPlugin(${this.name}): beforeTurn failed`);
    }
  }

  async afterTurn(context: TurnContext): Promise<void> {
    this._afterTurnCalls.push({ ...context });
    if (this.options.afterTurnShouldThrow) {
      throw new Error(`MockPlugin(${this.name}): afterTurn failed`);
    }
  }

  async shutdown(): Promise<void> {
    this._shutdownCalls++;
    if (this.options.shutdownShouldThrow) {
      throw new Error(`MockPlugin(${this.name}): shutdown failed`);
    }
  }

  reset(): void {
    this._initializeCalls = 0;
    this._configureCalls = 0;
    this._beforeTurnCalls = [];
    this._afterTurnCalls = [];
    this._shutdownCalls = 0;
    this._config = undefined;
  }
}

export function createMockPlugin(name: string, options?: Partial<MockPluginOptions>): MockPlugin {
  return new MockPlugin({ name, ...options });
}
