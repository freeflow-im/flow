import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MessageDTO } from '@flow/shared';
import { SystemLine } from './SystemLine';

// A share notice's address is a link (platform phase 3.4): same-origin, same tab; any other system line stays plain.
describe('SystemLine', () => {
  const line = (systemKind: MessageDTO['systemKind'], body: string) => renderToStaticMarkup(<SystemLine message={{ id: 'm1', systemKind, body } as MessageDTO} />);

  it('links the address in a file_shared line, and leaves everything else plain', () => {
    const html = line('file_shared', 'Ann shared Q4 plan with you\nhttps://app.example/docs/s/abc?x=1');
    expect(html).toContain('<a href="/docs/s/abc?x=1" class="underline hover:text-ink">https://app.example/docs/s/abc?x=1</a>');
    expect(html).not.toContain('target=');
    expect(html).toContain('Ann shared Q4 plan with you\n');
    expect(line('member_joined', 'Bob joined https://app.example/x')).not.toContain('<a');
  });
});
