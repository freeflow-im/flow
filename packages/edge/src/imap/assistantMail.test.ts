// The Docs assistant on the Worker (docs/server/agent, edge copy) has four of the Mail tools: it searches, reads, drafts and
// saves attachments, and never sends. Its tool list is fixed (the prompt stays cacheable); without a Mail object the tools
// say mail is not here.
import { describe, expect, it } from 'vitest';
import { runServerTool, TOOL_DEFS_WITHOUT_JOBS, ToolFailure, validateToolInput } from '../docs/server/agent/tools.ts';
import { PROMPT_WITHOUT_JOBS } from '../docs/server/agent/prompt.ts';
import type { MailToolContext } from './mailTools';

const ACC = '0b6f1c2e-1111-4222-8333-444455556666';

describe('the assistant’s mail tools', () => {
  it('lists search, read, draft and save, never send', () => {
    const names = TOOL_DEFS_WITHOUT_JOBS.map((t) => t.name);
    for (const n of ['search_mail', 'read_mail', 'create_mail_draft', 'save_mail_attachment_to_docs']) expect(names).toContain(n);
    expect(names).not.toContain('send_mail');
    expect(names).not.toContain('trash_mail');
    expect(TOOL_DEFS_WITHOUT_JOBS.find((t) => t.name === 'create_mail_draft')!.description).toMatch(/cannot send/);
    expect(PROMPT_WITHOUT_JOBS).toMatch(/create_mail_draft/);
  });

  it('validates and runs them on the user’s Mail object', async () => {
    expect(validateToolInput('read_mail', { ids: [] }).ok).toBe(false);
    const asked: string[] = [];
    const mail: MailToolContext = {
      origin: 'https://app.test',
      mail: async (path) => {
        asked.push(path);
        if (path === '/v1/mail/accounts') return Response.json({ accounts: [{ id: ACC, email: 'ann@test.local', displayName: 'Ann', status: 'ok', tabs: [] }] });
        return Response.json({ messages: [], next: null });
      },
    };
    const env = { userId: 'u1', sheets: {} as never, context: { page: 'home' } as never, mail };
    const out = JSON.parse(await runServerTool('search_mail', { query: 'invoice' }, env));
    expect(out).toMatchObject({ account: 'ann@test.local', messages: [] });
    expect(asked.at(-1)).toContain('q=invoice');
    await expect(runServerTool('search_mail', {}, { ...env, mail: undefined })).rejects.toThrow(ToolFailure);
    await expect(runServerTool('read_mail', { ids: ['nope'] }, env)).rejects.toThrow(/not a message id/);
  });
});
