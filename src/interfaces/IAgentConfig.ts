import { ILLMProvider } from './ILLMProvider.js';
import { ITool } from './IToolExecutor.js';

/** Agent identity for distributed systems and hierarchy tracking. */
export interface AgentIdentity {
  id: string;
  role: 'overseer' | 'orchestrator' | 'worker' | 'task';
  parentId?: string;
  children: string[];
  machineId: string;
  hostname: string;
  pid: number;
  llmProvider: 'anthropic' | 'openai' | 'bedrock' | 'local';
  llmModel: string;
  capabilities: string[];
  status: 'starting' | 'idle' | 'running' | 'paused' | 'stopped' | 'crashed';
  lastHeartbeat: number;
  endpoints?: {
    rpc?: string;
    ws?: string;
    http?: string;
  };
}

/** Agent configuration for builder and runtime initialization. */
export interface AgentConfig {
  name: string;
  role?: 'overseer' | 'orchestrator' | 'worker' | 'task';
  capabilities?: string[];
  llm: ILLMProvider | LLMConfig;
  tools?: ITool[] | Record<string, ITool>;
  systemPrompt?: string;
  instructions?: string;
  maxTokens?: number;
  temperature?: number;
  checkpointing?: {
    backend?: 'auto' | 'memory' | 'indexeddb' | 'sqlite' | 'postgres' | 'redis';
    path?: string;
    url?: string;
  };
  threading?: ThreadingConfig;
  parentId?: string;
  workingDirectory?: string;
  distributed?: DistributedConfig;
}

/** LLM provider configuration (alternative to passing an ILLM instance). */
export interface LLMConfig {
  provider: 'anthropic' | 'openai' | 'bedrock' | 'local' | 'ollama' | 'gemini';
  model: string;
  apiKey?: string;
  endpoint?: string;
  region?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stopSequences?: string[];
}

/** Threading configuration for child agent execution model. */
export interface ThreadingConfig {
  mode: 'main' | 'worker' | 'process';
  workerData?: any;
  resourceLimits?: {
    maxOldGenerationSizeMb?: number;
    maxYoungGenerationSizeMb?: number;
    codeRangeSizeMb?: number;
  };
  env?: Record<string, string>;
  cwd?: string;
  workerScript?: string;
}

/** Distributed infrastructure configuration. */
export interface DistributedConfig {
  registry?: {
    backend: 'etcd' | 'redis' | 'consul';
    url: string;
    ttl?: number;
  };
  messageBus?: {
    backend: 'nats' | 'redis-pubsub' | 'rabbitmq';
    url: string;
    auth?: {
      type: 'apikey' | 'jwt' | 'basic' | 'nkey';
      credentials?: Record<string, string>;
    };
  };
  stateStore?: {
    backend: 'redis' | 'postgres' | 'dynamodb';
    url: string;
  };
  shareModels?: boolean;
  useSharedModels?: boolean;
  shareTools?: boolean;
  useSharedTools?: boolean;
}
