export {
  AgentRegistry,
  resetSharedBackends,
  type AgentIdentity,
  type AgentRole,
  type AgentStatus,
  type LLMProvider,
  type RegistryBackend,
  type DiscoveryQuery,
  type RegistryConfig,
  type IRegistryBackend,
} from './AgentRegistry.js';

export {
  DistributedHierarchy,
  type SpawnRequest,
  type SpawnResult,
  type AgentTree,
  type MachineInfo,
  type HierarchyConfig,
} from './DistributedHierarchy.js';

export {
  AgentMessageBus,
  type MessageType,
  type AgentMessage,
  type BroadcastFilter,
  type MessageBusConfig,
  type ITransport,
} from './AgentMessageBus.js';

export {
  WorkCoordinator,
  type WorkStatus,
  type WorkItem,
  type ClaimOptions,
  type ReleaseOptions,
  type WorkAssignment,
  type SimilarityResult,
  type WorkCoordinatorConfig,
} from './WorkCoordinator.js';

export {
  LeaderElection,
  type LeadershipRole,
  type LeaderInfo,
  type CampaignOptions,
  type LeaderElectionConfig,
  type IElectionBackend,
  withLeadership,
  waitForLeadership,
} from './LeaderElection.js';

export {
  HealthMonitor,
  type HealthStatus,
  type HealthCheck,
  type FailureEvent,
  type RecoveryStrategy,
  type HealthMonitorConfig,
  type HealthMetrics,
} from './HealthMonitor.js';

export {
  ErrorType,
  ErrorCategory,
  DistributedError,
  classifyError,
  categorizeError,
  retryWithBackoff,
  executeWithFallback,
  CircuitState,
  DistributedCircuitBreaker,
  CircuitBreaker,
  ErrorMetrics,
} from './ErrorHandling.js';
export type {
  RetryConfig,
  RetryResult,
  CircuitBreakerConfig,
} from './ErrorHandling.js';
