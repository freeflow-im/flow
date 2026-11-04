import { describe, expect, it } from 'vitest';
import { inertHtml, isSvg, MAX_PREVIEW_BYTES, previewLimit, typeLabel, viewerFor } from './preview';

const v = (filename: string, mimeType = 'application/octet-stream') => viewerFor({ filename, mimeType });

describe('the viewer for an attachment', () => {
  it('goes by the name’s extension first, as mail often says application/octet-stream', () => {
    expect(['a.png', 'a.JPG', 'a.jpeg', 'a.gif', 'a.webp', 'logo.svg'].map((n) => v(n))).toEqual(Array(6).fill('image'));
    expect(['clip.mp4', 'clip.mov', 'clip.webm'].map((n) => v(n))).toEqual(['video', 'video', 'video']);
    expect(['memo.mp3', 'memo.m4a', 'memo.wav'].map((n) => v(n))).toEqual(['audio', 'audio', 'audio']);
    expect(['r.pdf', 'r.docx', 'r.xlsx', 'r.xls', 'r.pptx', 'r.csv', 'README.md'].map((n) => v(n))).toEqual(Array(7).fill('docs'));
    expect(['notes.txt', 'data.json', 'server.log', 'msg.eml', 'main.py', 'conf.yaml'].map((n) => v(n))).toEqual(Array(6).fill('text'));
    expect(v('page.html', 'text/html')).toBe('html');
    expect(v('page.htm')).toBe('html');
    expect(['setup.exe', 'archive.zip', 'old.doc', 'x.key'].map((n) => v(n))).toEqual(Array(4).fill('none'));
  });

  it('uses the MIME type when the name says nothing', () => {
    expect(v('attachment', 'image/png')).toBe('image');
    expect(v('attachment', 'image/svg+xml')).toBe('image');
    expect(v('attachment', 'image/tiff')).toBe('none');
    expect(v('attachment', 'video/quicktime')).toBe('video');
    expect(v('attachment', 'audio/mpeg')).toBe('audio');
    expect(v('attachment', 'application/pdf')).toBe('docs');
    expect(v('attachment', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('docs');
    expect(v('attachment', 'text/csv; charset=utf-8')).toBe('docs');
    expect(v('attachment', 'text/html')).toBe('html');
    expect(v('attachment', 'text/plain')).toBe('text');
    expect(v('attachment', 'application/ld+json')).toBe('text');
    expect(v('attachment', 'message/rfc822')).toBe('text');
    expect(v('attachment', 'application/octet-stream')).toBe('none');
  });

  it('knows an SVG, by name or type', () => {
    expect(isSvg({ filename: 'logo.svg', mimeType: 'application/octet-stream' })).toBe(true);
    expect(isSvg({ filename: 'logo', mimeType: 'image/svg+xml' })).toBe(true);
    expect(isSvg({ filename: 'logo.png', mimeType: 'image/png' })).toBe(false);
  });

  it('refuses text over 2 MB and Docs previews over 25 MB', () => {
    expect(previewLimit('text', 2 * 1024 * 1024)).toBeNull();
    expect(previewLimit('text', 2 * 1024 * 1024 + 1)).toMatch(/too large/);
    expect(previewLimit('html', 3 * 1024 * 1024)).toMatch(/too large/);
    expect(previewLimit('docs', MAX_PREVIEW_BYTES)).toBeNull();
    expect(previewLimit('docs', MAX_PREVIEW_BYTES + 1)).toMatch(/25 MB/);
    expect(previewLimit('image', 100 * 1024 * 1024)).toBeNull();
  });

  it('names the type for the top bar', () => {
    expect(typeLabel({ filename: 'a.docx', mimeType: '' })).toBe('Word document');
    expect(typeLabel({ filename: 'a.pdf', mimeType: '' })).toBe('PDF');
    expect(typeLabel({ filename: 'a.png', mimeType: 'image/png' })).toBe('PNG');
    expect(typeLabel({ filename: 'attachment', mimeType: 'application/zip' })).toBe('application/zip');
  });

  it('puts a policy that loads nothing ahead of an HTML attachment', () => {
    const doc = inertHtml('<html><head><script>alert(1)</script></head><body><img src="https://tracker.example/p.gif"></body></html>');
    expect(doc.indexOf("default-src 'none'")).toBeLessThan(doc.indexOf('<html>'));
    expect(doc).toContain('img-src data:');
  });
});
