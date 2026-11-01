// A ```mermaid code block of a Markdown document, drawn as its diagram. Mermaid is large, so the page that
// wants diagrams hands in how to load it (MarkdownPreview's `loadMermaid`) and it is fetched when the first
// diagram is drawn. Text that is not a diagram yet (while it is being typed) shows what is wrong with it
// under the last diagram that could be drawn.
import { useEffect, useId, useState } from 'react';

/** The part of Mermaid that is used. */
export interface MermaidApi {
  initialize(config: { startOnLoad: boolean; securityLevel: 'strict'; theme: 'default'; fontFamily?: string }): void;
  parse(text: string): Promise<unknown>;
  render(id: string, text: string): Promise<{ svg: string }>;
}
export type MermaidLoader = () => Promise<{ default: MermaidApi }>;

let loaded: Promise<MermaidApi> | null = null;
function mermaid(load: MermaidLoader): Promise<MermaidApi> {
  loaded ??= load().then(({ default: api }) => {
    // Strict: text in a diagram is never HTML, and a diagram cannot run script or bind clicks.
    api.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default', fontFamily: 'inherit' });
    return api;
  });
  // A failed fetch (offline) is tried again by the next diagram.
  loaded.catch(() => (loaded = null));
  return loaded;
}

// Diagrams are drawn one at a time: Mermaid measures each in the page while it draws.
let queue: Promise<unknown> = Promise.resolve();

export function MermaidDiagram({ code, load }: { code: string; load: MermaidLoader }) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    const draw = async () => {
      if (gone) return;
      try {
        const api = await mermaid(load);
        // Parsing first says what is wrong without Mermaid drawing its own error picture into the page.
        await api.parse(code);
        const out = await api.render(id, code);
        if (gone) return;
        setSvg(out.svg);
        setProblem(null);
      } catch (e) {
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
        if (!gone) setProblem(e instanceof Error ? e.message : String(e));
      }
    };
    // A short wait, so a diagram being typed is not drawn at every key.
    const timer = setTimeout(() => (queue = queue.then(draw, draw)), 150);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [code, id, load]);

  return (
    <figure className="md-mermaid">
      {svg !== null && <div className="md-mermaid-drawing" dangerouslySetInnerHTML={{ __html: svg }} />}
      {problem !== null && (
        <>
          {svg === null && (
            <pre>
              <code>{code}</code>
            </pre>
          )}
          <figcaption className="md-mermaid-problem">
            <strong>This diagram cannot be drawn.</strong> {problem.split('\n').slice(0, 3).join('\n')}
          </figcaption>
        </>
      )}
      {svg === null && problem === null && <div className="md-mermaid-wait muted">Drawing the diagram…</div>}
    </figure>
  );
}
