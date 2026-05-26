import { injectable, inject } from 'inversify';
import { IStep, StepContext } from '../../interfaces/IStep.js';
import { IMessageManager } from '../../interfaces/IMessageManager.js';
import { TOKENS } from '../../types/Tokens.js';

/** Adds tool execution results to message history so the LLM can see them on next call. */
@injectable()
export class AddToolResultsStep implements IStep {
  readonly name = 'add-tool-results';
  readonly description = 'Add tool execution results to message history';
  readonly priority = 400;

  constructor(
    @inject(TOKENS.IMessageManager) private messageManager: IMessageManager
  ) {}

  /** Only execute this step when tool results are present in the context. */
  shouldExecute(context: StepContext): boolean {
    return !!(context.toolResults && context.toolResults.length > 0);
  }

  /** Add the assistant message (with tool calls) and each tool result message to conversation history. */
  async execute(context: StepContext): Promise<StepContext> {
    const toolCalls = context.llmResponse.tool_calls!;

    this.messageManager.addMessage({
      role: 'assistant',
      content: context.llmResponse.content || '',
      tool_calls: toolCalls,
      reasoning: context.llmResponse.reasoning,
    });

    for (let i = 0; i < context.toolResults!.length; i++) {
      const result = context.toolResults![i];
      const callId = toolCalls[i]?.id;
      const content = result.success
        ? JSON.stringify(result.data ?? '')
        : JSON.stringify({ error: result.error?.message ?? 'Unknown error' });
      this.messageManager.addMessage({
        role: 'tool',
        content,
        tool_call_id: callId,
      });
    }

    context.messages = this.messageManager.getMessages();
    context.shouldContinue = true;

    return context;
  }
}
