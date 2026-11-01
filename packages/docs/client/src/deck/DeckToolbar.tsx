// Toolbar for the deck editor: slides, layout, theme, inserting elements, text styling and arrangement.
import { useEffect, useState, type ReactNode } from 'react';
import { buildSlide, type ChartElement, LAYOUT_IDS, SLIDE_H, SLIDE_W, THEME_IDS, THEMES, type ArrowStyle, type LayoutId, type LineElement, type LineKind, type TextElement, type ThemeId } from '../../../shared/deck.ts';
import { ARROW_STYLES, DASH_STYLES, DEFAULT_LINE_WIDTH } from '../../../shared/lines.ts';
import { SHAPE_KINDS, SHAPES } from '../../../shared/shapes.ts';
import { sourceLabel, TABLE_SIZE } from '../../../shared/deckTable.ts';
import type { LinkedTableSync } from './linkedTables.ts';
import { MOD } from '../commands.ts';
import { ColorPicker } from '../components/ColorPicker.tsx';
import { MenuList, type MenuItem } from '../components/Menu.tsx';
import type { DeckController } from './controller.ts';
import { GOOGLE_FONTS } from './fonts.ts';
import { ShapeIcon } from './ShapeIcon.tsx';

const FONTS = [...GOOGLE_FONTS].sort();

export const LAYOUT_NAMES: Record<LayoutId, string> = {
  title: 'Title slide',
  section: 'Section header',
  'title-body': 'Title and body',
  'two-column': 'Two columns',
  image: 'Title and image',
  blank: 'Blank',
};

/** Menu items for inserting each shape, with its icon. */
export function shapeMenuItems(ctl: DeckController): MenuItem[] {
  return SHAPE_KINDS.map((s) => ({
    label: (
      <span className="menu-icon-label">
        <ShapeIcon kind={s} size={16} /> {SHAPES[s].name}
      </span>
    ),
    action: () => ctl.addShape(s),
  }));
}

