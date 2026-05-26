import { injectable, inject } from 'inversify';
import { IStep, StepContext } from '../../interfaces/IStep.js';
import { IToolExecutor } from '../../interfaces/IToolExecutor.js';
import { TOKENS } from '../../types/Tokens.js';

/** Executes tool calls from the LLM response in parallel. */
@injectable()
export class ExecuteToolsStep implements IStep {
  readonly name = 'execute-tools';
  readonly description = 'Execute tool calls from LLM';
  readonly priority = 300;

  constructor(
    @inject(TOKENS.IToolExecutor) private toolExecutor: IToolExecutor
  ) {}

  /** Only execute this step when the LLM response contains tool calls. */
  shouldExecute(context: StepContext): boolean {
    const toolCalls = context.llmResponse?.tool_calls;
    return toolCalls && toolCalls.length > 0;
  }

  /** Execute all tool calls from the LLM response in parallel and attach results to context. */
  async execute(context: StepContext): Promise<StepContext> {
    const toolCalls = context.llmResponse.tool_calls;

    const results = await this.toolExecutor.executeTools(
      toolCalls,
      {
        turnNumber: context.turnNumber,
        state: context.state,
        metadata: context.metadata
      },
      'parallel'
    );

    context.toolResults = results;

    return context;
  }
}
