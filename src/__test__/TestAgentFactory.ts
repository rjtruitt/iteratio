import type { ILLMProvider } from '../interfaces/ILLMProvider.js';
import type { ITransport } from '../interfaces/ITransport.js';
import type { IEventBus } from '../interfaces/IEventBus.js';
import type { IStateManager } from '../interfaces/IStateManager.js';
import type { IMessageManager } from '../interfaces/IMessageManager.js';
import type { IToolExecutor, ITool } from '../interfaces/IToolExecutor.js';
import { MockLLMProvider } from './MockLLMProvider.js';
import { MockTransport } from './MockTransport.js';
import { MockEventBus } from './MockEventBus.js';
import { MockStateManager } from './MockStateManager.js';
import { MockToolExecutor, createMockTool } from './MockToolExecutor.js';
import { MockMessageManager } from './MockMessageManager.js';
import { MockWorkerPool } from './MockWorkerPool.js';
import { MockAgentLoop } from './MockAgentLoop.js';
import { MockTransportManager } from './MockTransportManager.js';

export interface TestAgentDeps {
  llm?: ILLMProvider;
  transport?: ITransport;
  eventBus?: IEventBus;
  stateManager?: IStateManager;
  messageManager?: IMessageManager;
  toolExecutor?: IToolExecutor;
  tools?: ITool[];
}

export interface TestAgentContext {
  llm: MockLLMProvider;
  transport: MockTransport;
  eventBus: MockEventBus;
  stateManager: MockStateManager;
  messageManager: MockMessageManager;
  toolExecutor: MockToolExecutor;
}

export class TestAgentFactory {
  static create(deps: TestAgentDeps = {}): TestAgentContext {
    const llm = (deps.llm as MockLLMProvider) ?? new MockLLMProvider();
    const transport = (deps.transport as MockTransport) ?? new MockTransport();
    const eventBus = (deps.eventBus as MockEventBus) ?? new MockEventBus();
    const stateManager = (deps.stateManager as MockStateManager) ?? new MockStateManager();
    const messageManager = (deps.messageManager as MockMessageManager) ?? new MockMessageManager();
    const toolExecutor = (deps.toolExecutor as MockToolExecutor) ?? new MockToolExecutor();

    if (deps.tools) {
      toolExecutor.registerTools(deps.tools);
    }

    // Pre-populate stateManager with common mock objects used by scenario tests
    stateManager.set('workerPool', new MockWorkerPool(eventBus));
    const agentLoop = new MockAgentLoop(llm, eventBus);
    agentLoop.setTransport(transport);
    stateManager.set('agentLoop', agentLoop);
    stateManager.set('transportManager', new MockTransportManager(eventBus));

    // Wire transport to relay agent error events to eventBus
    transport.onPublish((topic: string, message: any) => {
      if (topic === 'agent:error') {
        eventBus.emit('remoteAgent:error', message);
      }
    });

    return { llm, transport, eventBus, stateManager, messageManager, toolExecutor };
  }

  static createWithTools(...toolNames: string[]): TestAgentContext {
    const tools = toolNames.map(name => createMockTool(name));
    return TestAgentFactory.create({ tools });
  }

  static createMinimal(): TestAgentContext {
    return TestAgentFactory.create();
  }
}
