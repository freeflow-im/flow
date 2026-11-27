// The small window background.js opens to ask about a new site when no side panel is open. It shows every waiting
// question and closes itself when none is left (answered here, in a panel, or timed out).
import { askCard, pendingAsks } from './sites.js';

const box = document.getElementById('asks');
async function show() {
  const asks = await pendingAsks();
  if (!asks.length) return window.close();
  for (const c of [...box.children]) if (!asks.some((a) => a.id === c.dataset.ask)) c.remove();
  const shown = new Set([...box.children].map((c) => c.dataset.ask));
  for (const a of asks) if (!shown.has(a.id)) box.append(askCard(a));
}

chrome.storage.session.onChanged.addListener((changes) => 'asks' in changes && void show());
void show();
