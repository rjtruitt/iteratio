import { injectable, inject } from 'inversify';
import { IStep, StepContext } from '../../interfaces/IStep.js';
import { ILLMProvider } from '../../interfaces/ILLMProvider.js';
import { IToolExecutor } from '../../interfaces/IToolExecutor.js';
import { TOKENS } from '../../types/Tokens.js';

/** Invokes the LLM with current conversation history and available tool definitions. */
@injectable()
export class CallLLMStep implements IStep {
  readonly name = 'call-llm';
  readonly description = 'Invoke LLM with conversation history';
  readonly priority = 200;

  constructor(
    @inject(TOKENS.ILLMProvider) private llmProvider: ILLMProvider,
    @inject(TOKENS.IToolExecutor) private toolExecutor: IToolExecutor
  ) {}

  /** Invoke the LLM with current messages and register response + usage metadata on the context. */
  async execute(context: StepContext): Promise<StepContext> {
    const tools = this.toolExecutor.getToolDefinitions();

    const response = await this.llmProvider.invoke(context.messages, {
      tools: tools.length > 0 ? tools : undefined
    });

    context.llmResponse = response;
    context.metadata.llmModel = response.model;
    context.metadata.llmUsage = response.usage;

    return context;
  }
}
