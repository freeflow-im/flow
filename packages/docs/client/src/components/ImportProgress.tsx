import { queueDone, queueFinished, type ImportQueue } from '../importQueue.ts';

/** The small card in the corner while several dropped files are imported: each file's state and a bar for them all. */
export function ImportProgress({ queue, onDismiss }: { queue: ImportQueue; onDismiss?(): void }) {
  const done = queueDone(queue);
  const finished = queueFinished(queue);
  const failed = queue.filter((i) => i.state === 'failed').length;
  const title = !finished ? `Uploading ${Math.min(done + 1, queue.length)} of ${queue.length}` : failed ? `${queue.length - failed} of ${queue.length} uploaded` : `${queue.length} files uploaded`;
  return (
    <div className="import-queue" role="status" aria-live="polite">
      <div className="import-queue-head">
        <span>{title}</span>
        {finished && onDismiss && (
          <button className="import-queue-close" onClick={onDismiss} aria-label="Close" title="Close">
            ×
          </button>
        )}
      </div>
      <div className="import-queue-bar" aria-hidden="true">
        <div style={{ width: `${(done / queue.length) * 100}%` }} className={failed ? 'has-failed' : undefined} />
      </div>
      <ul className="import-queue-list">
        {queue.map((item, i) => (
          <li key={i} className={`import-queue-item ${item.state}`} title={item.error ?? item.name}>
            <span className="import-queue-state" aria-label={item.state}>
              {item.state === 'uploading' ? <span className="spinner small" /> : item.state === 'done' ? '✓' : item.state === 'failed' ? '!' : '·'}
            </span>
            <span className="import-queue-name">{item.name}</span>
            {item.error && <span className="import-queue-error">{item.error}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
