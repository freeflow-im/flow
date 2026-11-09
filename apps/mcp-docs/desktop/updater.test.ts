import { describe, expect, it } from 'vitest';
import { isNewer, latestFor } from './updater.js';

const asset = (name: string) => ({ name, browser_download_url: `https://github.com/x/${name}`, size: 100 });
const releases = [
  { draft: true, html_url: 'd', assets: [asset('MCP-Docs-0.3.0-mac-arm64.zip')] },
  { prerelease: true, html_url: 'p', assets: [asset('MCP-Docs-0.2.28-mac-arm64.zip')] },
  { html_url: 'r27', assets: [asset('MCP-Docs-0.2.27-mac-arm64.zip')] },
  { html_url: 'r26', assets: [asset('MCP-Docs-0.2.26-mac-arm64.zip'), asset('MCP-Docs-0.2.26-win-x64-setup.exe')] },
];

describe('isNewer', () => {
  it('compares the parts as numbers', () => {
    expect(isNewer('0.2.10', '0.2.9')).toBe(true);
    expect(isNewer('1.0.0', '0.9.99')).toBe(true);
    expect(isNewer('0.2.26', '0.2.26')).toBe(false);
    expect(isNewer('0.2.25', '0.2.26')).toBe(false);
  });
});

describe('latestFor', () => {
  it('takes the newest published release with a file for the platform', () => {
    expect(latestFor(releases, 'darwin')).toEqual({ version: '0.2.27', url: 'https://github.com/x/MCP-Docs-0.2.27-mac-arm64.zip', name: 'MCP-Docs-0.2.27-mac-arm64.zip', size: 100, page: 'r27' });
    expect(latestFor(releases, 'win32')?.version).toBe('0.2.26');
    expect(latestFor([], 'win32')).toBeNull();
  });
});
