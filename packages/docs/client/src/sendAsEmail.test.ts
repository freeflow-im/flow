import { describe, expect, it } from 'vitest';
import { mailDocsFileOf } from './sendAsEmail.ts';

describe('mailDocsFileOf', () => {
  it('names a document by its kind, with a CSV spreadsheet’s format', () => {
    expect(mailDocsFileOf({ id: 's1', title: 'Budget', kind: 'sheet', format: 'csv', folder: 'Q4', shared: true })).toEqual({ kind: 'sheet', id: 's1', name: 'Budget', folder: 'Q4', shared: true, format: 'csv' });
    expect(mailDocsFileOf({ id: 'd1', title: 'Plan', kind: 'doc' })).toEqual({ kind: 'doc', id: 'd1', name: 'Plan', folder: '', shared: false });
  });

  it('names a stored file as one, with its type and size', () => {
    expect(mailDocsFileOf({ id: 'f1', title: 'a.pdf', type: 'application/pdf', size: 42 })).toEqual({ kind: 'file', id: 'f1', name: 'a.pdf', folder: '', shared: false, type: 'application/pdf', size: 42 });
  });
});
