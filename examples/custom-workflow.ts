/**
 * Example: Custom Workflow with Total Control
 *
 * Shows how to:
 * - Define custom workflow steps
 * - Reorder steps dynamically
 * - Add loops (check todo 5 times, 200 times, whatever you want)
 * - Reconfigure workflow at runtime
 * - Create conditional flows
 */

import { AgentLoop } from '../src';
import { IStep, StepContext, StepRegistration } from '../src/interfaces/IStep';

// ============================================
// Custom Step: Check TODO Tool
// ============================================
class CheckTodoStep implements IStep {
  name = 'check-todo';
  description = 'Check todo tool';
  priority = 250;

  constructor(private checkCount: number = 1) {}

  async execute(context: StepContext): Promise<StepContext> {
    console.log(`Checking todo tool (${this.checkCount} times)`);

    // Check todo tool multiple times
    for (let i = 0; i < this.checkCount; i++) {
      console.log(`  Check ${i + 1}/${this.checkCount}`);
      // TODO: Actually call todo tool
    }

    return context;
  }
}

// ============================================
// Custom Step: Validation Loop
// ============================================
class ValidationLoopStep implements IStep {
  name = 'validation-loop';
  description = 'Loop until validation passes';
  priority = 350;

  async execute(context: StepContext): Promise<StepContext> {
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      attempts++;
      console.log(`Validation attempt ${attempts}`);

      // Check if valid
      const isValid = this.validate(context);
      if (isValid) {
        console.log('Validation passed!');
        break;
      }

      console.log('Validation failed, retrying...');
      // TODO: Modify context to trigger re-execution
    }

    context.metadata.validationAttempts = attempts;
    return context;
  }

  private validate(context: StepContext): boolean {
    // TODO: Actual validation logic
    return Math.random() > 0.5; // 50% chance for demo
  }
}

// ============================================
// Custom Step: Conditional Branch
// ============================================
class ConditionalBranchStep implements IStep {
  name = 'conditional-branch';
  description = 'Branch based on condition';
  priority = 150;

  async execute(context: StepContext): Promise<StepContext> {
    // Check condition
    const shouldBranch = context.metadata.branchEnabled === true;

    if (shouldBranch) {
      console.log('Taking branch A');
      context.data.branch = 'A';
    } else {
      console.log('Taking branch B');
      context.data.branch = 'B';
    }

    return context;
  }
}

// ============================================
// Example 1: Basic Workflow with Custom Steps
// ============================================
async function example1_basicCustomWorkflow() {
  console.log('\n=== Example 1: Basic Custom Workflow ===\n');

  const loop = AgentLoop.builder()
    .withLLM(mockLLM)
    .build();

  // Register custom steps
  loop.registerStep({
    step: new CheckTodoStep(3), // Check todo 3 times
    position: { after: 'call-llm' }
  });

  loop.registerStep({
    step: new ValidationLoopStep(),
    position: { after: 'execute-tools' }
  });

  // Show workflow order
  console.log('Workflow order:', loop.getWorkflowOrder());

  // Run
  const response = await loop.runTurn('Do something');
  console.log('Response:', response);
}

// ============================================
// Example 2: Dynamic Reconfiguration
// ============================================
async function example2_dynamicReconfiguration() {
  console.log('\n=== Example 2: Dynamic Reconfiguration ===\n');

  const loop = AgentLoop.builder()
    .withLLM(mockLLM)
    .build();

  // Initial workflow
  console.log('Initial workflow:', loop.getWorkflowOrder());

  // Turn 1: Normal workflow
  await loop.runTurn('First turn');

  // Reconfigure: Add todo check (5 times)
  console.log('\n> Adding todo check step (5 times)...');
  loop.registerStep({
    step: new CheckTodoStep(5),
    position: { after: 'call-llm' }
  });

  // Turn 2: With todo check
  await loop.runTurn('Second turn');

  // Reconfigure again: Change to 200 times
  console.log('\n> Changing todo check to 200 times...');
  loop.registerStep({
    step: new CheckTodoStep(200),
    position: { replace: 'check-todo' }
  });

  // Turn 3: With 200 checks
  await loop.runTurn('Third turn');

  console.log('\nFinal workflow:', loop.getWorkflowOrder());
}

// ============================================
// Example 3: Reorder Steps at Runtime
// ============================================
async function example3_reorderSteps() {
  console.log('\n=== Example 3: Reorder Steps at Runtime ===\n');

  const loop = AgentLoop.builder()
    .withLLM(mockLLM)
    .build();

  // Show default order
  console.log('Default order:', loop.getWorkflowOrder());

  // Turn 1: Normal
  await loop.runTurn('Turn 1');

  // Crazy reorder: Read tool response BEFORE sending message
  console.log('\n> Crazy reorder: Tools BEFORE LLM call...');
  loop.reorderSteps([
    'add-user-message',
    'execute-tools',      // Tools BEFORE LLM (nonsensical but possible!)
    'call-llm',
    'add-tool-results',
    'add-assistant-response'
  ]);

  console.log('New order:', loop.getWorkflowOrder());

  // Turn 2: With crazy order
  await loop.runTurn('Turn 2');
}

