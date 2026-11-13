// The text around a search match (GET /api/search), the matched words marked: the server puts them between \u0002 and
// \u0003, characters no document holds, so the text is never read as HTML.
export function SearchSnippet({ text }: { text: string }) {
  const parts = text.split(/(\u0002[^\u0003]*\u0003)/);
  return (
    <span className="search-snippet">
      {parts.map((p, i) => (p.startsWith('\u0002') ? <mark key={i}>{p.slice(1, -1)}</mark> : p))}
    </span>
  );
}
