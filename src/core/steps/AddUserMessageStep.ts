import { injectable, inject } from 'inversify';
import { IStep, StepContext } from '../../interfaces/IStep.js';
import { IMessageManager } from '../../interfaces/IMessageManager.js';
import { TOKENS } from '../../types/Tokens.js';

/** Adds the user's input message to conversation history. */
@injectable()
export class AddUserMessageStep implements IStep {
  readonly name = 'add-user-message';
  readonly description = 'Add user message to conversation history';
  readonly priority = 100;

  constructor(
    @inject(TOKENS.IMessageManager) private messageManager: IMessageManager
  ) {}

  /** Add the user input from context data to conversation history if present. */
  async execute(context: StepContext): Promise<StepContext> {
    const userInput = context.data.userInput as string;

    if (!userInput) {
      return context;
    }

    const userMessage = {
      role: 'user' as const,
      content: userInput
    };

    this.messageManager.addMessage(userMessage);
    context.messages = this.messageManager.getMessages();

    return context;
  }
}
