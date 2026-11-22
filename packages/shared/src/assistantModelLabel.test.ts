// What an agent runs on, in words: the provider and its model, as the panel's tooltip and Admin's Model card show it.
import { describe, expect, it } from 'vitest';
import { assistantModelLabel } from './assistant';

const base = { anthropicModel: 'claude-sonnet-5-5', openaiModel: 'gpt-6.1-sol', openrouterModel: 'qwen/qwen3.8-max-0902' } as const;

describe('assistantModelLabel', () => {
  it('names the provider and the model from the catalogue', () => {
    expect(assistantModelLabel({ ...base, provider: 'anthropic' })).toBe('Anthropic · Claude Sonnet 5.5');
    expect(assistantModelLabel({ ...base, provider: 'openai' })).toBe('OpenAI · Sol');
    expect(assistantModelLabel({ ...base, provider: 'openrouter' })).toBe('OpenRouter · qwen/qwen3.8-max-0902');
  });
  it('says the built-in model and the local agent in words', () => {
    expect(assistantModelLabel({ ...base, provider: 'default' })).toBe('The built-in model');
    expect(assistantModelLabel({ ...base, provider: 'claude-agent' })).toBe('Claude Code (on this computer)');
    expect(assistantModelLabel({ ...base, provider: 'default', builtIn: false })).toBe('No model chosen yet');
  });
});
