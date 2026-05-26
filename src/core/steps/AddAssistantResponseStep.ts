import { injectable, inject } from 'inversify';
import { IStep, StepContext } from '../../interfaces/IStep.js';
import { IMessageManager } from '../../interfaces/IMessageManager.js';
import { TOKENS } from '../../types/Tokens.js';

/** Adds the final assistant response to message history and signals pipeline completion. */
@injectable()
export class AddAssistantResponseStep implements IStep {
  readonly name = 'add-assistant-response';
  readonly description = 'Add assistant response to message history';
  readonly priority = 500;

  constructor(
    @inject(TOKENS.IMessageManager) private messageManager: IMessageManager
  ) {}

  /** Only execute when the LLM response has no tool calls (i.e., final response). */
  shouldExecute(context: StepContext): boolean {
    return !context.llmResponse?.tool_calls || context.llmResponse.tool_calls.length === 0;
  }

  /** Add the final assistant response to message history and signal pipeline completion. */
  async execute(context: StepContext): Promise<StepContext> {
    this.messageManager.addMessage({
      role: 'assistant',
      content: context.llmResponse.content,
      tool_calls: context.llmResponse.tool_calls,
      reasoning: context.llmResponse.reasoning,
    });

    context.messages = this.messageManager.getMessages();
    context.shouldContinue = false;

    return context;
  }
}
