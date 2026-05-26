/**
 * Scenario Family 12: Static Agent Hierarchy (Defined Subagents)
 * Tests supervisor-specialist delegation, capability matching,
 * handoff protocols, return handoffs, and concurrent specialist execution.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MockLLMProvider,
  MockTransport,
  MockEventBus,
  MockStateManager,
  MockMessageManager,
  MockToolExecutor,
  TestAgentFactory,
  TestClock,
} from '../../__test__';

// These imports will fail until the actual modules are implemented
import { AgentLoop } from '../../core/AgentLoop';
import { SupervisorAgent } from '../../agents/SupervisorAgent';
import { SpecialistAgent } from '../../agents/SpecialistAgent';
import { AgentHierarchy } from '../../agents/AgentHierarchy';
import { HandoffProtocol } from '../../agents/HandoffProtocol';

describe('Defined Subagents - E2E', () => {
  let transport: MockTransport;
  let eventBus: MockEventBus;
  let clock: TestClock;

  beforeEach(() => {
    transport = new MockTransport();
    eventBus = new MockEventBus();
    clock = new TestClock();
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
  });

  describe('supervisor delegates to known specialists', () => {
    it('should delegate a coding task to the coder specialist', async () => {
      const supervisorLLM = new MockLLMProvider({
        defaultResponse: MockLLMProvider.simpleResponse(
          JSON.stringify({ action: 'delegate', target: 'coder', task: 'Write a sort function' })
        ),
      });

      const coderLLM = new MockLLMProvider({
        defaultResponse: MockLLMProvider.simpleResponse('function sort(arr) { return arr.sort(); }'),
      });

      const hierarchy = new AgentHierarchy({
        supervisor: new SupervisorAgent({
          id: 'supervisor',
          llm: supervisorLLM,
          eventBus,
        }),
        specialists: [
          new SpecialistAgent({ id: 'coder', llm: coderLLM, capabilities: ['coding', 'debugging'], eventBus }),
          new SpecialistAgent({ id: 'writer', llm: new MockLLMProvider(), capabilities: ['writing', 'editing'], eventBus }),
        ],
        transport,
        eventBus,
      });

      const result = await hierarchy.execute('Write a sort function');
      expect(result.delegatedTo).toBe('coder');
      expect(result.output).toContain('sort');
    });

    it('should delegate a writing task to the writer specialist', async () => {
      const supervisorLLM = new MockLLMProvider({
        defaultResponse: MockLLMProvider.simpleResponse(
          JSON.stringify({ action: 'delegate', target: 'writer', task: 'Write a blog post' })
        ),
      });

      const writerLLM = new MockLLMProvider({
        defaultResponse: MockLLMProvider.simpleResponse('# Blog Post\n\nHere is my post about AI...'),
      });

      const hierarchy = new AgentHierarchy({
        supervisor: new SupervisorAgent({
          id: 'supervisor',
          llm: supervisorLLM,
          eventBus,
        }),
        specialists: [
          new SpecialistAgent({ id: 'coder', llm: new MockLLMProvider(), capabilities: ['coding'], eventBus }),
          new SpecialistAgent({ id: 'writer', llm: writerLLM, capabilities: ['writing'], eventBus }),
        ],
        transport,
        eventBus,
      });

      const result = await hierarchy.execute('Write a blog post about AI');
      expect(result.delegatedTo).toBe('writer');
      expect(result.output).toContain('Blog Post');
    });

    it('should provide context to specialist when delegating', async () => {
      const coderLLM = new MockLLMProvider({
        defaultResponse: MockLLMProvider.simpleResponse('Implementation done'),
      });

      const hierarchy = new AgentHierarchy({
        supervisor: new SupervisorAgent({
          id: 'supervisor',
          llm: new MockLLMProvider({
            defaultResponse: MockLLMProvider.simpleResponse(
              JSON.stringify({
                action: 'delegate',
                target: 'coder',
                task: 'Implement the feature',
                context: { language: 'TypeScript', framework: 'React' },
              })
            ),
          }),
          eventBus,
        }),
        specialists: [
          new SpecialistAgent({ id: 'coder', llm: coderLLM, capabilities: ['coding'], eventBus }),
        ],
        transport,
        eventBus,
      });

      await hierarchy.execute('Implement the feature');

      // Specialist should receive the context in its messages
      expect(coderLLM.calls[0].messages.some(m =>
        m.content?.includes('TypeScript') || m.content?.includes('React')
      )).toBe(true);
    });
  });

  describe('specialist completes and reports back', () => {
    it('should return specialist result to supervisor', async () => {
      const supervisorLLM = MockLLMProvider.sequencedResponses(
        MockLLMProvider.simpleResponse(JSON.stringify({ action: 'delegate', target: 'coder', task: 'Fix bug' })),
        MockLLMProvider.simpleResponse('The bug has been fixed by the coder.'),
      );

      const coderLLM = new MockLLMProvider({
        defaultResponse: MockLLMProvider.simpleResponse('Bug fixed: removed null reference'),
      });

      const hierarchy = new AgentHierarchy({
        supervisor: new SupervisorAgent({ id: 'supervisor', llm: supervisorLLM, eventBus }),
        specialists: [
          new SpecialistAgent({ id: 'coder', llm: coderLLM, capabilities: ['coding'], eventBus }),
        ],
        transport,
        eventBus,
      });

      const result = await hierarchy.execute('Fix the null pointer bug');
      expect(result.output).toContain('bug has been fixed');
      expect(supervisorLLM.callCount).toBe(2); // Delegate + final response
    });

    it('should emit completion event when specialist finishes', async () => {
      const hierarchy = new AgentHierarchy({
        supervisor: new SupervisorAgent({
          id: 'supervisor',
          llm: new MockLLMProvider({
            defaultResponse: MockLLMProvider.simpleResponse(JSON.stringify({ action: 'delegate', target: 'worker', task: 'Do it' })),
          }),
          eventBus,
        }),
        specialists: [
          new SpecialistAgent({ id: 'worker', llm: new MockLLMProvider(), capabilities: ['general'], eventBus }),
        ],
        transport,
        eventBus,
      });

      await hierarchy.execute('Task');
      expect(eventBus.emitted('specialist:complete')).toBe(true);
    });
  });

  describe('capability matching', () => {
    it('should match task to specialist based on capabilities', async () => {
      const hierarchy = new AgentHierarchy({
        supervisor: new SupervisorAgent({
          id: 'supervisor',
          llm: new MockLLMProvider(),
          eventBus,
          autoRoute: true, // Let hierarchy auto-match capabilities
        }),
        specialists: [
          new SpecialistAgent({ id: 'coder', llm: new MockLLMProvider(), capabilities: ['coding', 'debugging', 'typescript'], eventBus }),
          new SpecialistAgent({ id: 'designer', llm: new MockLLMProvider(), capabilities: ['ui', 'css', 'figma'], eventBus }),
          new SpecialistAgent({ id: 'devops', llm: new MockLLMProvider(), capabilities: ['docker', 'k8s', 'ci-cd'], eventBus }),
        ],
        transport,
        eventBus,
      });

      const match = hierarchy.findBestSpecialist('Fix the Dockerfile');
      expect(match.id).toBe('devops');
    });

    it('should return null when no specialist matches capabilities', async () => {
      const hierarchy = new AgentHierarchy({
        supervisor: new SupervisorAgent({ id: 'supervisor', llm: new MockLLMProvider(), eventBus }),
        specialists: [
          new SpecialistAgent({ id: 'coder', llm: new MockLLMProvider(), capabilities: ['coding'], eventBus }),
        ],
        transport,
        eventBus,
      });

      const match = hierarchy.findBestSpecialist('Create a marketing campaign');
      expect(match).toBeNull();
    });

    it('should rank specialists by capability relevance', async () => {
      const hierarchy = new AgentHierarchy({
        supervisor: new SupervisorAgent({ id: 'supervisor', llm: new MockLLMProvider(), eventBus }),
        specialists: [
          new SpecialistAgent({ id: 'general-coder', llm: new MockLLMProvider(), capabilities: ['coding'], eventBus }),
          new SpecialistAgent({ id: 'ts-expert', llm: new MockLLMProvider(), capabilities: ['coding', 'typescript', 'type-systems'], eventBus }),
        ],
        transport,
        eventBus,
      });

      const ranked = hierarchy.rankSpecialists('Fix TypeScript type error');
      expect(ranked[0].id).toBe('ts-expert'); // More relevant
      expect(ranked[1].id).toBe('general-coder');
    });
  });

  describe('handoff protocol', () => {
    it('should transfer context cleanly during handoff', async () => {
      const protocol = new HandoffProtocol({ eventBus });

      const handoff = await protocol.initiate({
        from: 'supervisor',
        to: 'coder',
        task: 'Implement feature X',
        context: {
          requirements: ['Must be async', 'Must handle errors'],
          codebase: 'TypeScript',
        },
      });

      expect(handoff.status).toBe('accepted');
      expect(handoff.contextTransferred).toBe(true);
      expect(handoff.receivedBy).toBe('coder');
    });

    it('should include conversation history in handoff', async () => {
      const protocol = new HandoffProtocol({ eventBus });

      const history = [
        { role: 'user' as const, content: 'Build a REST API' },
        { role: 'assistant' as const, content: 'I will delegate this to the coder' },
      ];

      const handoff = await protocol.initiate({
        from: 'supervisor',
        to: 'coder',
        task: 'Build REST API',
        conversationHistory: history,
      });

      expect(handoff.conversationHistory).toHaveLength(2);
    });
  });

  describe('return handoff (specialist back to supervisor)', () => {
    it('should return control from specialist to supervisor with results', async () => {
      const protocol = new HandoffProtocol({ eventBus });

      const returnHandoff = await protocol.returnToSupervisor({
        from: 'coder',
        to: 'supervisor',
        result: 'Feature implemented successfully',
        artifacts: ['src/feature.ts', 'src/feature.test.ts'],
      });

      expect(returnHandoff.status).toBe('returned');
      expect(returnHandoff.result).toContain('implemented');
      expect(returnHandoff.artifacts).toHaveLength(2);
    });

    it('should support escalation (specialist cannot complete)', async () => {
      const protocol = new HandoffProtocol({ eventBus });

      const escalation = await protocol.escalate({
        from: 'coder',
        to: 'supervisor',
        reason: 'Task requires database knowledge I do not have',
        partialResult: 'Completed the API layer but need DB schema',
      });

      expect(escalation.status).toBe('escalated');
      expect(escalation.reason).toContain('database');
    });
  });

  describe('multiple specialists active simultaneously', () => {
    it('should run multiple specialists in parallel on independent subtasks', async () => {
      const coderLLM = new MockLLMProvider({ defaultResponse: MockLLMProvider.simpleResponse('Code done') });
      const designerLLM = new MockLLMProvider({ defaultResponse: MockLLMProvider.simpleResponse('Design done') });
      const writerLLM = new MockLLMProvider({ defaultResponse: MockLLMProvider.simpleResponse('Docs done') });

      const hierarchy = new AgentHierarchy({
        supervisor: new SupervisorAgent({
          id: 'supervisor',
          llm: new MockLLMProvider({
            defaultResponse: MockLLMProvider.simpleResponse(JSON.stringify({
              action: 'delegate-parallel',
              tasks: [
                { target: 'coder', task: 'Implement feature' },
                { target: 'designer', task: 'Design UI' },
                { target: 'writer', task: 'Write documentation' },
              ],
            })),
          }),
          eventBus,
        }),
        specialists: [
          new SpecialistAgent({ id: 'coder', llm: coderLLM, capabilities: ['coding'], eventBus }),
          new SpecialistAgent({ id: 'designer', llm: designerLLM, capabilities: ['design'], eventBus }),
          new SpecialistAgent({ id: 'writer', llm: writerLLM, capabilities: ['writing'], eventBus }),
        ],
        transport,
        eventBus,
      });

      const result = await hierarchy.execute('Build complete feature with UI and docs');
      expect(result.parallelResults).toHaveLength(3);
      expect(coderLLM.callCount).toBe(1);
      expect(designerLLM.callCount).toBe(1);
      expect(writerLLM.callCount).toBe(1);
    });

    it('should aggregate results from parallel specialists', async () => {
      const hierarchy = new AgentHierarchy({
        supervisor: new SupervisorAgent({
          id: 'supervisor',
          llm: MockLLMProvider.sequencedResponses(
            MockLLMProvider.simpleResponse(JSON.stringify({
              action: 'delegate-parallel',
              tasks: [
                { target: 'analyst-a', task: 'Analyze segment A' },
                { target: 'analyst-b', task: 'Analyze segment B' },
              ],
            })),
            MockLLMProvider.simpleResponse('Combined analysis: both segments show growth'),
          ),
          eventBus,
        }),
        specialists: [
          new SpecialistAgent({
            id: 'analyst-a',
            llm: new MockLLMProvider({ defaultResponse: MockLLMProvider.simpleResponse('Segment A: +15% growth') }),
            capabilities: ['analysis'],
            eventBus,
          }),
          new SpecialistAgent({
            id: 'analyst-b',
            llm: new MockLLMProvider({ defaultResponse: MockLLMProvider.simpleResponse('Segment B: +22% growth') }),
            capabilities: ['analysis'],
            eventBus,
          }),
        ],
        transport,
        eventBus,
      });

      const result = await hierarchy.execute('Analyze all market segments');
      expect(result.output).toContain('both segments show growth');
    });
  });
});
