import { createRoot } from 'react-dom/client';
import '../../client/src/styles.css';
import './widget.css';
import { DocsApp } from './DocsApp.tsx';
import { Host } from './host.ts';

const host = new Host();
const root = createRoot(document.getElementById('root')!);
root.render(<div className="page-loading">Connecting to ChatGPT…</div>);
host
  .connect()
  .then(() => root.render(<DocsApp host={host} />))
  .catch((e: unknown) => root.render(<div className="page-error">Could not connect to ChatGPT: {String((e as Error).message ?? e)}</div>));
