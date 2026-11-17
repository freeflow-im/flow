// Setup's plain parts (docs/specs/onboarding.md): the steps a person sees, the workspace address, the ready-made
// automations and the request a written one becomes.
import { describe, expect, it } from 'vitest';
import { SCHEDULE_EVERY } from '@flow/shared';
import { automationRequest, cleanDomain, nextStep, previousStep, readyMadeBody, readyMadeOf, slugify, stepsFor } from './lib';
import { modelReady } from './api';

describe('setup steps', () => {
  it('gives owners and admins every step, the Domain step only with a domain of their own, and everyone else two', () => {
    expect(stepsFor(null)).toEqual([1, 3, 4, 5, 6]);
    expect(stepsFor('owner', true)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(stepsFor('admin')).toEqual([1, 3, 4, 5, 6]);
    expect(stepsFor('member', true)).toEqual([3, 6]);
  });

  it('moves forward and back, never back to making the workspace', () => {
    expect(nextStep([3, 6], 3)).toBe(6);
    expect(nextStep([3, 6], 6)).toBeNull();
    expect(nextStep([1, 2, 3, 4, 5, 6], 2)).toBe(3);
    expect(previousStep([1, 3, 4, 5, 6], 4)).toBe(3);
    expect(previousStep([1, 2, 3, 4, 5, 6], 3)).toBe(2);
    expect(previousStep([1, 3, 4, 5, 6], 3)).toBeNull();
    expect(previousStep([3, 6], 6)).toBe(3);
  });
});

describe('the workspace address', () => {
  it('makes a slug the server takes', () => {
    expect(slugify('Tidewater')).toBe('tidewater');
    expect(slugify('  Café Crème & Co. ')).toBe('cafe-creme-co');
    expect(slugify('x'.repeat(60))).toHaveLength(40);
  });

  it('reads a typed domain, and refuses what is not one', () => {
    expect(cleanDomain(' https://www.Tidewater.com/about ')).toBe('tidewater.com');
    expect(cleanDomain('mail.tidewater.co.uk')).toBe('mail.tidewater.co.uk');
    expect(cleanDomain('tidewater')).toBeNull();
    expect(cleanDomain('not a domain.com')).toBeNull();
  });
});

describe('the ready-made automations', () => {
  it('wakes the assistant every weekday morning, and on a new calendar event', () => {
    const brief = readyMadeBody('briefing', 'acct-ada', 'America/Los_Angeles');
    expect(brief).toMatchObject({ name: 'Daily Briefing', delivery: 'wake', consumer: 'acct-ada', schedule: { every: 'weekdays@07:30', timezone: 'America/Los_Angeles' } });
    expect(SCHEDULE_EVERY.test(brief.schedule!.every)).toBe(true);
    const prep = readyMadeBody('prep', 'acct-ada', 'UTC');
    expect(prep).toMatchObject({ name: 'Meeting Prep', filter: { types: ['calendar.event.added'] }, consumer: 'acct-ada' });
    expect(prep.action.prompt).toContain('{{data}}');
  });

  it('knows them by name', () => {
    expect(readyMadeOf({ name: 'Daily Briefing' })).toBe('briefing');
    expect(readyMadeOf({ name: 'Meeting Prep' })).toBe('prep');
    expect(readyMadeOf({ name: 'Standup' })).toBeNull();
  });
});

describe('a written automation', () => {
  it('asks the assistant to make it with its tool, naming who it wakes', () => {
    const text = automationRequest({ when: 'It’s Friday at 4 PM', agent: { name: 'Omni', accountId: 'acct-omni' }, then: 'write a recap', timezone: 'Europe/Paris' });
    expect(text).toContain('create_subscription');
    expect(text).toContain('WHEN: It’s Friday at 4 PM');
    expect(text).toContain('acct-omni');
    expect(text).toContain('Europe/Paris');
    expect(automationRequest({ when: 'An email from our accountant', agent: null, then: 'Forward it', timezone: 'UTC' })).toContain('with no agent');
  });
});

describe('the model check', () => {
  it('is ready with the server’s own model or a saved key for the chosen provider', () => {
    const base = { builtIn: false, anthropicKey: null, openaiKey: null, openrouterKey: null };
    expect(modelReady(null)).toBeNull();
    expect(modelReady({ ...base, provider: 'default' })).toBe(false);
    expect(modelReady({ ...base, provider: 'default', builtIn: true })).toBe(true);
    expect(modelReady({ ...base, provider: 'anthropic', anthropicKey: '••••abcd' })).toBe(true);
    expect(modelReady({ ...base, provider: 'openai' })).toBe(false);
  });
});
