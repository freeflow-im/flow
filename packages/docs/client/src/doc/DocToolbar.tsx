// Formatting toolbar for the document editor: block style, text styles, colors, links, alignment, lists,
// indentation, images and rules. Buttons keep the editor focused (mousedown is prevented) so the selection
// they act on stays put.
import { useEffect, useState, type ReactNode } from 'react';
import { blockSizePt, FONT_FAMILIES, FONT_SIZES, fontFamilyCss, type BlockType } from '../../../shared/doc.ts';
import { MOD } from '../commands.ts';
import { ColorPicker } from '../components/ColorPicker.tsx';
import { MenuList, type MenuItem } from '../components/Menu.tsx';
import { ensureFonts } from '../deck/fonts.ts';
import type { DocController } from './controller.ts';

const BLOCK_OPTIONS: { value: BlockType; label: string }[] = [
  { value: 'paragraph', label: 'Normal text' },
  { value: 'title', label: 'Title' },
  { value: 'subtitle', label: 'Subtitle' },
  { value: 'heading1', label: 'Heading 1' },
  { value: 'heading2', label: 'Heading 2' },
  { value: 'heading3', label: 'Heading 3' },
  { value: 'blockquote', label: 'Quote' },
  { value: 'code_block', label: 'Code block' },
];

function Btn({ title, active, onClick, children, disabled }: { title: string; active?: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button className={`tb-btn${active ? ' active' : ''}`} title={title} aria-label={title} aria-pressed={active} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {children}
    </button>
  );
}

const icon = (d: string) => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Font families in alphabetical order, each shown in its own face. */
const SORTED_FONTS = [...FONT_FAMILIES].sort((a, b) => a.localeCompare(b));

