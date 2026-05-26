import { injectable, inject } from 'inversify';
import { ITurnExecutor, TurnContext, TurnResult, ToolExecutionResult } from '../interfaces/ITurnExecutor.js';
import { ILLMProvider } from '../interfaces/ILLMProvider.js';
import { IToolExecutor } from '../interfaces/IToolExecutor.js';
import { ILogger } from '../interfaces/ILogger.js';
import { TOKENS } from '../types/Tokens.js';

/** DI-injectable turn executor that calls the LLM and handles tool execution. */
@injectable()
export class TurnExecutor implements ITurnExecutor {
  constructor(
    @inject(TOKENS.ILLMProvider) private llmProvider: ILLMProvider,
    @inject(TOKENS.IToolExecutor) private toolExecutor: IToolExecutor,
    @inject(TOKENS.ILogger) private logger: ILogger
  ) {}

  /**
   * Execute a single turn: invoke the LLM with current messages, execute any tool calls,
   * and return the updated context with results.
   *
   * @param context - The turn context containing messages, state, and metadata.
   * @returns A TurnResult with the LLM response, tool results, and updated messages.
   */
  async executeTurn(context: TurnContext): Promise<TurnResult> {
    this.logger.debug('Executing turn', { turnNumber: context.turnNumber });

    const tools = this.toolExecutor.getToolDefinitions();
    const response = await this.llmProvider.invoke(context.messages, { tools });

    const toolResults: ToolExecutionResult[] = [];

    if (response.tool_calls && response.tool_calls.length > 0) {
      for (const toolCall of response.tool_calls) {
        const toolContext = {
          turnNumber: context.turnNumber,
          state: context.state,
          metadata: context.metadata
        };
        const result = await this.toolExecutor.executeTool(toolCall, toolContext);
        toolResults.push({
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          result: result.data,
          error: result.error?.message
        });
      }
    }

    const updatedMessages = [...context.messages, { role: 'assistant' as const, content: response.content }];
    for (const tr of toolResults) {
      updatedMessages.push({
        role: 'tool' as const,
        content: JSON.stringify(tr.result),
        tool_call_id: tr.toolCallId
      });
    }

    const shouldContinue = response.finish_reason === 'tool_calls';

    return {
      response,
      toolResults: toolResults.length > 0 ? toolResults : undefined,
      updatedMessages,
      shouldContinue
    };
  }

  /** Determine whether the loop should continue based on whether the LLM requested tool calls. */
  shouldContinue(result: TurnResult): boolean {
    return result.response.finish_reason === 'tool_calls';
  }
}
