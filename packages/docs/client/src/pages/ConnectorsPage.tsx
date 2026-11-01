// Connectors: external data sources (Brex, ...) the assistant can pull into spreadsheets. Lists the available
// connectors and the user's connections, and sets them up. Secrets go to the server and are never shown again.
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ConnectionInfo, ConnectorInfo } from '../../../shared/connectors.ts';
import { AgentButton } from '../agent/AgentPanel.tsx';
import { api } from '../api.ts';
import { Account } from '../components/Account.tsx';
import { ConfirmModal, Modal } from '../components/Modal.tsx';
import { appName } from '../brand.ts';

const STATUS: Record<ConnectionInfo['status'], string> = { connected: 'Connected', error: 'Error', needs_reauth: 'Needs reconnecting' };

export function ConnectorsPage() {
  const [params, setParams] = useSearchParams();
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [connections, setConnections] = useState<ConnectionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(params.get('error'));
  const [notice, setNotice] = useState<string | null>(params.get('connected') ? 'Connected.' : null);
  const [editing, setEditing] = useState<{ connector: ConnectorInfo; connection?: ConnectionInfo } | null>(null);
  const [removing, setRemoving] = useState<ConnectionInfo | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([api.listConnectors(), api.listConnections()]);
      setConnectors(a.connectors);
      setConnections(b.connections);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    // Drop the OAuth callback's ?connected= / ?error= once shown.
    if (params.has('error') || params.has('connected')) setParams({}, { replace: true });
  }, [load]);

  const test = async (c: ConnectionInfo) => {
    setTesting(c.id);
    setError(null);
    setNotice(null);
    try {
      await api.testConnection(c.id);
      setNotice(`“${c.name}” is working.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(null);
      await load();
    }
  };

  const byId = new Map(connectors.map((c) => [c.id, c]));

  return (
    <div className="home">
      <header className="home-header">
        <div className="home-brand">
          <Link to="/" className="home-back">
            ‹ {appName()}
          </Link>
          <span>Connectors</span>
        </div>
        <div className="home-user">
          <AgentButton />
          <Account />
        </div>
      </header>

      <section className="home-inner changes connectors">
        <h2>Your connections</h2>
        <p className="changes-intro">
          Connect a data source, then ask the assistant to pull its data into a sheet, for example “ingest my Brex card transactions from the last 30 days into a
          tab called Brex”. Credentials are stored encrypted on the server and are never shown again, written into cells or given to the assistant.
        </p>
        {error && <div className="agent-error">{error}</div>}
        {notice && <div className="connector-notice">{notice}</div>}
        {connections === null ? (
          <div className="page-loading">Loading…</div>
        ) : connections.length === 0 ? (
          <p className="changes-empty">No connections yet. Add one below.</p>
        ) : (
          <ul className="change-list">
            {connections.map((c) => {
              const info = byId.get(c.connector);
              return (
                <li key={c.id} className="change">
                  <div className="change-head">
                    <div className="change-title">
                      <span className="connector-icon">{info?.icon ?? '?'}</span>
                      {c.name}
                    </div>
                    <span className={`connection-status ${c.status}`}>{STATUS[c.status]}</span>
                  </div>
                  <div className="change-meta">
                    {info?.name ?? c.connector}
                    {c.masked ? ` · ${c.masked}` : ''}
                    {c.lastUsedAt ? ` · last used ${formatDate(c.lastUsedAt)}` : ' · not used yet'}
                  </div>
                  {c.error && <div className="form-error">{c.error}</div>}
                  <div className="change-actions">
                    <button className="btn" disabled={testing === c.id} onClick={() => void test(c)}>
                      {testing === c.id ? 'Testing…' : 'Test connection'}
                    </button>
                    {info && c.authType === 'api_key' && (
                      <button className="btn" onClick={() => setEditing({ connector: info, connection: c })}>
                        Edit
                      </button>
                    )}
                    {info && c.authType === 'oauth2' && (
                      <a className="btn" href={`/api/connectors/${encodeURIComponent(info.id)}/oauth/start?name=${encodeURIComponent(c.name)}`}>
                        Reconnect
                      </a>
                    )}
                    <button className="btn danger" onClick={() => setRemoving(c)}>
                      Disconnect
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <h2>Available connectors</h2>
        <ul className="change-list">
          {connectors.map((c) => (
            <li key={c.id} className="change">
              <div className="change-head">
                <div className="change-title">
                  <span className="connector-icon">{c.icon}</span>
                  {c.name}
                </div>
                {c.authTypes.includes('api_key') ? (
                  <button className="btn primary" onClick={() => setEditing({ connector: c })}>
                    Connect
                  </button>
                ) : c.oauthAvailable ? (
                  <a className="btn primary" href={`/api/connectors/${encodeURIComponent(c.id)}/oauth/start`}>
                    Connect
                  </a>
                ) : (
                  <span className="change-meta">Not set up on this server</span>
                )}
              </div>
              <div className="change-meta">{c.description}</div>
              <div className="change-meta">Datasets: {c.datasets.map((d) => d.id).join(', ')}</div>
            </li>
          ))}
        </ul>
      </section>

      {editing && (
        <ConnectionDialog
          connector={editing.connector}
          connection={editing.connection}
          onClose={() => setEditing(null)}
          onSaved={(c) => {
            setEditing(null);
            setError(null);
            setNotice(`“${c.name}” is connected.`);
            void load();
          }}
        />
      )}
      {removing && (
        <ConfirmModal
          title="Disconnect?"
          message={<>“{removing.name}” and its stored credentials will be deleted. Data already in your spreadsheets stays.</>}
          confirmText="Disconnect"
          danger
          onConfirm={async () => {
            await api.deleteConnection(removing.id);
            await load();
          }}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

/** Setup (or edit) dialog driven by the connector's fields. */
function ConnectionDialog(props: { connector: ConnectorInfo; connection?: ConnectionInfo; onClose: () => void; onSaved: (c: ConnectionInfo) => void }) {
  const { connector, connection } = props;
  const [name, setName] = useState(connection?.name ?? connector.name);
  const [fields, setFields] = useState<Record<string, string>>(() => ({ ...connection?.settings }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);

  const testIt = async () => {
    setBusy(true);
    setError(null);
    setTested(null);
    try {
      await api.testCredentials(connector.id, fields, connection?.id);
      setTested('Connection works.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = connection ? await api.updateConnection(connection.id, name, fields) : await api.createConnection(connector.id, name, fields);
      props.onSaved(res.connection);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal title={connection ? `Edit ${connection.name}` : `Connect ${connector.name}`} onClose={props.onClose}>
      <form
        className="connector-form"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {connector.setupHelp && <p className="field-hint">{connector.setupHelp}</p>}
        <label className="field">
          <span>Connection name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder={`${connector.name} - Production`} />
        </label>
        {connector.fields.map((f) => (
          <label key={f.key} className="field">
            <span>{f.label}</span>
            <input
              type={f.secret ? 'password' : 'text'}
              autoComplete={f.secret ? 'new-password' : 'off'}
              value={fields[f.key] ?? ''}
              placeholder={f.secret && connection ? `Saved (${connection.masked ?? '••••'}); leave blank to keep` : f.placeholder}
              onChange={(e) => {
                setTested(null);
                setFields({ ...fields, [f.key]: e.target.value });
              }}
            />
            {f.help && <span className="field-hint">{f.help}</span>}
          </label>
        ))}
        {error && <div className="form-error">{error}</div>}
        {tested && <div className="connector-notice">{tested}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void testIt()}>
            Test connection
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Working…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
