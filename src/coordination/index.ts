/**
 * Coordination module — provides worker pools, task queues, scheduled
 * workflow runners, event-driven trigger managers, and external service
 * pollers for orchestrating multi-agent execution.
 *
 * @module coordination
 */

export { WorkerPool, WorkerPoolBuilder, TaskQueue } from './WorkerPool.js';
export type { Task, QueueStats, WorkerPoolConfig } from './WorkerPool.js';
export { ScheduledWorkflowRunner } from './ScheduledWorkflowRunner.js';
export { WorkflowTriggerManager } from './WorkflowTriggerManager.js';
export { ExternalServicePoller } from './ExternalServicePoller.js';
