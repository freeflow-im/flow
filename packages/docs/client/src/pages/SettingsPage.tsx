// Settings: what the assistant runs on. The hosted app has a model of its own; a user can instead enter their
// own Anthropic, OpenAI or OpenRouter API key and pick a model, and in the desktop app, which has no model of
// its own, they must. Keys go to the server and are never shown again. The second tab (#agents, where home's
// Connect your agent tile and the desktop app's File › Connect an Agent come) has the MCP address other agents
// connect to and the agents connected, each of which can be disconnected: on the web the hosted address and the
// agents signed in to the account; in the desktop app its own server on this computer and the agents it allowed.
// The desktop app has a third tab (#desktop): whether new files in Downloads, Documents and Desktop open in it, and which kinds.
// A Brave Search API key, optional, is what the assistant's web and image search use; without one they use the
// model provider's own web search.
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ANTHROPIC_MODELS, OPENAI_MODELS, OPENROUTER_MODELS, type AssistantProvider, type AssistantSettings, type AssistantSettingsUpdate, type KeyProvider } from '../../../shared/agent/protocol.ts';
import type { ConnectedAgent, NewFilesSettings, NewFilesUpdate } from '../../../shared/types.ts';
import { AgentButton } from '../agent/AgentPanel.tsx';
import { useAgent } from '../agent/AgentProvider.tsx';
import { api } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { Account } from '../components/Account.tsx';
import { appName } from '../brand.ts';

const PROVIDERS: { id: KeyProvider; name: string; placeholder: string; keysAt: string }[] = [
  { id: 'anthropic', name: 'Anthropic (Claude)', placeholder: 'sk-ant-…', keysAt: 'console.anthropic.com' },
  { id: 'openai', name: 'OpenAI', placeholder: 'sk-…', keysAt: 'platform.openai.com' },
  { id: 'openrouter', name: 'OpenRouter', placeholder: 'sk-or-…', keysAt: 'openrouter.ai/keys' },
];

/** The page's tabs: the assistant's settings first, connecting an agent at #agents, and the desktop app's own at #desktop. */
const TABS = [
  { id: 'assistant', label: 'Assistant', hash: '' },
  { id: 'agents', label: 'Connect your agent', hash: '#agents' },
  { id: 'desktop', label: 'Desktop', hash: '#desktop' },
] as const;

