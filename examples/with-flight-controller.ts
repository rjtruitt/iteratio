/**
 * Example: Using iteratio with flight-controller
 *
 * This is the recommended setup for most users.
 */

import { AgentLoop } from '../src';
import { FlightControllerAdapter } from '../src/adapters/FlightControllerAdapter';

// Uncomment when flight-controller is installed:
// import { FlightController } from 'flight-controller';

async function main() {
  // Option 1: Direct usage (if flight-controller implements ILLMProvider)
  /*
  const fc = new FlightController({
    providers: [
      {
        type: 'bedrock',
        modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        region: 'us-east-1'
      }
    ],
    routing: {
      strategy: 'fallback'
    }
  });

  const loop = AgentLoop.builder()
    .withLLM(fc)
    .build();
  */

  // Option 2: Using adapter (if interfaces differ slightly)
  /*
  const fc = new FlightController({
    providers: [
      {
        type: 'bedrock',
        modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        region: 'us-east-1'
      }
    ]
  });

  const adapter = new FlightControllerAdapter(fc);

  const loop = AgentLoop.builder()
    .withLLM(adapter)
    .build();

  const response = await loop.runTurn('Hello, what can you do?');
  console.log(response);
  */

  console.log('Example requires flight-controller to be installed:');
  console.log('npm install flight-controller');
}

main().catch(console.error);