/** A grid of shape icons that opens from the toolbar. */
function ShapePicker({ ctl }: { ctl: DeckController }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="tb-drop" onMouseDown={(e) => e.stopPropagation()}>
      <Btn title="Shape" active={open} onClick={() => setOpen(!open)}>
        <ShapeIcon kind="triangle" size={18} /> <span className="tb-caret">▾</span>
      </Btn>
      {open && (
        <div className="shape-picker" role="menu" aria-label="Shapes">
          {SHAPE_KINDS.map((s) => (
            <button
              key={s}
              role="menuitem"
              title={SHAPES[s].name}
              aria-label={SHAPES[s].name}
              onClick={() => {
                ctl.addShape(s);
                setOpen(false);
              }}
            >
              <ShapeIcon kind={s} size={24} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Table sizes offered in the Insert menu, as rows × columns. */
export const TABLE_SIZES: [number, number][] = [
  [2, 2],
  [3, 3],
  [4, 3],
  [5, 4],
  [6, 5],
];

/** Insert menu items for a table of each size. */
export function tableMenuItems(ctl: DeckController): MenuItem[] {
  return TABLE_SIZES.map(([r, c]) => ({ label: `${r} rows × ${c} columns`, action: () => ctl.addTable(r, c) }));
}

const PICK_ROWS = 8;
const PICK_COLS = 10;

const tableIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path d="M3 9.5h18M3 15h18M9 4v16M15 4v16" fill="none" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);

/** The Table button: a grid to pick the new table's size by pointing at its last cell. */
function TablePicker({ ctl, onFromSheet }: { ctl: DeckController; onFromSheet?(): void }) {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState<[number, number]>([0, 0]);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className="tb-drop" onMouseDown={(e) => e.stopPropagation()}>
      <Btn
        title="Table"
        active={open}
        onClick={() => {
          setSize([0, 0]);
          setOpen(!open);
        }}
      >
        {tableIcon} <span className="tb-caret">▾</span>
      </Btn>
      {open && (
        <div className="table-picker" role="menu" aria-label="Table size" onMouseLeave={() => setSize([0, 0])}>
          <div className="table-picker-grid" style={{ gridTemplateColumns: `repeat(${PICK_COLS}, 1fr)` }}>
            {Array.from({ length: PICK_ROWS * PICK_COLS }, (_, k) => {
              const r = Math.floor(k / PICK_COLS) + 1;
              const c = (k % PICK_COLS) + 1;
              return (
                <button
                  key={k}
                  role="menuitem"
                  aria-label={`${r} by ${c} table`}
                  className={r <= size[0] && c <= size[1] ? 'on' : undefined}
                  onMouseEnter={() => setSize([r, c])}
                  onFocus={() => setSize([r, c])}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    ctl.addTable(r, c);
                    setOpen(false);
                  }}
                />
              );
            })}
          </div>
          <div className="table-picker-label">{size[0] ? `${size[0]} × ${size[1]}` : 'Insert table'}</div>
          {onFromSheet && (
            <button
              className="table-picker-sheet"
              role="menuitem"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpen(false);
                onFromSheet();
              }}
            >
              From a spreadsheet…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Width of a layout's picture in the layout pickers. */
const LAYOUT_THUMB_W = 132;
/** Each layout as an empty slide, with the placeholders a new slide of it has. */
const LAYOUT_SAMPLES = Object.fromEntries(
  LAYOUT_IDS.map((l) => {
    let n = 0;
    return [l, buildSlide(l, {}, () => `layout-${l}-${n++}`)];
  }),
) as Record<LayoutId, ReturnType<typeof buildSlide>>;

/**
 * A layout as a picture frame: the slide in the deck's colors with a bar where each line of text goes and a
 * box where the picture goes, drawn from the layout's own elements so it is always where they really are.
 */
function LayoutThumb({ layout, theme: themeId }: { layout: LayoutId; theme: ThemeId }) {
  const theme = THEMES[themeId];
  const marks: ReactNode[] = [];
  for (const el of LAYOUT_SAMPLES[layout].elements) {
    if (el.type === 'text') {
      const role = el.role ?? 'body';
      const align = el.style?.align ?? 'left';
      // One bar for a title, subtitle or caption; a few lines for body text.
      const bar = (key: string, y: number, h: number, share: number, fill: string, opacity = 1) => {
        const w = el.w * share;
        const x = align === 'center' ? el.x + (el.w - w) / 2 : el.x;
        marks.push(<rect key={key} x={x} y={y} width={w} height={h} rx={h / 2} fill={fill} opacity={opacity} />);
      };
      if (role === 'body') [0.9, 0.72, 0.84, 0.55].forEach((share, k) => bar(`${el.id}-${k}`, el.y + 14 + k * 52, 20, share, theme.text, 0.35));
      else if (role === 'title') bar(el.id, el.style?.valign === 'bottom' ? el.y + el.h - 46 : el.y, 40, align === 'center' ? 0.62 : 0.5, theme.heading);
      else bar(el.id, el.y + 4, 22, 0.36, theme.muted, 0.8);
    } else if (el.type === 'shape' && el.text) {
      // The picture's place: a frame with a landscape in it.
      const cx = el.x + el.w / 2;
      const cy = el.y + el.h / 2;
      marks.push(
        <g key={el.id} fill="none" stroke={theme.muted} strokeWidth={8} strokeLinejoin="round">
          <rect x={el.x} y={el.y} width={el.w} height={el.h} rx={14} fill={theme.muted} fillOpacity={0.12} />
          <path d={`M${cx - 110} ${cy + 60}l70 -90 55 60 40 -40 55 70z`} fill={theme.muted} fillOpacity={0.5} stroke="none" />
          <circle cx={cx + 60} cy={cy - 50} r={20} fill={theme.muted} fillOpacity={0.5} stroke="none" />
        </g>,
      );
    } else if (el.type === 'shape') marks.push(<rect key={el.id} x={el.x} y={el.y} width={el.w} height={Math.max(el.h, 12)} fill={theme.accent} />);
  }
  return (
    <svg className="layout-thumb" width={LAYOUT_THUMB_W} height={(LAYOUT_THUMB_W * SLIDE_H) / SLIDE_W} viewBox={`0 0 ${SLIDE_W} ${SLIDE_H}`} aria-hidden="true">
      <rect width={SLIDE_W} height={SLIDE_H} fill={theme.bg} />
      {marks}
    </svg>
  );
}

/** A toolbar menu of the slide layouts, each drawn as a small slide in the deck's theme. */
function LayoutPicker({ title, label, theme, current, onPick }: { title: string; label: ReactNode; theme: ThemeId; /** The layout to mark as the one in use. */ current?: LayoutId; onPick(layout: LayoutId): void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className="tb-drop" onMouseDown={(e) => e.stopPropagation()}>
      <Btn title={title} active={open} onClick={() => setOpen(!open)}>
        {label} <span className="tb-caret">▾</span>
      </Btn>
      {open && (
        <div className="layout-picker" role="menu" aria-label={title}>
          {LAYOUT_IDS.map((l) => (
            <button
              key={l}
              role="menuitemradio"
              aria-checked={current === l}
              className={current === l ? 'current' : undefined}
              title={LAYOUT_NAMES[l]}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(l);
                setOpen(false);
              }}
            >
              <LayoutThumb layout={l} theme={theme} />
              <span className="layout-name">{LAYOUT_NAMES[l]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const LINE_TOOLS: { name: string; kind: LineKind; arrow: boolean; path: string }[] = [
  { name: 'Line', kind: 'straight', arrow: false, path: 'M4 20L20 4' },
  { name: 'Arrow', kind: 'straight', arrow: true, path: 'M4 20L19 5M12 5h7v7' },
  { name: 'Elbow connector', kind: 'elbow', arrow: true, path: 'M4 6h8v12h8M16 14l4 4-4 4' },
  { name: 'Curved connector', kind: 'curved', arrow: true, path: 'M4 6c10 0 6 12 16 12M16 14l4 4-4 4' },
];

const lineIcon = (path: string) => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <path d={path} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** The Line menu: pick a kind of line, then drag on the slide to draw it. */
function LinePicker({ ctl }: { ctl: DeckController }) {
  const items: MenuItem[] = LINE_TOOLS.map((t) => ({
    label: (
      <span className="menu-icon-label">
        {lineIcon(t.path)} {t.name}
      </span>
    ),
    checked: ctl.tool?.kind === t.kind && ctl.tool.arrow === t.arrow,
    action: () => ctl.setTool({ kind: t.kind, arrow: t.arrow }),
  }));
  return <Drop title="Line" label={<span className={ctl.tool ? 'active' : ''}>{lineIcon(LINE_TOOLS[0].path)}</span>} items={items} />;
}

const ARROW_NAMES: Record<ArrowStyle, string> = { none: 'None', arrow: 'Arrow', open: 'Open arrow', triangle: 'Triangle', circle: 'Circle', diamond: 'Diamond' };
const WEIGHTS = [1, 2, 3, 4, 6, 8, 12];

const SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72];

function Btn({ title, active, onClick, children, disabled }: { title: string; active?: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button className={`tb-btn${active ? ' active' : ''}`} title={title} aria-label={title} aria-pressed={active} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {children}
    </button>
  );
}

/** A toolbar button that opens a menu. */
function Drop({ title, label, items, disabled }: { title: string; label: ReactNode; items: MenuItem[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="tb-drop" onMouseDown={(e) => e.stopPropagation()}>
      <Btn title={title} active={open} onClick={() => setOpen(!open)} disabled={disabled}>
        {label} <span className="tb-caret">▾</span>
      </Btn>
      {open && <MenuList items={items} onDone={() => setOpen(false)} style={{ top: 32, left: 0 }} />}
    </div>
  );
}

/** The controls of the selected table: rows and columns, the header and banding, and the current cell's look (every cell's when there is no current cell). */
function TableControls({ ctl, linked, onOpenSheet }: { ctl: DeckController; linked?: LinkedTableSync | null; onOpenSheet?(id: string): void }) {
  const table = ctl.table!;
  // A linked table's rows, columns and cells are its spreadsheet range's: only its own look is changed here.
  const src = table.source;
  const problem = linked?.problems.get(table.id);
  const at = ctl.tableCell?.id === table.id ? ctl.tableCell : null;
  const cell = at ? table.rows[at.r]?.[at.c] : table.rows[0][0];
  const headerCell = !!table.header && (at ? at.r === 0 : false);
  const bold = cell?.bold ?? headerCell;
  const italic = !!cell?.italic;
  const align = cell?.align ?? 'left';
  const size = table.style?.size ?? TABLE_SIZE;
  const scope = at ? 'the cell' : 'every cell';
  const items: MenuItem[] = [
    ...(src
      ? []
      : ([
          { label: 'Insert row above', action: () => ctl.insertTableRow('above') },
          { label: 'Insert row below', action: () => ctl.insertTableRow('below') },
          { label: 'Insert column left', action: () => ctl.insertTableColumn('left') },
          { label: 'Insert column right', action: () => ctl.insertTableColumn('right') },
          'sep',
          { label: 'Delete row', action: () => ctl.deleteTableRow() },
          { label: 'Delete column', action: () => ctl.deleteTableColumn() },
          'sep',
        ] as MenuItem[])),
    { label: 'Header row', checked: !!table.header, action: () => ctl.setTableOptions({ header: !table.header }) },
    { label: 'Banded rows', checked: !!table.banded, action: () => ctl.setTableOptions({ banded: !table.banded }) },
    { label: 'Equal column widths', disabled: !table.cols, action: () => ctl.setTableOptions({ cols: undefined }) },
  ];
  const linkItems: MenuItem[] = src
    ? [
        { label: 'Refresh now', action: () => void linked?.retry(table.id) },
        ...(onOpenSheet ? [{ label: 'Open the spreadsheet', action: () => onOpenSheet(src.sheet) }] : []),
        'sep',
        { label: 'Unlink (keep these values)', action: () => ctl.unlinkTable() },
      ]
    : [];
  return (
    <>
      <span className="tb-sep" />
      <Drop title="Table rows and columns" label={tableIcon} items={items} />
      {src && (
        <Drop
          title={problem ? `Linked to ${sourceLabel(src)}, which could not be read: ${problem}` : `Linked to ${sourceLabel(src)}; it changes when the spreadsheet does`}
          label={<span className={`tb-linked${problem ? ' problem' : ''}`}>{problem ? '⚠ Linked' : 'Linked'}</span>}
          items={linkItems}
        />
      )}
      {!src && (
        <>
          <Btn title={`Bold (${scope})`} active={bold} onClick={() => ctl.styleCells({ bold: !bold === headerCell ? undefined : !bold })}>
            <b>B</b>
          </Btn>
          <Btn title={`Italic (${scope})`} active={italic} onClick={() => ctl.styleCells({ italic: italic ? undefined : true })}>
            <i>I</i>
          </Btn>
        </>
      )}
      <select className="tb-select" title="Table font" aria-label="Table font" value={table.style?.font ?? ''} onMouseDown={(e) => e.stopPropagation()} onChange={(e) => ctl.styleTable({ font: e.target.value || undefined })}>
        <option value="">Theme font</option>
        {table.style?.font && !FONTS.includes(table.style.font) && <option value={table.style.font}>{table.style.font}</option>}
        {FONTS.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      <select className="tb-select" title="Table font size" aria-label="Table font size" value={SIZES.includes(size) ? size : ''} onMouseDown={(e) => e.stopPropagation()} onChange={(e) => ctl.styleTable({ size: Number(e.target.value) === TABLE_SIZE ? undefined : Number(e.target.value) })}>
        {!SIZES.includes(size) && <option value="">{size}</option>}
        {SIZES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      {!src && (
        <>
          <ColorPicker title={`Text color (${scope})`} icon={<span className="a-icon">A</span>} value={cell?.color} onPick={(c) => ctl.styleCells({ color: c })} />
          <ColorPicker title={`Cell color (${scope})`} icon={<span className="fill-icon">◆</span>} value={cell?.fill} onPick={(c) => ctl.styleCells({ fill: c })} />
        </>
      )}
      <ColorPicker title="Border color" icon={<span className="fill-icon">▦</span>} value={table.style?.border} onPick={(c) => ctl.styleTable({ border: c })} />
      {!src && (
        <>
          <Btn title={`Align left (${scope})`} active={align === 'left'} onClick={() => ctl.styleCells({ align: undefined })}>
            ≡
          </Btn>
          <Btn title={`Align center (${scope})`} active={align === 'center'} onClick={() => ctl.styleCells({ align: 'center' })}>
            ☰
          </Btn>
          <Btn title={`Align right (${scope})`} active={align === 'right'} onClick={() => ctl.styleCells({ align: 'right' })}>
            ≣
          </Btn>
        </>
      )}
    </>
  );
}

/** A linked chart's link: refresh it, open its spreadsheet, or keep its data and unlink it (it is changed in the spreadsheet). */
function ChartLinkControls({ ctl, el, linked, onOpenSheet }: { ctl: DeckController; el: ChartElement; linked?: LinkedTableSync | null; onOpenSheet?(id: string): void }) {
  const src = el.source!;
  const problem = linked?.problems.get(el.id);
  const items: MenuItem[] = [
    { label: 'Refresh now', action: () => void linked?.retry(el.id) },
    ...(onOpenSheet ? [{ label: 'Open the spreadsheet to change it', action: () => onOpenSheet(src.sheet) }] : []),
    'sep',
    { label: 'Unlink (keep this data)', action: () => ctl.unlinkTable() },
  ];
  const where = `${src.title ? `${src.title} › ` : ''}${src.tab}`;
  return (
    <>
      <span className="tb-sep" />
      <Drop title={problem ? `Linked to a chart on ${where}, which could not be read: ${problem}` : `Linked to a chart on ${where}; it changes when the spreadsheet does`} label={<span className={`tb-linked${problem ? ' problem' : ''}`}>{problem ? '⚠ Linked chart' : 'Linked chart'}</span>} items={items} />
    </>
  );
}

export function DeckToolbar({ ctl, onPresent, onInsertImage, onInsertVideo, onEditImage, onInsertSheetTable, linked, onOpenSheet }: { ctl: DeckController; onPresent(): void; onInsertImage(): void; /** Open the Table from spreadsheet dialog. */ onInsertSheetTable?(): void; /** The page's linked tables, for the state of the selected one. */ linked?: LinkedTableSync | null; onOpenSheet?(id: string): void; /** Open the video dialog; without it the button is not shown. */ onInsertVideo?(): void; /** Open the image editor on a picture element; without it the button is not shown. */ onEditImage?(id: string): void }) {
  const selected = ctl.selected;
  const texts = selected.filter((e): e is TextElement => e.type === 'text');
  const text = texts[0];
  const shapes = selected.filter((e) => e.type === 'shape');
  const line = selected.find((e): e is LineElement => e.type === 'line');
  const table = ctl.table;
  const chartEl = selected.length === 1 && selected[0].type === 'chart' ? selected[0] : null;
  const role = text?.role ?? 'body';
  const bold = text ? (text.style?.bold ?? role === 'title') : false;
  const italic = !!text?.style?.italic;
  const align = text?.style?.align ?? 'left';
  const bullets = !!text && text.paragraphs.some((p) => p.bullet);
  const size = text?.style?.size ?? (text ? { title: 40, subtitle: 22, body: 18, caption: 14 }[role] : 18);

  const themeItems: MenuItem[] = THEME_IDS.map((t: ThemeId) => ({ label: THEMES[t].name, checked: ctl.deck.theme === t, action: () => ctl.setTheme(t) }));

  return (
    <div className="toolbar deck-toolbar" role="toolbar" aria-label="Deck toolbar">
      <LayoutPicker title="New slide" label="+ Slide" theme={ctl.deck.theme} onPick={(l) => ctl.addSlide(l)} />
      <LayoutPicker title="Layout" label="Layout" theme={ctl.deck.theme} current={ctl.slide.layout} onPick={(l) => ctl.setLayout(l)} />
      <Drop title="Theme" label="Theme" items={themeItems} />
      <span className="tb-sep" />
      <Btn title="Text box" onClick={() => ctl.addText('body')}>
        <span className="a-icon">T</span>
      </Btn>
      <Btn title="Image" onClick={onInsertImage}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="9" cy="10" r="1.6" fill="currentColor" />
          <path d="M5 18l5-5 3 3 3-3 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
      </Btn>
      {onInsertVideo && (
        <Btn title="Video" onClick={onInsertVideo}>
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M10 9.2v5.6l5-2.8z" fill="currentColor" />
          </svg>
        </Btn>
      )}
      <TablePicker ctl={ctl} onFromSheet={onInsertSheetTable} />
      <ShapePicker ctl={ctl} />
      <LinePicker ctl={ctl} />
      {/* The controls for a kind of element are there while one is selected, so the bar holds what can be
          used now and stays on one line. */}
      {line && (
        <>
          <span className="tb-sep" />
          <ColorPicker title="Line color" icon={lineIcon('M4 20L20 4')} value={line?.strokeColor} disabled={!line} onPick={(c) => ctl.styleLines({ strokeColor: c })} />
          <select className="tb-select" title="Line weight" aria-label="Line weight" disabled={!line} value={line?.strokeWidth ?? DEFAULT_LINE_WIDTH} onMouseDown={(e) => e.stopPropagation()} onChange={(e) => ctl.styleLines({ strokeWidth: Number(e.target.value) })}>
            {!WEIGHTS.includes(line?.strokeWidth ?? DEFAULT_LINE_WIDTH) && <option value={line?.strokeWidth}>{line?.strokeWidth}</option>}
            {WEIGHTS.map((w) => (
              <option key={w} value={w}>
                {w}px
              </option>
            ))}
          </select>
          <select className="tb-select" title="Line dash" aria-label="Line dash" disabled={!line} value={line?.dash ?? 'solid'} onMouseDown={(e) => e.stopPropagation()} onChange={(e) => ctl.styleLines({ dash: e.target.value === 'solid' ? undefined : (e.target.value as LineElement['dash']) })}>
            {DASH_STYLES.map((d) => (
              <option key={d} value={d}>
                {d === 'solid' ? 'Solid' : d === 'dash' ? 'Dash' : 'Dot'}
              </option>
            ))}
          </select>
          <select className="tb-select" title="Start arrowhead" aria-label="Start arrowhead" disabled={!line} value={line?.startArrow ?? 'none'} onMouseDown={(e) => e.stopPropagation()} onChange={(e) => ctl.styleLines({ startArrow: e.target.value === 'none' ? undefined : (e.target.value as ArrowStyle) })}>
            {ARROW_STYLES.map((a) => (
              <option key={a} value={a}>
                Start: {ARROW_NAMES[a]}
              </option>
            ))}
          </select>
          <select className="tb-select" title="End arrowhead" aria-label="End arrowhead" disabled={!line} value={line?.endArrow ?? 'none'} onMouseDown={(e) => e.stopPropagation()} onChange={(e) => ctl.styleLines({ endArrow: e.target.value === 'none' ? undefined : (e.target.value as ArrowStyle) })}>
            {ARROW_STYLES.map((a) => (
              <option key={a} value={a}>
                End: {ARROW_NAMES[a]}
              </option>
            ))}
          </select>
        </>
      )}
      {table && <TableControls ctl={ctl} linked={linked} onOpenSheet={onOpenSheet} />}
      {chartEl?.source && <ChartLinkControls ctl={ctl} el={chartEl} linked={linked} onOpenSheet={onOpenSheet} />}
      {text && (
        <>
          <span className="tb-sep" />
          <Btn title={`Bold (${MOD}B)`} active={bold} disabled={!text} onClick={() => ctl.styleSelected({ bold: !bold })}>
            <b>B</b>
          </Btn>
          <Btn title={`Italic (${MOD}I)`} active={italic} disabled={!text} onClick={() => ctl.styleSelected({ italic: italic ? undefined : true })}>
            <i>I</i>
          </Btn>
          <select
            className="tb-select"
            title="Font"
            aria-label="Font"
            disabled={!text}
            value={text?.style?.font ?? ''}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => ctl.styleSelected({ font: e.target.value || undefined })}
          >
            <option value="">Theme font</option>
            {text?.style?.font && !FONTS.includes(text.style.font) && <option value={text.style.font}>{text.style.font}</option>}
            {FONTS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <select
            className="tb-select"
            title="Font size"
            aria-label="Font size"
            disabled={!text}
            value={SIZES.includes(size) ? size : ''}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => ctl.styleSelected({ size: Number(e.target.value) })}
          >
            {!SIZES.includes(size) && <option value="">{size}</option>}
            {SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <ColorPicker title="Text color" icon={<span className="a-icon">A</span>} value={text?.style?.color} disabled={!text} onPick={(c) => ctl.styleSelected({ color: c })} />
          <span className="tb-sep" />
          <Btn title="Align left" active={align === 'left'} disabled={!text} onClick={() => ctl.styleSelected({ align: undefined })}>
            ≡
          </Btn>
          <Btn title="Align center" active={align === 'center'} disabled={!text} onClick={() => ctl.styleSelected({ align: 'center' })}>
            ☰
          </Btn>
          <Btn title="Align right" active={align === 'right'} disabled={!text} onClick={() => ctl.styleSelected({ align: 'right' })}>
            ≣
          </Btn>
          <Btn title="Bulleted list" active={bullets} disabled={!text} onClick={() => ctl.toggleBullets()}>
            •≡
          </Btn>
        </>
      )}
      <span className="tb-sep" />
      {shapes.length > 0 && (
        <ColorPicker
          title="Fill color"
          icon={<span className="fill-icon">◆</span>}
          value={shapes[0]?.type === 'shape' ? shapes[0].fill : undefined}
          disabled={!shapes.length}
          onPick={(c) =>
            ctl.updateElements(
              shapes.map((s) => s.id),
              (e) => {
                if (e.type !== 'shape') return e;
                const next = { ...e };
                if (c) next.fill = c;
                else delete next.fill;
                return next;
              },
            )
          }
        />
      )}
      <ColorPicker title="Slide background" icon={<span className="fill-icon">▭</span>} value={ctl.slide.bg} onPick={(c) => ctl.setBackground(c)} />
      {selected.length > 0 && (
        <>
          <span className="tb-sep" />
          <Btn title="Bring forward" onClick={() => ctl.reorder(ctl.selection, 'forward')}>
            ▲
          </Btn>
          <Btn title="Send backward" onClick={() => ctl.reorder(ctl.selection, 'backward')}>
            ▼
          </Btn>
        </>
      )}
      {selected.length === 1 && selected[0].type === 'image' && (
        <>
          <span className="tb-sep" />
          <button className={`btn${ctl.cropping ? ' active' : ''}`} disabled={!!ctl.cropping} onMouseDown={(e) => e.preventDefault()} onClick={() => ctl.startCropping(selected[0].id)} title="Cut the picture's sides: drag the frame's handles, then press Enter">
            Crop
          </button>
        </>
      )}
      {onEditImage && selected.length === 1 && selected[0].type === 'image' && !ctl.cropping && (
        <>
          <button className="btn" onMouseDown={(e) => e.preventDefault()} onClick={() => onEditImage(selected[0].id)} title="Crop, rotate, adjust and draw on the picture (or double-click it)">
            Edit image
          </button>
        </>
      )}
      <span className="tb-grow" />
      <button className="btn primary present-btn" onClick={onPresent} title="Present from the current slide">
        ▶ Present
      </button>
    </div>
  );
}
