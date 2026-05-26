/**
 * Example: Custom LLM Provider
 *
 * Shows how to implement your own ILLMProvider
 * for any LLM SDK (Anthropic, OpenAI, LangChain, etc.)
 */

import { ILLMProvider, Message, LLMResponse, LLMOptions } from '../src/interfaces/ILLMProvider';
import { AgentLoop } from '../src';

/**
 * Example: Direct Anthropic SDK adapter
 */
class AnthropicDirectProvider implements ILLMProvider {
  constructor(
    private apiKey: string,
    private model: string = 'claude-3-5-sonnet-20241022'
  ) {}

  async invoke(messages: Message[], options?: LLMOptions): Promise<LLMResponse> {
    // This is a mock - in real implementation:
    // import Anthropic from '@anthropic-ai/sdk';
    // const anthropic = new Anthropic({ apiKey: this.apiKey });

    /*
    const response = await anthropic.messages.create({
      model: this.model,
      max_tokens: options?.max_tokens || 4096,
      temperature: options?.temperature || 1.0,
      messages: messages.map(m => ({
        role: m.role === 'system' ? 'user' : m.role,
        content: m.content
      })),
      tools: options?.tools
    });

    return {
      content: response.content[0].type === 'text'
        ? response.content[0].text
        : '',
      tool_calls: response.content
        .filter(c => c.type === 'tool_use')
        .map(c => ({
          id: c.id,
          name: c.name,
          arguments: JSON.stringify(c.input)
        })),
      finish_reason: response.stop_reason === 'end_turn' ? 'stop' : 'tool_calls',
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens
      },
      model: this.model
    };
    */

    // Mock response
    return {
      content: 'This is a mock response',
      finish_reason: 'stop',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15
      }
    };
  }

  getInfo() {
    return {
      provider: 'anthropic',
      model: this.model,
      capabilities: ['tool_calling', 'streaming']
    };
  }
}

/**
 * Example: OpenAI SDK adapter
 */
class OpenAIDirectProvider implements ILLMProvider {
  constructor(
    private apiKey: string,
    private model: string = 'gpt-4-turbo-preview'
  ) {}

  async invoke(messages: Message[], options?: LLMOptions): Promise<LLMResponse> {
    // Mock - in real implementation:
    // import OpenAI from 'openai';
    // const openai = new OpenAI({ apiKey: this.apiKey });

    /*
    const response = await openai.chat.completions.create({
      model: this.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content
      })),
      temperature: options?.temperature,
      max_tokens: options?.max_tokens,
      tools: options?.tools?.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema
        }
      }))
    });

    const choice = response.choices[0];

    return {
      content: choice.message.content || '',
      tool_calls: choice.message.tool_calls?.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments
      })),
      finish_reason: choice.finish_reason === 'stop' ? 'stop' : 'tool_calls',
      usage: {
        input_tokens: response.usage?.prompt_tokens || 0,
        output_tokens: response.usage?.completion_tokens || 0,
        total_tokens: response.usage?.total_tokens || 0
      },
      model: this.model
    };
    */

    // Mock response
    return {
      content: 'This is a mock response',
      finish_reason: 'stop',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15
      }
    };
  }

  getInfo() {
    return {
      provider: 'openai',
      model: this.model,
      capabilities: ['tool_calling', 'streaming']
    };
  }
}

/**
 * Example usage
 */
async function main() {
  // Use custom Anthropic provider
  const anthropicProvider = new AnthropicDirectProvider(
    process.env.ANTHROPIC_API_KEY || 'mock-key'
  );

  const loop1 = AgentLoop.builder()
    .withLLM(anthropicProvider)
    .build();

  // Use custom OpenAI provider
  const openaiProvider = new OpenAIDirectProvider(
    process.env.OPENAI_API_KEY || 'mock-key'
  );

  const loop2 = AgentLoop.builder()
    .withLLM(openaiProvider)
    .build();

  console.log('Custom LLM providers configured successfully');
  console.log('Loop 1 provider:', anthropicProvider.getInfo());
  console.log('Loop 2 provider:', openaiProvider.getInfo());
}

main().catch(console.error);