export function SettingsPage() {
  const { hash } = useLocation();
  const navigate = useNavigate();
  const tabs = useAuth().local ? TABS : TABS.filter((t) => t.id !== 'desktop');
  const tab = tabs.find((t) => t.hash === hash) ?? tabs[0];
  const [saved, setSaved] = useState<AssistantSettings | null>(null);
  const [provider, setProvider] = useState<AssistantProvider>('default');
  const [models, setModels] = useState<Record<KeyProvider, string>>({ anthropic: '', openai: '', openrouter: '' });
  const [keys, setKeys] = useState<Record<KeyProvider, string>>({ anthropic: '', openai: '', openrouter: '' });
  const [braveKey, setBraveKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const show = (s: AssistantSettings) => {
    setSaved(s);
    // Without a model of its own and nothing chosen yet, start on the user's own agent, or the first provider, rather than on nothing.
    setProvider(s.provider === 'default' && !s.builtIn ? (s.agents ? 'claude-agent' : 'anthropic') : s.provider);
    setModels({ anthropic: s.anthropicModel, openai: s.openaiModel, openrouter: s.openrouterModel });
    setKeys({ anthropic: '', openai: '', openrouter: '' });
    setBraveKey('');
  };

  useEffect(() => {
    api
      .assistantSettings()
      .then((res) => show(res.settings))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const save = async (body: AssistantSettingsUpdate, done: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      show((await api.saveAssistantSettings(body)).settings);
      setNotice(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const savedKey = (p: KeyProvider) => (saved ? { anthropic: saved.anthropicKey, openai: saved.openaiKey, openrouter: saved.openrouterKey }[p] : null);
  const current = PROVIDERS.find((p) => p.id === provider);
  // Choosing "Use an API key" again goes back to the key provider in use, or the first with a saved key.
  const keyProvider: KeyProvider = (PROVIDERS.find((p) => p.id === saved?.provider) ?? PROVIDERS.find((p) => savedKey(p.id)) ?? PROVIDERS[0]).id;
  const modelHint = provider === 'anthropic' ? ANTHROPIC_MODELS.find((m) => m.id === models.anthropic)?.hint : provider === 'openai' ? OPENAI_MODELS.find((m) => m.id === models.openai)?.hint : undefined;
  const update = (): AssistantSettingsUpdate => ({
    provider,
    anthropicModel: models.anthropic as AssistantSettingsUpdate['anthropicModel'],
    openaiModel: models.openai as AssistantSettingsUpdate['openaiModel'],
    openrouterModel: models.openrouter.trim(),
    ...(current && keys[current.id].trim() ? { [`${current.id}Key`]: keys[current.id].trim() } : {}),
    ...(braveKey.trim() ? { braveKey: braveKey.trim() } : {}),
  });

  return (
    <div className="home">
      <header className="home-header">
        <div className="home-brand">
          <Link to="/" className="home-back">
            ‹ {appName()}
          </Link>
          <span>Settings</span>
        </div>
        <div className="home-user">
          <AgentButton />
          <Account />
        </div>
      </header>

      <div className="home-inner settings-tabs">
        <div className="settings-tab-list" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={t === tab} className={`settings-tab${t === tab ? ' active' : ''}`} onClick={() => navigate({ hash: t.hash }, { replace: true })}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {tab.id === 'agents' ? (
        <ConnectedAgents />
      ) : tab.id === 'desktop' ? (
        <NewFiles />
      ) : (
        <section className="home-inner changes">
          {saved && (
            <p className="changes-intro">
              {saved.agents
                ? 'Choose what powers the assistant: an API key, or a coding agent you already use on this Mac.'
                : saved.builtIn
                  ? 'The assistant runs on the built-in model unless you choose Anthropic, OpenAI or OpenRouter here, billed to your own API key. Keys are stored encrypted and never shown again.'
                  : 'The assistant runs on your own Anthropic, OpenAI or OpenRouter API key, billed to that account. Keys are stored encrypted and never shown again.'}
            </p>
          )}
          {saved && saved.provider === 'default' && !saved.builtIn && (
            <div className="form-error">{saved.agents ? 'Choose what the assistant uses, an API key or a local coding agent, and save.' : 'The assistant needs an API key: choose a provider, enter your key and save.'}</div>
          )}
          {saved === null ? (
            !error && <div className="page-loading">Loading…</div>
          ) : (
            <form
              className="settings-form"
              autoComplete="off"
              onSubmit={(e) => {
                e.preventDefault();
                void save(update(), 'Saved.');
              }}
            >
              {saved.agents ? (
                <>
                  <fieldset className="field run-choice">
                    <legend>The assistant uses</legend>
                    <label className="run-option">
                      <input type="radio" name="runs-on" checked={provider !== 'claude-agent'} onChange={() => setProvider(keyProvider)} />
                      <span>
                        <strong>Use an API key</strong>
                        <span className="field-hint">Anthropic, OpenAI or OpenRouter, with your key, billed for each use to your account there.</span>
                      </span>
                    </label>
                    <label className="run-option">
                      <input type="radio" name="runs-on" checked={provider === 'claude-agent'} onChange={() => setProvider('claude-agent')} />
                      <span>
                        <strong>Use a local coding agent</strong>
                        <span className="field-hint">A coding agent installed and signed in on this Mac, on your own plan with it. No key is needed.</span>
                      </span>
                    </label>
                  </fieldset>
                  {provider === 'claude-agent' ? (
                    <label className="field">
                      <span>Agent</span>
                      <select value="claude-agent" onChange={() => {}}>
                        <option value="claude-agent">Claude Code</option>
                      </select>
                      <span className="field-hint">
                        For each message, {appName()} starts the Claude Code installed on this Mac, signed in as you are there, in the folder open here. It has all of Claude Code’s own tools and settings, and its use counts
                        against your Claude plan. Routine steps go ahead on their own; it asks here only when it is unsure.
                      </span>
                    </label>
                  ) : (
                    <label className="field">
                      <span>API key from</span>
                      <select value={provider} onChange={(e) => setProvider(e.target.value as AssistantProvider)}>
                        {PROVIDERS.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                      <span className="field-hint">
                        A key already set in your environment (ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY) is used the first time the app starts. Keys are stored encrypted and never shown again.
                      </span>
                    </label>
                  )}
                </>
              ) : (
                <label className="field">
                  <span>The assistant runs on</span>
                  <select value={provider} onChange={(e) => setProvider(e.target.value as AssistantProvider)}>
                    {saved.builtIn && <option value="default">Built-in model</option>}
                    {PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}, with my API key
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {current && (
                <>
                  <label className="field">
                    <span>{current.name.replace(/ \(.*\)/, '')} API key</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={keys[current.id]}
                      placeholder={savedKey(current.id) ? `Saved (${savedKey(current.id)}); leave blank to keep` : current.placeholder}
                      onChange={(e) => setKeys({ ...keys, [current.id]: e.target.value })}
                    />
                    {!savedKey(current.id) && <span className="field-hint">Get one at {current.keysAt}.</span>}
                  </label>
                  <label className="field">
                    <span>Model</span>
                    {current.id === 'openrouter' ? (
                      <>
                        <input list="openrouter-models" value={models.openrouter} placeholder="author/model" spellCheck={false} onChange={(e) => setModels({ ...models, openrouter: e.target.value })} />
                        <datalist id="openrouter-models">
                          {OPENROUTER_MODELS.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </datalist>
                        <span className="field-hint">Any OpenRouter model that can call tools; the list has leading ones.</span>
                      </>
                    ) : (
                      <select value={models[current.id]} onChange={(e) => setModels({ ...models, [current.id]: e.target.value })}>
                        {(current.id === 'anthropic' ? ANTHROPIC_MODELS : OPENAI_MODELS).map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    )}
                    {modelHint && <span className="field-hint">{modelHint}</span>}
                  </label>
                </>
              )}
              {provider !== 'claude-agent' && (
                <label className="field">
                  <span>Brave Search API key (optional)</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={braveKey}
                    placeholder={saved.braveKey ? `Saved (${saved.braveKey}); leave blank to keep` : 'BSA…'}
                    onChange={(e) => setBraveKey(e.target.value)}
                  />
                  <span className="field-hint">
                    For the assistant’s web and image search. Without one it searches with {saved.builtIn ? 'this server’s search, or ' : ''}the web search of Anthropic or OpenAI when the assistant runs on them (OpenRouter has
                    none here), which is slower and finds fewer pictures. Get a key at api-dashboard.search.brave.com; image search needs a plan with the Images endpoint.
                  </span>
                </label>
              )}
              {error && <div className="form-error">{error}</div>}
              {notice && <div className="connector-notice">{notice}</div>}
              <div className="settings-actions">
                <button type="submit" className="btn primary" disabled={busy}>
                  {busy ? 'Checking…' : 'Save'}
                </button>
                {current && savedKey(current.id) && (
                  <button
                    type="button"
                    className="btn danger"
                    disabled={busy}
                    onClick={() =>
                      void save(
                        // Removing the key in use leaves the built-in model, or (without one) no model until another key is saved.
                        { ...update(), provider: saved.provider === current.id ? 'default' : saved.provider, [`${current.id}Key`]: null },
                        'The key was removed.',
                      )
                    }
                  >
                    Remove saved key
                  </button>
                )}
                {saved.braveKey && provider !== 'claude-agent' && (
                  <button type="button" className="btn danger" disabled={busy} onClick={() => void save({ ...update(), braveKey: null }, 'The Brave Search key was removed.')}>
                    Remove Brave Search key
                  </button>
                )}
              </div>
            </form>
          )}
          {saved === null && error && <div className="form-error">{error}</div>}
          {saved && <TryIt ready={saved.provider !== 'default' || saved.builtIn} />}
        </section>
      )}
    </div>
  );
}

/** What to paste to an agent so it connects itself to the MCP server at `url`. */
function agentInstruction(url: string): string {
  const origin = new URL(url).origin;
  return [
    `Connect to ${appName()}, where my documents, presentations and spreadsheets are, as a remote MCP server (streamable HTTP, with OAuth sign-in): ${url}`,
    '',
    `- Claude Code: claude mcp add --transport http universal-docs ${url}`,
    `- Codex: codex mcp add universal-docs --url ${url}`,
    `- Another MCP client: add a remote (HTTP) server at that address. If it only runs stdio servers, or cannot open a browser to sign in, use: npx -y mcp-remote ${url} --device-code — it prints an address and a code; show them to me so I can allow you.`,
    '',
    `Full instructions: ${origin}/llms.txt`,
  ].join('\n');
}

const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** A prompt to try the assistant on the saved settings: it goes to the home chat, and the panel opens to show the answer. */
function TryIt({ ready }: { ready: boolean }) {
  const agent = useAgent();
  const [draft, setDraft] = useState('');
  const send = () => {
    const text = draft.trim();
    if (!text || agent.running) return;
    agent.send(text);
    agent.setOpen(true);
    setDraft('');
  };
  return (
    <form
      className="try-it"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <label htmlFor="try-it-prompt">Try it!</label>
      <div className="try-it-row">
        <input id="try-it-prompt" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Which spreadsheets did I edit most recently?" disabled={!ready} autoComplete="off" />
        <button type="submit" className="btn primary" disabled={!ready || !draft.trim() || agent.running}>
          {agent.running ? 'Working…' : 'Send'}
        </button>
      </div>
      <span className="field-hint">{ready ? 'Sends a message to the assistant with the settings saved above; the answer shows in the Assistant panel.' : 'Save a key above first.'}</span>
    </form>
  );
}

/** The command that adds the desktop app's MCP server at `url` to Claude Code. */
const claudeCommand = (url: string) => `claude mcp add --scope user --transport http mcp-docs ${url}`;

/** The desktop app's switch for opening new files that appear in Downloads, Documents and Desktop, and the kinds that open (desktop/newFiles.js). */
function NewFiles() {
  const [settings, setSettings] = useState<NewFilesSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .newFilesSettings()
      .then(setSettings)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const set = async (update: NewFilesUpdate) => {
    setBusy(true);
    setError(null);
    try {
      setSettings(await api.saveNewFilesSettings(update));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="home-inner changes" id="desktop">
      {settings === null ? (
        !error && <div className="page-loading">Loading…</div>
      ) : (
        <>
          <label className="settings-check">
            <input type="checkbox" checked={settings.open} disabled={busy} onChange={(e) => void set({ open: e.target.checked })} /> Open new files in {appName()}
          </label>
          <p className="field-hint">
            A file of the kinds below that appears in one of these folders (a download that finishes, a file saved from another app, a screenshot) opens here, and the app comes to the front. Files in their
            folders and several files at once do not.
          </p>
          <ul className="settings-folders">
            {settings.folders.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <div className="settings-kinds">
            {settings.kinds.map((k) => (
              <label key={k.id} className="settings-check">
                <input
                  type="checkbox"
                  checked={k.on}
                  disabled={busy || !settings.open}
                  onChange={(e) => void set({ kinds: settings.kinds.filter((o) => (o.id === k.id ? e.target.checked : o.on)).map((o) => o.id) })}
                />{' '}
                {k.label}
              </label>
            ))}
          </div>
        </>
      )}
      {error && <div className="form-error">{error}</div>}
    </section>
  );
}

/**
 * Agents signed in with a device code (mcp-remote --device-code, say), or in the desktop app those allowed to use
 * its MCP server. Disconnecting one revokes its tokens at once.
 */
function ConnectedAgents() {
  const [agents, setAgents] = useState<ConnectedAgent[] | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [mcpUrl, setMcpUrl] = useState<string | null>(null);
  // The desktop app's own server, and whether it is running (another copy of the app may hold its port).
  const [local, setLocal] = useState<{ running: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .connectedAgents()
      .then((res) => {
        setEnabled(res.enabled);
        setAgents(res.agents);
        setMcpUrl(res.mcpUrl ?? null);
        setLocal(res.local ? { running: res.running !== false } : null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const disconnect = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await api.disconnectAgent(id);
      setAgents((list) => list?.filter((a) => a.id !== id) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const copyInstruction = async () => {
    if (!mcpUrl) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(local ? claudeCommand(mcpUrl) : agentInstruction(mcpUrl));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('The instruction could not be copied.');
    }
  };

  return (
    <section className="home-inner changes" id="agents">
      {!enabled && !error && agents !== null && <p className="changes-empty">Agents cannot be connected here.</p>}
      {mcpUrl && (
        <div className="mcp-address">
          <p className="changes-intro">
            {local
              ? 'Agents on this computer (Claude Code, Codex, Cursor and others) can open, read and edit the files in the folders you open here, and the app shows what they open. Add this address to one as an MCP server; the app asks you to allow each agent that connects.'
              : 'Add this address to an agent (Claude Code, Codex, Cursor and others) as a remote MCP server, and it can open, read and edit your files once you allow it.'}
          </p>
          {local && !local.running && <div className="form-error">The MCP server is not running: its port is in use, probably by another copy of the app.</div>}
          <div className="mcp-address-row">
            <code className="mcp-address-url">{mcpUrl}</code>
            <button type="button" className="btn" onClick={() => void copyInstruction()} title={local ? claudeCommand(mcpUrl) : undefined}>
              {copied ? 'Copied' : local ? 'Copy Claude Code command' : 'Copy agent instruction'}
            </button>
          </div>
          {local && (
            <p className="field-hint">
              Or install the mcp-docs plugin, with <code>npx @freeflow-im/mcp-docs</code>. Then run <code>/mcp</code> in Claude Code to sign in.
            </p>
          )}
        </div>
      )}
      {enabled && <h2>Connected agents</h2>}
      {enabled && (
        <p className="changes-intro">
          {local
            ? 'Agents you allowed on this computer can read and change the files in the folders you open. Disconnect one to stop its access right away; it would have to be allowed again.'
            : 'Agents you signed in with a device code can read and change your files. Disconnect one to stop its access right away; it would have to be signed in again.'}
        </p>
      )}
      {error && <div className="form-error">{error}</div>}
      {agents === null ? (
        !error && <div className="page-loading">Loading…</div>
      ) : !enabled ? null : agents.length === 0 ? (
        <p className="changes-empty">No agents are connected.</p>
      ) : (
        <table className="agents-table">
          <thead>
            <tr>
              <th>Agent</th>
              {!local && <th>Signed in from</th>}
              <th>Connected</th>
              {!local && <th>Last active</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}>
                <td>
                  <div className="agents-name">{a.name}</div>
                  <div className="agents-endpoint">{a.endpoint}</div>
                </td>
                {!local && <td>{a.origin}</td>}
                <td>{when(a.connectedAt)}</td>
                {!local && <td>{a.lastActiveAt ? when(a.lastActiveAt) : ''}</td>}
                <td>
                  <button type="button" className="btn danger" disabled={busy === a.id} onClick={() => void disconnect(a.id)}>
                    {busy === a.id ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