function FontPicker({ ctl, font, defaultFont, disabled }: { ctl: DocController; font: string; defaultFont: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    ensureFonts(SORTED_FONTS); // so the menu can draw each name in its font
    const close = () => setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const items: MenuItem[] = [
    { label: `Default (${defaultFont})`, checked: !font, action: () => ctl.setMark('font', null) },
    'sep',
    ...(font && !(FONT_FAMILIES as readonly string[]).includes(font) ? [{ label: <span style={{ fontFamily: fontFamilyCss(font) }}>{font}</span>, checked: true, action: () => {} }] : []),
    ...SORTED_FONTS.map((f) => ({ label: <span style={{ fontFamily: fontFamilyCss(f) }}>{f}</span>, checked: font === f, action: () => ctl.setMark('font', { family: f }) })),
  ];
  return (
    <div className="tb-drop doc-font-drop" onMouseDown={(e) => e.stopPropagation()}>
      <Btn title="Font" active={open} disabled={disabled} onClick={() => setOpen(!open)}>
        <span className="doc-font-label" style={font ? { fontFamily: fontFamilyCss(font) } : undefined}>
          {font || defaultFont}
        </span>
        <span className="tb-caret">▾</span>
      </Btn>
      {open && <MenuList items={items} onDone={() => setOpen(false)} style={{ top: 32, left: 0 }} />}
    </div>
  );
}

export const ICONS = {
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-2',
  redo: 'm15 14 5-5-5-5M20 9H9a5 5 0 0 0 0 10h2',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  alignLeft: 'M4 6h16M4 10h10M4 14h16M4 18h10',
  alignCenter: 'M4 6h16M7 10h10M4 14h16M7 18h10',
  alignRight: 'M4 6h16M10 10h10M4 14h16M10 18h10',
  justify: 'M4 6h16M4 10h16M4 14h16M4 18h16',
  bullets: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  numbers: 'M10 6h10M10 12h10M10 18h10M4 5.5h1.5V9M3.8 13.5a1.3 1.3 0 0 1 2.4.6c0 1-2.4 2-2.4 2.9h2.6',
  outdent: 'M4 6h16M10 10h10M10 14h10M4 18h16M7 9l-3 3 3 3',
  indent: 'M4 6h16M10 10h10M10 14h10M4 18h16M4 9l3 3-3 3',
  image: 'M4 5h16v14H4zM8 10a1.2 1.2 0 1 0 0-.1M5 18l5-5 3 3 3-3 4 4',
  video: 'M4 5h16v14H4zM10 9.2v5.6l5-2.8z',
  rule: 'M4 12h16',
  clear: 'M6 4h9l3 3-9 9H6zM4 20h16M9 16l-3-3',
};

export function DocToolbar({ ctl, onLink, onInsertImage, onInsertVideo, onEditImage, sign }: { ctl: DocController; onLink(): void; onInsertImage(): void; /** Open the video dialog; without it the button is not shown. */ onInsertVideo?(): void; /** Open the image editor on the selected picture; without it the button is not shown. */ onEditImage?(): void; /** The Sign menu (components/SignMenu.tsx), where the page has the user's signatures. */ sign?: ReactNode }) {
  const block = ctl.currentBlock();
  const inList = block === 'bullet_list' || block === 'ordered_list';
  const isNode = block === 'image' || block === 'video' || block === 'horizontal_rule';
  const align = ctl.currentAlign();
  const color = ctl.markAt('color')?.attrs.color as string | undefined;
  const highlight = ctl.markAt('highlight')?.attrs.color as string | undefined;
  const font = (ctl.markAt('font')?.attrs.family as string | undefined) ?? '';
  const blockValue = BLOCK_OPTIONS.some((o) => o.value === block) ? block : 'paragraph';
  // With no size mark, the text is drawn at its block style's size; show that so the box always says what the cursor is in.
  const docStyle = ctl.docStyle();
  const size = (ctl.markAt('size')?.attrs.size as number | undefined) ?? blockSizePt(isNode ? 'paragraph' : (block as BlockType), docStyle);

  return (
    <div className="toolbar doc-toolbar" role="toolbar" aria-label="Document toolbar">
      <Btn title={`Undo (${MOD}Z)`} disabled={!ctl.store.canUndo()} onClick={() => ctl.undo()}>
        {icon(ICONS.undo)}
      </Btn>
      <Btn title={`Redo (${MOD}Y)`} disabled={!ctl.store.canRedo()} onClick={() => ctl.redo()}>
        {icon(ICONS.redo)}
      </Btn>
      <span className="tb-sep" />
      <select
        className="tb-select doc-block-select"
        title="Text style"
        aria-label="Text style"
        disabled={isNode}
        value={blockValue}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => ctl.setBlockType(e.target.value as BlockType)}
      >
        {BLOCK_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <FontPicker ctl={ctl} font={font} defaultFont={docStyle.font} disabled={isNode} />
      <select
        className="tb-select doc-size-select"
        title="Font size (points)"
        aria-label="Font size"
        disabled={isNode}
        value={size}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => ctl.setMark('size', { size: Number(e.target.value) })}
      >
        {!(FONT_SIZES as readonly number[]).includes(size) && <option value={size}>{size}</option>}
        {FONT_SIZES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <span className="tb-sep" />
      <Btn title={`Bold (${MOD}B)`} active={ctl.isMarkActive('bold')} disabled={isNode} onClick={() => ctl.toggleMark('bold')}>
        <b>B</b>
      </Btn>
      <Btn title={`Italic (${MOD}I)`} active={ctl.isMarkActive('italic')} disabled={isNode} onClick={() => ctl.toggleMark('italic')}>
        <i>I</i>
      </Btn>
      <Btn title={`Underline (${MOD}U)`} active={ctl.isMarkActive('underline')} disabled={isNode} onClick={() => ctl.toggleMark('underline')}>
        <u>U</u>
      </Btn>
      <Btn title={`Strikethrough (${MOD}⇧X)`} active={ctl.isMarkActive('strike')} disabled={isNode} onClick={() => ctl.toggleMark('strike')}>
        <s>S</s>
      </Btn>
      <Btn title={`Code (${MOD}E)`} active={ctl.isMarkActive('code')} disabled={isNode} onClick={() => ctl.toggleMark('code')}>
        <code>&lt;&gt;</code>
      </Btn>
      <ColorPicker title="Text color" icon={<span className="a-icon">A</span>} value={color} disabled={isNode} resetLabel="Default" onPick={(c) => ctl.setMark('color', c ? { color: c } : null)} />
      <ColorPicker title="Highlight color" icon={<span className="fill-icon">▰</span>} value={highlight} disabled={isNode} resetLabel="None" onPick={(c) => ctl.setMark('highlight', c ? { color: c } : null)} />
      <Btn title={`Link (${MOD}K)`} active={!!ctl.linkAtCursor()} disabled={isNode} onClick={onLink}>
        {icon(ICONS.link)}
      </Btn>
      <span className="tb-sep" />
      <Btn title={`Align left (${MOD}⇧L)`} active={align === 'left'} onClick={() => ctl.setAlign('left')}>
        {icon(ICONS.alignLeft)}
      </Btn>
      <Btn title={`Align center (${MOD}⇧E)`} active={align === 'center'} onClick={() => ctl.setAlign('center')}>
        {icon(ICONS.alignCenter)}
      </Btn>
      <Btn title={`Align right (${MOD}⇧R)`} active={align === 'right'} onClick={() => ctl.setAlign('right')}>
        {icon(ICONS.alignRight)}
      </Btn>
      <Btn title={`Justify (${MOD}⇧J)`} active={align === 'justify'} disabled={isNode} onClick={() => ctl.setAlign('justify')}>
        {icon(ICONS.justify)}
      </Btn>
      <span className="tb-sep" />
      <Btn title={`Bulleted list (${MOD}⇧8)`} active={block === 'bullet_list'} disabled={isNode} onClick={() => ctl.setBlockType('bullet_list')}>
        {icon(ICONS.bullets)}
      </Btn>
      <Btn title={`Numbered list (${MOD}⇧7)`} active={block === 'ordered_list'} disabled={isNode} onClick={() => ctl.setBlockType('ordered_list')}>
        {icon(ICONS.numbers)}
      </Btn>
      <Btn title="Decrease indent (Shift+Tab)" disabled={!inList} onClick={() => ctl.outdent()}>
        {icon(ICONS.outdent)}
      </Btn>
      <Btn title="Increase indent (Tab)" disabled={!inList} onClick={() => ctl.indent()}>
        {icon(ICONS.indent)}
      </Btn>
      <span className="tb-sep" />
      <Btn title="Insert image" onClick={onInsertImage}>
        {icon(ICONS.image)}
      </Btn>
      {onInsertVideo && (
        <Btn title="Insert video" onClick={onInsertVideo}>
          {icon(ICONS.video)}
        </Btn>
      )}
      {sign}
      {onEditImage && block === 'image' && (
        <button className="btn" onMouseDown={(e) => e.preventDefault()} onClick={onEditImage} title="Crop, rotate, adjust and draw on the picture (or double-click it)">
          Edit image
        </button>
      )}
      <Btn title="Insert horizontal rule" onClick={() => ctl.insertHorizontalRule()}>
        {icon(ICONS.rule)}
      </Btn>
      <span className="tb-sep" />
      <Btn title="Clear formatting" disabled={isNode} onClick={() => ctl.clearFormatting()}>
        {icon(ICONS.clear)}
      </Btn>
      <span className="tb-grow" />
    </div>
  );
}
