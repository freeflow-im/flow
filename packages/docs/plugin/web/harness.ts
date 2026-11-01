// A stand-in for ChatGPT's host, for developing the app without a tunnel: connects to the plugin server as an
// MCP client, loads the app resource into a sandboxed iframe and bridges it (tool calls, model context,
// messages) the way the MCP Apps host does.
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const logEl = $('log');
const log = (...parts: unknown[]) => {
  logEl.textContent += parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ') + '\n';
  logEl.scrollTop = logEl.scrollHeight;
};

let updates = 0;

async function connect(): Promise<void> {
  const url = $<HTMLInputElement>('url').value;
  const client = new Client({ name: 'docs-harness', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const tools = await client.listTools();
  log('tools:', tools.tools.map((t) => t.name).join(', '));
  const entry = tools.tools.find((t) => (t._meta as { 'openai/ui'?: { entrypoints?: { type: string }[] } } | undefined)?.['openai/ui']?.entrypoints?.some((e) => e.type === 'global'));
  if (!entry) throw new Error('No sidebar (global) entrypoint tool');
  const uri = (entry._meta as { ui: { resourceUri: string } }).ui.resourceUri;
  const resource = await client.readResource({ uri });
  const html = (resource.contents[0] as { text: string }).text;
  log('resource:', uri, `${html.length} chars`);
  const result = await client.callTool({ name: entry.name, arguments: {} });
  log('entry tool result:', result.structuredContent);

  const iframe = $<HTMLIFrameElement>('app');
  // ?nosandbox lets browser automation (which cannot reach into an opaque-origin frame) drive the app.
  if (new URLSearchParams(location.search).has('nosandbox')) iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals');
  const bridge = new AppBridge(
    client,
    { name: 'docs-harness', version: '0.1.0' },
    {
      serverTools: {},
      openLinks: {},
      updateModelContext: { text: {}, structuredContent: {} },
      message: { text: {} },
      experimental: { 'openai/modelContext': {}, 'openai/message': {} },
    },
    { hostContext: { theme: 'light', displayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'], locale: navigator.language } },
  );
  bridge.onmessage = async (p) => {
    const text = p.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    $<HTMLInputElement>('prompt').value = text;
    log('ui/message:', text);
    return {};
  };
  bridge.onupdatemodelcontext = async (p) => {
    const text = p.content?.map((c) => (c.type === 'text' ? c.text : '')).join('') ?? '';
    $('ctx').textContent = `context: ${text.slice(0, 80)}`;
    log('model context:', p.structuredContent);
    return { _meta: { 'openai/modelContext': { updateId: String(++updates) } } } as unknown as Record<string, never>;
  };
  bridge.onopenlink = async ({ url: href }) => {
    window.open(href, '_blank');
    return {};
  };
  bridge.onrequestdisplaymode = async ({ mode }) => {
    log('display mode:', mode);
    return { mode };
  };
  bridge.oninitialized = () => {
    log('app initialized');
    void bridge.sendToolResult({ content: result.content as never, structuredContent: result.structuredContent as Record<string, unknown> });
  };
  await bridge.connect(new PostMessageTransport(iframe.contentWindow ?? undefined, iframe.contentWindow as MessageEventSource));
  iframe.srcdoc = html;
}

$('connect').addEventListener('click', () => {
  logEl.textContent = '';
  connect().catch((e: Error) => log('error:', e.message));
});
