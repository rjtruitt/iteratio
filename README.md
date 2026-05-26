# Iteratio

Agent execution loop library with a plugin architecture. Handles the request/response cycle with LLMs, tool execution, and conversation state.

## Install

```bash
npm install iteratio
```

## What It Does

Iteratio is the core loop that runs an AI agent. You provide a model adapter and tools, it manages:

- Request/response cycles with the LLM
- Tool call execution with error handling
- Conversation state and message history
- Lifecycle hooks (pre/post turn, tool call, etc.)
- Turn limits, timeouts, and interruption
- Context window management and compaction

It does NOT make LLM API calls directly — you provide an adapter that matches the `ILLMProvider` interface.

## Usage

```typescript
import { AgentLoop, MessageManager } from 'iteratio';

const loop = new AgentLoop({
  provider: myLLMAdapter,
  tools: [readFileTool, bashTool, editFileTool],
  maxTurns: 50,
});

const response = await loop.runTurn("Refactor the auth module");
```

## Plugin System

Iteratio uses a plugin architecture. Each concern is a separate package:

| Plugin | Purpose |
|--------|---------|
| `iteratio-plugin-tools` | Tool registration and execution |
| `iteratio-plugin-sessions` | Session persistence and restore |
| `iteratio-plugin-memory` | Long-term memory across sessions |
| `iteratio-plugin-retry` | Retry with backoff on failures |
| `iteratio-plugin-parallel` | Parallel tool execution |
| `iteratio-plugin-graph` | Graph-based workflow DAGs |
| `iteratio-plugin-a2a` | Agent-to-agent coordination |
| `iteratio-plugin-mcp` | MCP server integration |
| `iteratio-plugin-human` | Human-in-the-loop approval |
| `iteratio-plugin-metrics` | Token/cost/latency tracking |
| `iteratio-plugin-tracing` | OpenTelemetry-style tracing |
| `iteratio-plugin-state` | State management |
| `iteratio-plugin-constraints` | Resource constraints |
| `iteratio-plugin-workflow` | Task/TODO tracking |
| `iteratio-plugin-federation` | Multi-app federation |

## Core API

```typescript
interface IAgentLoop {
  runTurn(input: string, maxTurns?: number): Promise<string>;
  getMessageManager(): IMessageManager;
  getToolDefinitions(): ToolDefinition[];
  getTool(name: string): ITool | undefined;
  registerTool(tool: ITool): void;
  deregisterTool(name: string): void;
}

interface IMessageManager {
  addMessage(msg: Message): void;
  getMessages(): Message[];
  clear(): void;
  shouldCompact(): boolean;
  autoCompact(): Promise<CompactionResult | null>;
  takeSnapshot(): void;
}
```

## License

MIT
