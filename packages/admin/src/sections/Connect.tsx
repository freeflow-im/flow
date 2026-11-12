// Connect an agent (docs/specs/agents.md §1): every member's own section. The suite's MCP address, what to tell an agent
// (Claude Code, Codex, Claude Desktop, ChatGPT, any MCP client) to connect, and the agents connected so far, each with
// Disconnect. Connecting asks, on the consent page, whether the agent acts as you (a personal agent) or joins as a shared
// one; the platform's /v1 routes, so this depends on no app.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { connectionsApi } from '../api';
import { Button, Card, Confirm, ErrorLine } from '../components/ui';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What to paste into an agent so it connects itself (the same steps as /llms.txt). */
export function connectPrompt(url: string): string {
  const origin = new URL(url).origin;
  return [
    `Connect to FreeFlow, where my chat, mail, calendar and documents are, as a remote MCP server (streamable HTTP, with OAuth sign-in): ${url}`,
    '',
    `- Claude Code: claude mcp add --transport http freeflow ${url}`,
    `- Codex: codex mcp add freeflow --url ${url}`,
    `- Claude Desktop or ChatGPT: add a custom connector with this address.`,
    `- Another MCP client: add a remote (HTTP) server at that address. If it only runs stdio servers, or cannot open a browser to sign in, use: npx -y mcp-remote ${url} --device-code — it prints an address and a code; show them to me so I can allow you.`,
    '',
    `Full instructions: ${origin}/llms.txt`,
  ].join('\n');
}

export function Connect() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['agent-connections'], queryFn: connectionsApi.list });
  const url = list.data?.mcpUrl ?? `${window.location.origin}/mcp`;
  const [copied, setCopied] = useState<'url' | 'prompt' | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const disconnect = useMutation({
    mutationFn: (id: string) => connectionsApi.disconnect(id),
    onSuccess: async () => {
      setConfirming(null);
      await qc.invalidateQueries({ queryKey: ['agent-connections'] });
    },
  });
  const copy = async (what: 'url' | 'prompt') => {
    await navigator.clipboard?.writeText(what === 'url' ? url : connectPrompt(url)).catch(() => undefined);
    setCopied(what);
    setTimeout(() => setCopied(null), 1500);
  };
  return (
    <>
      <Card
        title="Connect an agent"
        intro="Claude Code, Codex, Claude Desktop, ChatGPT or any MCP client can work in FreeFlow: your chat, mail, calendar and documents. Give it this address; it signs in through your browser, where you choose whether it acts as you (a personal agent, only you can use it) or joins the organization as a shared agent."
        testid="card-connect"
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded-md border border-hairline bg-panel px-2 py-1 text-sm" data-testid="connect-url">{url}</code>
            <Button onClick={() => void copy('url')} testid="connect-copy-url">{copied === 'url' ? 'Copied' : 'Copy address'}</Button>
          </div>
          <div className="text-sm font-medium">Or paste this into your agent, and it connects itself:</div>
          <pre className="max-h-64 overflow-auto rounded-md border border-hairline bg-panel p-3 text-xs whitespace-pre-wrap" data-testid="connect-prompt">{connectPrompt(url)}</pre>
          <div>
            <Button kind="primary" onClick={() => void copy('prompt')} testid="connect-copy-prompt">{copied === 'prompt' ? 'Copied' : 'Copy instructions'}</Button>
          </div>
        </div>
      </Card>
      <Card title="Your connected agents" intro="Each agent you connected, where it works and when it was last active. Disconnecting ends its access at once; it can connect again." testid="card-connections">
        {list.isError && <ErrorLine error={errorText(list.error)} />}
        {list.isSuccess && list.data.agents.length === 0 && <p className="text-sm text-muted" data-testid="connections-empty">None yet.</p>}
        {list.isSuccess && list.data.agents.length > 0 && (
          <ul className="divide-y divide-hairline rounded-lg border border-hairline">
            {list.data.agents.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm" data-testid={`connection-${a.id}`}>
                <span className="font-medium">{a.name}</span>
                <span className="text-xs text-muted">
                  {a.mode === 'shared' ? `as ${a.agentName ?? 'a shared agent'}` : 'acts as you'}
                  {a.organization ? ` · ${a.organization}` : ''}
                  {a.lastActiveAt ? ` · active ${new Date(a.lastActiveAt).toLocaleString()}` : ` · connected ${new Date(a.connectedAt).toLocaleString()}`}
                </span>
                <span className="flex-1" />
                {confirming === a.id ? (
                  <Confirm question={`Disconnect ${a.name}?`} busy={disconnect.isPending} onYes={() => disconnect.mutate(a.id)} onNo={() => setConfirming(null)} testid={`connection-disconnect-confirm-${a.id}`} />
                ) : (
                  <Button kind="link" onClick={() => setConfirming(a.id)} testid={`connection-disconnect-${a.id}`}>Disconnect</Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <ErrorLine error={disconnect.isError ? errorText(disconnect.error) : null} />
      </Card>
    </>
  );
}
