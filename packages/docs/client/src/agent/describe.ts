// Short labels for tool calls shown in the chat ("Wrote 12 cells at A1").

type Input = Record<string, unknown>;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function where(i: Input): string {
  const r = typeof i.range === 'string' ? i.range : typeof i.start === 'string' ? i.start : '';
  const t = typeof i.tab === 'string' ? i.tab : '';
  if (r && t && !r.includes('!')) return `${t}!${r}`;
  return r || t;
}

function span(a: unknown, b: unknown): string {
  return a === b ? String(a) : `${a}–${b}`;
}

/** "block 3" or "blocks 3–7" of a document. */
function blocks(i: Input): string {
  const to = i.to ?? i.from;
  return `${to === i.from ? 'block' : 'blocks'} ${span(i.from, to)}`;
}

/** A time as a label says it: "Thu, Nov 5, 12:00 PM", or "Thu, Nov 5" for a date; null for none. */
function when(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  const dateOnly = /^\d{4}-\d\d-\d\d$/.test(v);
  const d = new Date(dateOnly ? `${v}T12:00:00` : v);
  if (Number.isNaN(+d)) return null;
  return d.toLocaleString('en-US', dateOnly ? { weekday: 'short', month: 'short', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
/** People as a label names them: the names (or the part before @) of the first two, then "and N more". */
function people(list: unknown[]): string {
  const names = list.map((p) => { const s = String(p); return /^\s*"?([^"<]+?)"?\s*</.exec(s)?.[1] ?? s.split('@')[0]; });
  return names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

export function toolLabel(name: string, i: Input): string {
  switch (name) {
    case 'get_sheet_overview':
      return 'Looked over the spreadsheet';
    case 'read_range':
      return `Read ${where(i)}`;
    case 'write_range': {
      const rows = Array.isArray(i.rows) ? (i.rows as unknown[][]) : [];
      const cells = rows.reduce((n, r) => n + (Array.isArray(r) ? r.filter((v) => v !== null).length : 0), 0);
      return `Wrote ${plural(cells, 'cell')} at ${where(i)}`;
    }
    case 'clear_range':
      return `Cleared ${i.what === 'formats' ? 'formatting in ' : ''}${where(i)}`;
    case 'format_range':
      return `Formatted ${where(i)}`;
    case 'insert_rows':
      return `Inserted ${plural(Number(i.count), 'row')} at row ${i.at_row}`;
    case 'delete_rows':
      return `Deleted ${i.from_row === i.to_row ? 'row' : 'rows'} ${span(i.from_row, i.to_row)}`;
    case 'insert_columns':
      return `Inserted ${plural(Number(i.count), 'column')} at column ${String(i.at_column).toUpperCase()}`;
    case 'delete_columns':
      return `Deleted ${i.from_column === i.to_column ? 'column' : 'columns'} ${span(String(i.from_column).toUpperCase(), String(i.to_column).toUpperCase())}`;
    case 'move_columns': {
      const from = String(i.from_column).toUpperCase();
      const to = String(i.to_column ?? i.from_column).toUpperCase();
      return `Moved ${from === to ? 'column' : 'columns'} ${span(from, to)} before column ${String(i.before_column).toUpperCase()}`;
    }
    case 'sort_range':
      return `Sorted ${where(i)} by column ${String(i.by_column).toUpperCase()}`;
    case 'set_cell_image':
      return `Added an image to ${where(i)}`;
    case 'set_cell_link':
      return `Added a link to ${where(i)}`;
    case 'add_chart':
      return `Added a ${typeof i.type === 'string' ? `${i.type} ` : ''}chart${typeof i.title === 'string' && i.title ? ` “${i.title}”` : ''}`;
    case 'edit_chart':
      return 'Changed a chart';
    case 'delete_chart':
      return 'Deleted a chart';
    case 'set_filter':
      return typeof i.range === 'string' ? `Added a filter to ${where(i)}` : 'Removed the filter';
    case 'set_filter_criteria':
      return i.clear
        ? `Cleared the filter on column ${String(i.column).toUpperCase()}`
        : `Filtered column ${String(i.column).toUpperCase()} to ${Array.isArray(i.values) ? i.values.map((v) => `“${v}”`).join(', ') : 'chosen values'}`;
    case 'set_column_width':
      return `Resized column ${String(i.columns).toUpperCase()}`;
    case 'set_row_height':
      return `Resized ${String(i.rows).includes(':') ? 'rows' : 'row'} ${String(i.rows).trim()} to ${i.height}px`;
    case 'freeze':
      return 'Changed frozen rows and columns';
    case 'add_tab':
      return typeof i.name === 'string' ? `Added tab “${i.name}”` : 'Added a tab';
    case 'rename_tab':
      return `Renamed tab “${i.tab}” to “${i.name}”`;
    case 'delete_tab':
      return `Deleted tab “${i.tab}”`;
    case 'select_range':
      return `Selected ${where(i)}`;
    case 'open_sheet':
      return 'Opened a spreadsheet';
    case 'open_deck':
      return 'Opened a presentation';
    case 'read_deck':
      return 'Looked over the presentation';
    case 'add_slides': {
      const n = Array.isArray(i.slides) ? i.slides.length : 0;
      return `Added ${plural(n, 'slide')}`;
    }
    case 'update_slide':
      return `Updated slide ${i.slide}`;
    case 'edit_elements': {
      const n = (Array.isArray(i.set) ? i.set.length : 0) + (Array.isArray(i.remove) ? i.remove.length : 0);
      return `Changed ${plural(n, 'element')} on slide ${i.slide}`;
    }
    case 'delete_slides':
      return Array.isArray(i.slides) && i.slides.length === 1 ? `Deleted slide ${i.slides[0]}` : `Deleted ${plural(Array.isArray(i.slides) ? i.slides.length : 0, 'slide')}`;
    case 'move_slide':
      return `Moved slide ${i.slide} to position ${i.to}`;
    case 'set_deck_theme':
      return `Changed the theme to ${i.theme}`;
    case 'export_deck':
      return 'Exported the presentation as a PDF';
    case 'list_files':
      return 'Looked through the stored files';
    case 'open_file':
      return 'Opened a file';
    case 'edit_file':
      return i.undo ? 'Undid the last change to a file' : 'Edited a file';
    case 'view_image':
      return 'Looked at a picture';
    case 'edit_image':
      return 'Made an edited copy of a picture';
    case 'transform_image': {
      const ops = Array.isArray(i.operations) ? (i.operations as { op?: unknown }[]) : [];
      if (ops.length === 1 && ops[0]?.op === 'overlay') return 'Put a picture on top of another';
      return `Edited a picture (${ops.length} ${ops.length === 1 ? 'change' : 'changes'})`;
    }
    case 'convert_pdf':
      return 'Made a Markdown copy of a PDF';
    case 'export_pdf':
      return 'Made a PDF';
    case 'read_file':
      return i.offset ? 'Read more of a file' : 'Read a file';
    case 'render_slide':
      return `Checked how slide ${i.slide} looks`;
    case 'open_doc':
      return 'Opened a document';
    case 'get_doc_info':
      return 'Checked the document’s fonts and stats';
    case 'read_doc':
      return typeof i.from === 'number' ? `Read blocks ${i.from}–${i.to ?? i.from} of the document` : 'Read the document';
    case 'insert_content':
      return i.after === 0 ? 'Added content at the top of the document' : typeof i.after === 'number' ? `Added content after block ${i.after}` : 'Added content to the document';
    case 'replace_blocks':
      return `Rewrote ${blocks(i)}`;
    case 'delete_blocks':
      return `Deleted ${blocks(i)}`;
    case 'replace_text':
      return `Replaced “${i.find}” with “${i.replace}”`;
    case 'format_text':
      return typeof i.find === 'string' && i.find ? `Formatted “${i.find}”` : `Formatted ${blocks(i)}`;
    case 'format_blocks':
      return `${typeof i.type === 'string' ? `Changed ${blocks(i)} to ${String(i.type).replace('_', ' ')}` : `Aligned ${blocks(i)}`}`;
    case 'insert_image':
      return 'Added an image to the document';
    case 'set_doc_style':
      return 'Changed the document’s default style';
    case 'set_page_setup':
      return i.mode === 'pageless' ? 'Switched the document to pageless' : 'Changed the page setup';
    case 'find_files':
      return typeof i.query === 'string' && i.query ? `Searched your files for “${i.query}”` : 'Listed your files';
    case 'read_stored_file':
      return 'Read a file';
    case 'list_docs':
      return typeof i.query === 'string' && i.query ? `Searched your documents for “${i.query}”` : 'Listed your documents';
    case 'create_doc':
      return `Created ${i.kind === 'markdown' ? 'Markdown document' : 'document'} “${i.title}”`;
    case 'read_other_doc':
      return 'Read another document';
    case 'list_decks':
      return typeof i.query === 'string' && i.query ? `Searched your presentations for “${i.query}”` : 'Listed your presentations';
    case 'create_deck':
      return `Created presentation “${i.title}”`;
    case 'request_research':
      return `Started research: ${String(i.title ?? '')}`;
    case 'request_app_change':
      return `Requested an app change: ${String(i.title ?? '')}`;
    case 'list_sheets':
      return typeof i.query === 'string' && i.query ? `Searched your spreadsheets for “${i.query}”` : 'Listed your spreadsheets';
    case 'read_other_sheet':
      return typeof i.range === 'string' ? `Read ${where(i)} in another spreadsheet` : 'Looked at another spreadsheet';
    case 'create_sheet':
      return `Created spreadsheet “${i.title}”`;
    case 'list_connections':
      return 'Checked your data connections';
    case 'fetch_connector_data':
      return `Previewed ${String(i.dataset ?? 'data')} from a connection`;
    case 'ingest_connector_data':
      return `${i.mode === 'append' ? 'Appended' : 'Imported'} ${String(i.dataset ?? 'data')} into ${typeof i.tab === 'string' ? `“${i.tab}”` : 'the sheet'}${typeof i.start_cell === 'string' ? ` at ${i.start_cell}` : ''}`;
    case 'web_search':
      return `Searched the web for “${i.query}”`;
    case 'import_file':
      return String(i.url ?? '').includes('/api/images/') ? 'Saved a picture to your files' : 'Saved a file from the web';
    case 'image_search':
      return `Searched for images of “${i.query}”`;
    // The user's email, in the hosted app (FreeFlow Mail).
    case 'search_mail':
      return i.query ? `Searched your mail for “${i.query}”` : 'Looked at your latest mail';
    case 'read_mail': {
      const n = Array.isArray(i.ids) ? i.ids.length : 1;
      return n === 1 ? 'Read an email' : `Read ${n} emails`;
    }
    case 'create_mail_draft':
      return i.reply_to_id ? 'Drafted a reply' : i.forward_id ? 'Drafted a forward' : 'Drafted an email';
    case 'save_mail_attachment_to_docs':
      return 'Saved an email attachment to your files';
    case 'open_mail_message':
      return 'Opened an email';
    // The user's calendars, in the hosted app (FreeFlow Calendar).
    case 'list_calendars':
      return 'Looked at your calendars';
    case 'list_shared_calendars':
      return 'Looked at the calendars shared with you';
    case 'get_booking_link':
      return 'Looked up your booking page link';
    case 'share_calendar':
      return `Shared a calendar with ${sharee(i.principal)}${typeof i.role === 'string' ? ` as ${i.role}` : ''}`;
    case 'unshare_calendar':
      return `Stopped sharing a calendar with ${sharee(i.principal)}`;
    case 'list_events':
      return i.q ? `Searched your calendar for “${i.q}”` : `Looked at your calendar${when(i.from) ? ` from ${when(i.from)}` : ''}`;
    case 'get_event':
      return 'Read an event';
    case 'find_free_time':
      return `Found free time${Array.isArray(i.attendees) && i.attendees.length ? ` with ${people(i.attendees)}` : ''}`;
    case 'create_event':
      return `Created “${String(i.summary ?? 'an event')}”${when(i.start) ? ` ${when(i.start)}` : ''}${Array.isArray(i.attendees) && i.attendees.length ? `, invited ${people(i.attendees)}` : ''}`;
    case 'update_event':
      return i.start ? `Moved an event to ${when(i.start)}` : 'Changed an event';
    case 'delete_event':
      return i.scope === 'all' ? 'Deleted a repeating event' : i.scope === 'following' ? 'Deleted events from a series' : 'Deleted an event';
    case 'respond_to_event':
      return i.response === 'accepted' ? 'Accepted an invitation' : i.response === 'declined' ? 'Declined an invitation' : 'Answered maybe to an invitation';
    case 'open_calendar_event':
      return 'Opened an event';
    case 'show_calendar_range':
      return `Showed ${when(i.from) ?? 'the calendar'}`;
    default:
      // A tool of an app added by manifest (platform.md §6.1) has no label here: its name, as a sentence ("Find contact").
      return agentToolLabel(name, i) ?? sentenceOf(name);
  }
}

const sentenceOf = (name: string): string => (/^[a-z][a-z0-9_]*$/.test(name) ? name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ') : name);

/** Who share_calendar or unshare_calendar names: a member by address, a channel, or the organization. */
const sharee = (p: unknown): string => {
  const x = (p && typeof p === 'object' ? p : {}) as { account?: unknown; channel?: unknown; org?: unknown };
  return x.org ? 'everyone' : typeof x.account === 'string' ? people([x.account]) : x.channel ? 'a channel' : 'someone';
};

/** The file a tool of Claude Code's names, by its name alone. */
const fileName = (p: unknown) => (typeof p === 'string' ? (p.split('/').pop() ?? p) : 'a file');
const short = (s: unknown, n = 60) => {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * Claude Code's own tools, when the user's Claude Code runs the assistant (server/agent/claudeAgent.ts), and
 * the app's MCP tools the built-in assistant does not have.
 */
function agentToolLabel(name: string, i: Input): string | null {
  switch (name) {
    case 'search_files':
      return `Looked for “${short(i.query, 40)}”`;
    case 'create_folder':
      return `Made the folder ${short(i.path ?? i.name)}`;
    case 'move_file':
      return typeof i.folder === 'string' && i.folder ? `Moved a file to ${short(i.folder)}` : 'Moved a file to the top folder';
    case 'rename_file':
      return `Renamed a file to “${short(i.title ?? i.name, 40)}”`;
    case 'delete_file':
      return 'Deleted a file';
    case 'upload_file':
      return `Uploaded ${short(i.file_name)}`;
    case 'convert_pdf_to_markdown':
      return 'Made a Markdown copy of a PDF';
    case 'get_profile':
      return 'Checked the account';
    case 'Bash':
      return i.description ? String(i.description) : `Ran ${short(i.command)}`;
    case 'Read':
      return `Read ${fileName(i.file_path)}`;
    case 'Write':
      return `Wrote ${fileName(i.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edited ${fileName(i.file_path)}`;
    case 'Glob':
      return `Looked for files matching ${short(i.pattern)}`;
    case 'Grep':
      return `Searched files for “${short(i.pattern, 40)}”`;
    case 'WebSearch':
      return `Searched the web for “${short(i.query)}”`;
    case 'WebFetch':
      return `Read ${short(i.url)}`;
    case 'Task':
    case 'Agent':
      return i.description ? `Asked a subagent: ${short(i.description)}` : 'Asked a subagent';
    case 'TodoWrite':
      return 'Updated its to-do list';
    case 'ToolSearch':
      return 'Looked up its tools';
    default:
      return null;
  }
}