// ============================================
// Example 4: Conditional Workflow
// ============================================
async function example4_conditionalWorkflow() {
  console.log('\n=== Example 4: Conditional Workflow ===\n');

  const loop = AgentLoop.builder()
    .withLLM(mockLLM)
    .build();

  // Add conditional branch
  loop.registerStep({
    step: new ConditionalBranchStep(),
    position: { before: 'call-llm' }
  });

  // Turn 1: Branch disabled
  console.log('\nTurn 1: Branch disabled');
  await loop.runTurn('Test');

  // Turn 2: Branch enabled
  console.log('\nTurn 2: Branch enabled');
  // TODO: Set metadata to enable branch
  await loop.runTurn('Test');
}

// ============================================
// Example 5: Extreme Loop (200 todo checks)
// ============================================
async function example5_extremeLoop() {
  console.log('\n=== Example 5: Extreme Loop (200 checks) ===\n');

  const loop = AgentLoop.builder()
    .withLLM(mockLLM)
    .build();

  // Add step that checks todo 200 times
  loop.registerStep({
    step: new CheckTodoStep(200),
    position: { after: 'call-llm' }
  });

  console.log('Workflow with 200 checks:', loop.getWorkflowOrder());

  const startTime = Date.now();
  await loop.runTurn('Do it!');
  const duration = Date.now() - startTime;

  console.log(`\nCompleted 200 checks in ${duration}ms`);
}

// ============================================
// Example 6: Multi-Step Loop Pattern
// ============================================
class LoopUntilConditionStep implements IStep {
  name = 'loop-until-condition';
  description = 'Loop through sub-steps until condition met';
  priority = 300;

  constructor(
    private subSteps: IStep[],
    private condition: (context: StepContext) => boolean,
    private maxIterations: number = 10
  ) {}

  async execute(context: StepContext): Promise<StepContext> {
    let iteration = 0;

    while (iteration < this.maxIterations) {
      iteration++;
      console.log(`\n  Loop iteration ${iteration}/${this.maxIterations}`);

      // Execute all sub-steps
      for (const step of this.subSteps) {
        console.log(`    Executing: ${step.name}`);
        context = await step.execute(context);
      }

      // Check condition
      if (this.condition(context)) {
        console.log(`  Condition met after ${iteration} iterations`);
        break;
      }
    }

    context.metadata.loopIterations = iteration;
    return context;
  }
}

async function example6_multiStepLoop() {
  console.log('\n=== Example 6: Multi-Step Loop Pattern ===\n');

  const loop = AgentLoop.builder()
    .withLLM(mockLLM)
    .build();

  // Create a loop that repeats multiple steps
  const loopStep = new LoopUntilConditionStep(
    [
      new CheckTodoStep(1),
      new ValidationLoopStep()
    ],
    (context) => context.metadata.validationAttempts === 1, // Stop when validation passes
    5  // Max 5 iterations
  );

  loop.registerStep({
    step: loopStep,
    position: { after: 'call-llm' }
  });

  await loop.runTurn('Test multi-step loop');
}

// ============================================
// Mock LLM for examples
// ============================================
const mockLLM = {
  async invoke() {
    return {
      content: 'Mock response',
      finish_reason: 'stop' as const,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
    };
  }
};

// ============================================
// Run all examples
// ============================================
async function main() {
  await example1_basicCustomWorkflow();
  await example2_dynamicReconfiguration();
  await example3_reorderSteps();
  await example4_conditionalWorkflow();
  await example5_extremeLoop();
  await example6_multiStepLoop();
}

// Uncomment to run:
// main().catch(console.error);

/**
 * Key Takeaways:
 *
 * 1. **Total Control** - You control the entire workflow
 * 2. **Runtime Reconfiguration** - Change steps between turns
 * 3. **Custom Loops** - Add steps that loop N times
 * 4. **Reordering** - Put steps in any order (even nonsensical ones)
 * 5. **Conditional Flows** - Branch based on conditions
 * 6. **Nested Loops** - Steps that loop over other steps
 *
 * Want to check todo 5 times? Easy:
 *   loop.registerStep({ step: new CheckTodoStep(5) })
 *
 * Want to check it 200 times? Easy:
 *   loop.registerStep({ step: new CheckTodoStep(200) })
 *
 * Want to reorder everything? Easy:
 *   loop.reorderSteps(['step1', 'step3', 'step2'])
 *
 * This is YOUR loop. You control EVERYTHING.
 */
