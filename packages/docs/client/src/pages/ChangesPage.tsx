// The app's change history: every change the assistant made to the app's own code, with its record and a
// way to revert it.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { JOB_ACTIVE_STATUSES, type AgentJob } from '../../../shared/agent/protocol.ts';
import { AgentButton } from '../agent/AgentPanel.tsx';
import { api, ApiError } from '../api.ts';
import { Account } from '../components/Account.tsx';
import { ConfirmModal } from '../components/Modal.tsx';

const STATUS: Record<AgentJob['status'], string> = {
  queued: 'Waiting to start',
  starting: 'Starting',
  coding: 'Changing the code',
  verifying: 'Running the checks',
  building: 'Building',
  restarting: 'Restarting the app',
  publishing: 'Live, publishing to GitHub',
  done: 'Live',
  failed: 'Failed',
};

export function ChangesPage() {
  const [jobs, setJobs] = useState<AgentJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reverting, setReverting] = useState<AgentJob | null>(null);

  const load = useCallback(async () => {
    try {
      setJobs((await api.listJobs()).jobs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep refreshing while a job runs.
  const active = jobs?.some((j) => JOB_ACTIVE_STATUSES.has(j.status)) ?? false;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [active, load]);

  const revert = async (job: AgentJob) => {
    try {
      await api.revertJob(job.id);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The revert could not be started.');
    }
  };

  const byId = new Map((jobs ?? []).map((j) => [j.id, j]));

  return (
    <div className="home">
      <header className="home-header">
        <div className="home-brand">
          <Link to="/" className="home-back">
            ‹ MCP Docs
          </Link>
          <span>Changes</span>
        </div>
        <div className="home-user">
          <AgentButton />
          <Account />
        </div>
      </header>

      <section className="home-inner changes">
        <h2>Changes and research by the assistant</h2>
        <p className="changes-intro">
          Each entry is the app’s own record of a job requested through the assistant: a change to the app (what was asked, what the coding agent did,
          where it was published) or a research task and its report. Reverting a change queues a new change that undoes it.
        </p>
        {error && <div className="agent-error">{error}</div>}
        {jobs === null ? (
          <div className="page-loading">Loading…</div>
        ) : jobs.length === 0 ? (
          <p className="changes-empty">No changes yet. Ask the assistant for something it can’t do, and it will offer to add it.</p>
        ) : (
          <ul className="change-list">
            {jobs.map((job) => {
              const isActive = JOB_ACTIVE_STATUSES.has(job.status);
              const reverts = job.revertsJobId ? byId.get(job.revertsJobId) : undefined;
              const revertedBy = job.revertedByJobId ? byId.get(job.revertedByJobId) : undefined;
              const canRevert = job.kind === 'change' && job.status === 'done' && !job.revertedByJobId && !active;
              const open = expanded === job.id;
              return (
                <li key={job.id} className={`change ${job.status}${job.revertedByJobId ? ' reverted' : ''}`}>
                  <div className="change-head">
                    <div className="change-title">
                      {job.kind === 'revert' ? <span className="change-kind">Revert</span> : null}
                      {job.kind === 'research' ? <span className="change-kind research">Research</span> : null}
                      {job.title}
                    </div>
                    <span className={`change-status ${job.status}`}>
                      {job.kind === 'research' ? (job.status === 'done' ? 'Finished' : job.status === 'coding' ? 'Researching' : STATUS[job.status]) : STATUS[job.status]}
                    </span>
                  </div>
                  <div className="change-meta">
                    {formatDate(job.createdAt)}
                    {job.requestedBy ? ` · requested by ${job.requestedBy}` : ''}
                    {job.prUrl ? (
                      <>
                        {' · '}
                        <a href={job.prUrl} target="_blank" rel="noreferrer">
                          PR #{job.prNumber}
                        </a>
                        {job.mergedSha ? ` merged as ${job.mergedSha.slice(0, 7)}` : ' (not merged)'}
                      </>
                    ) : job.status === 'done' && job.kind !== 'research' ? (
                      ' · not published (left in the working tree)'
                    ) : null}
                    {typeof job.costUsd === 'number' ? ` · $${job.costUsd.toFixed(2)}` : ''}
                  </div>
                  {reverts && (
                    <div className="change-note">
                      Undoes “{reverts.title}”{reverts.prUrl ? ` (PR #${reverts.prNumber})` : ''}.
                    </div>
                  )}
                  {revertedBy && <div className="change-note">Reverted on {formatDate(revertedBy.createdAt)}.</div>}
                  {job.summary && <p className="change-summary">{job.summary}</p>}
                  {job.error && <pre className="agent-job-error">{job.error}</pre>}
                  {isActive && job.log.length > 0 && (
                    <ul className="agent-job-log">
                      {job.log.slice(-3).map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                  )}
                  <div className="change-actions">
                    <button className="link" onClick={() => setExpanded(open ? null : job.id)}>
                      {open ? 'Hide details' : 'Details'}
                    </button>
                    {canRevert && (
                      <button className="btn danger" onClick={() => setReverting(job)}>
                        Revert
                      </button>
                    )}
                  </div>
                  {open && (
                    <div className="change-details">
                      <h4>Request</h4>
                      <pre>{job.spec}</pre>
                      {job.files && job.files.length > 0 && (
                        <>
                          <h4>Files</h4>
                          <ul>
                            {job.files.map((f) => (
                              <li key={f}>{f}</li>
                            ))}
                          </ul>
                        </>
                      )}
                      {job.branch && (
                        <>
                          <h4>Git</h4>
                          <div>
                            Branch {job.branch}
                            {job.commitSha ? `, commit ${job.commitSha.slice(0, 7)}` : ''}
                          </div>
                        </>
                      )}
                      {job.log.length > 0 && (
                        <>
                          <h4>Log</h4>
                          <ul className="agent-job-log">
                            {job.log.map((line, i) => (
                              <li key={i}>{line}</li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {reverting && (
        <ConfirmModal
          title="Revert this change?"
          message={
            <>
              “{reverting.title}” will be undone by a new change that goes through the same checks, restart and publishing. The assistant loses any
              capability it added.
            </>
          }
          confirmText="Revert"
          danger
          onConfirm={async () => {
            const job = reverting;
            setReverting(null);
            await revert(job);
          }}
          onClose={() => setReverting(null)}
        />
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
