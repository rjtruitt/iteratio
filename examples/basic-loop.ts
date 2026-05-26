/**
 * Basic agent loop example
 *
 * Demonstrates a simple agent that can execute tools and respond to messages.
 */

import { AgentLoop, type Message, type LLMResponse, type ToolResult } from '../src/index.js';

// Mock LLM that simulates Claude-style responses
async function mockLLM(messages: Message[]): Promise<LLMResponse> {
    const lastMessage = messages[messages.length - 1];

    // Simple pattern matching for demo
    if (lastMessage.role === 'user') {
        const content = typeof lastMessage.content === 'string' ? lastMessage.content : '';

        if (content.toLowerCase().includes('calculate')) {
            // Request calculator tool
            return {
                content: 'I need to use the calculator.',
                toolCalls: [{
                    id: 'call_1',
                    name: 'calculator',
                    arguments: { expression: '2 + 2' }
                }],
                stopReason: 'tool_use',
                usage: {
                    inputTokens: 50,
                    outputTokens: 20,
                    totalTokens: 70
                }
            };
        }
    }

    // Check if last message was a tool result
    const hasToolResult = messages.some(m => m.role === 'tool');
    if (hasToolResult) {
        return {
            content: 'The calculation result is 4. Is there anything else I can help with?',
            stopReason: 'end_turn',
            usage: {
                inputTokens: 60,
                outputTokens: 15,
                totalTokens: 75
            }
        };
    }

    // Default response
    return {
        content: 'Hello! I can help you with calculations. Just ask me to calculate something.',
        stopReason: 'end_turn',
        usage: {
            inputTokens: 40,
            outputTokens: 20,
            totalTokens: 60
        }
    };
}

// Simple calculator tool
async function calculator(args: unknown): Promise<ToolResult> {
    const { expression } = args as { expression: string };

    try {
        // In real implementation, use safe eval or math parser
        const result = eval(expression);
        return {
            success: true,
            data: { result }
        };
    } catch (error) {
        return {
            success: false,
            error: (error as Error).message
        };
    }
}

// Create agent loop
const loop = new AgentLoop({
    async sendRequest(messages) {
        console.log('\n🤖 Sending request to LLM...');
        return mockLLM(messages);
    },

    async executeTool(name, args) {
        console.log(`\n🔧 Executing tool: ${name}`);
        console.log('   Args:', JSON.stringify(args, null, 2));

        if (name === 'calculator') {
            return calculator(args);
        }

        return {
            success: false,
            error: `Unknown tool: ${name}`
        };
    },

    maxTurns: 5,
    maxTokens: 1000,

    // Lifecycle hooks
    async onTurnStart(turn) {
        console.log(`\n📍 Turn ${turn.number} starting...`);
    },

    async onTurnComplete(turn) {
        console.log(`\n✅ Turn ${turn.number} complete`);
        console.log(`   Tokens used: ${turn.tokensUsed}`);
        if (turn.response) {
            console.log(`   Response: ${turn.response.content}`);
        }
    },

    async onToolCall(call) {
        console.log(`\n🛠️  Tool call: ${call.name}`);
    },

    async onToolResult(call, result) {
        console.log(`\n✨ Tool result for ${call.name}:`, result.success ? '✓' : '✗');
        if (result.data) {
            console.log('   Data:', result.data);
        }
    },

    async onError(error, context) {
        console.error(`\n❌ Error in ${context}:`, error.message);
        // Continue on errors
        return true;
    }
});

// Run the agent
async function main() {
    console.log('🚀 Starting agent loop...\n');
    console.log('=' .repeat(60));

    const result = await loop.run({
        messages: [
            {
                role: 'user',
                content: 'Can you calculate 2 + 2 for me?'
            }
        ],
        state: {
            userId: 'demo-user',
            sessionId: 'demo-session'
        }
    });

    console.log('\n' + '='.repeat(60));
    console.log('\n📊 Final Result:');
    console.log(`   Status: ${result.status}`);
    console.log(`   Total turns: ${result.turns.length}`);
    console.log(`   Total tokens: ${result.totalTokens}`);
    console.log(`   Duration: ${result.totalDuration}ms`);
    console.log(`   Final message: ${result.finalMessage}`);
}

main().catch(console.error);
