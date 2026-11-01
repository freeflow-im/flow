// Export a deck as a PowerPoint file with pptxgenjs. Our slide is 960×540 points at 96 per inch, which is
// exactly PowerPoint's 16:9 layout (10 × 5.625 inches), so positions map 1:1. Runs in the browser (File →
// Download as PowerPoint) and in Node (tests); the caller loads images, since that differs between the two.
import { youtubeId } from './video.ts';
import type PptxGenJS from 'pptxgenjs';
import { fillColor, ROLE_SIZE, THEMES, type ArrowStyle, type ChartElement, type Deck, type SlideElement, type TextElement, type TextRun } from './deck.ts';

/** PowerPoint's arrowhead types for ours (its "arrow" is the open one, "stealth" the barbed filled one). */
const PPTX_ARROW: Record<Exclude<ArrowStyle, 'none'>, 'arrow' | 'diamond' | 'oval' | 'stealth' | 'triangle'> = { arrow: 'stealth', open: 'arrow', triangle: 'triangle', circle: 'oval', diamond: 'diamond' };
import { arcGeometry, SHAPES } from './shapes.ts';
import { cellLook, colShares, mixColor, TABLE_PAD, TABLE_SIZE, tableColors } from './deckTable.ts';
import { CHART_COLORS } from './chart.ts';

/** Returns a data URL for an image address, or null if it cannot be loaded. */
export type ImageLoader = (src: string) => Promise<string | null>;

const PX_PER_INCH = 96;
const inch = (px: number) => Math.round((px / PX_PER_INCH) * 10000) / 10000;
/** Font sizes are in CSS pixels on the slide; PowerPoint wants points. */
const pt = (px: number) => Math.round(px * 0.75 * 10) / 10;

/** A 6-digit hex color without '#' (from #rgb, #rrggbb, rgb() or rgba()), or undefined for anything else. */
export function hexColor(c: string | undefined): string | undefined {
  if (!c) return undefined;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (m) {
    const h = m[1];
    return (h.length === 3 ? h.split('').map((x) => x + x).join('') : h).toUpperCase();
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(c.trim());
  if (!rgb) return undefined;
  return rgb
    .slice(1, 4)
    .map((v) => Math.max(0, Math.min(255, Number(v))).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/** Transparency in percent for an rgba() color (0 for opaque colors). */
export function transparencyOf(c: string | undefined): number {
  const m = c && /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)$/i.exec(c.trim());
  if (!m) return 0;
  return Math.round((1 - Math.max(0, Math.min(1, Number(m[1])))) * 100);
}

/** A font PowerPoint is likely to have, from a CSS font stack. */
export function fontFace(stack: string): string {
  const first = stack.split(',')[0].replace(/['"]/g, '').trim();
  if (/georgia|times|serif/i.test(first)) return 'Georgia';
  if (/mono|courier/i.test(first)) return 'Courier New';
  return 'Arial';
}

function textOptions(el: TextElement, theme: (typeof THEMES)[keyof typeof THEMES]): PptxGenJS.TextPropsOptions {
  const role = el.role ?? 'body';
  const s = el.style ?? {};
  const heading = role === 'title' || role === 'subtitle';
  const color = hexColor(s.color) ?? hexColor(role === 'title' ? theme.heading : role === 'caption' || role === 'subtitle' ? theme.muted : theme.text);
  const size = s.size ?? ROLE_SIZE[role];
  return {
    x: inch(el.x),
    y: inch(el.y),
    w: inch(el.w),
    h: inch(el.h),
    fontSize: pt(size),
    fontFace: s.font ?? fontFace(heading ? theme.headingFont : theme.bodyFont),
    bold: s.bold ?? role === 'title',
    italic: !!s.italic,
    ...(color ? { color } : {}),
    align: s.align ?? 'left',
    valign: s.valign ?? 'top',
    margin: 0,
    paraSpaceAfter: pt(s.paraSpacing ?? size * 0.3),
    // PowerPoint's single spacing is about 1.2 × the font size; ours defaults to 1.25.
    lineSpacingMultiple: Math.round(((s.lineHeight ?? 1.25) / 1.2) * 100) / 100,
    fit: 'none',
  };
}

/** A shape's name in the file for an element of ours: its id, marked as ours (SHAPE_ID_RE reads it back). */
export const shapeName = (id: string): string => `ff-${id}`;
/** An element id kept in a shape's name by shapeName. */
export const SHAPE_ID_RE = /^ff-([\w.-]{1,80})$/;

/** The uri of the extension that keeps a linked table's spreadsheet range (TableElement.source) in the file. */
export const TABLE_SOURCE_EXT = 'urn:universal-docs:table-source';
/** The same for the spreadsheet chart a slide's chart shows (ChartElement.source). */
export const CHART_SOURCE_EXT = 'urn:universal-docs:chart-source';

/**
 * The presentation as the bytes of a .pptx file, with warnings. What pptxgenjs cannot write about a table goes
 * into its frame afterwards: the header-row and banded-rows flags (it always writes an empty a:tblPr), and the
 * spreadsheet range of a linked table, as an extension PowerPoint passes over, so reading the file back keeps them.
 */
export async function writePptx(deck: Deck, title: string, loadImage: ImageLoader): Promise<{ data: Uint8Array; warnings: string[] }> {
  const { pres, warnings } = await buildPptx(deck, title, loadImage);
  const data = (await pres.write({ outputType: 'uint8array' })) as Uint8Array;
  const extras = new Map<string, { flags: string; ext: string }>();
  const chartLinks = new Map<string, string>();
  for (const slide of deck.slides) {
    for (const el of slide.elements) {
      if (el.type === 'chart' && el.source) chartLinks.set(el.id, `<p:extLst><p:ext uri="${CHART_SOURCE_EXT}"><ud:chartSource xmlns:ud="urn:universal-docs" data="${encodeURIComponent(JSON.stringify(el.source))}"/></p:ext></p:extLst>`);
      if (el.type !== 'table' || !(el.header || el.banded || el.source)) continue;
      extras.set(el.id, {
        flags: `${el.header ? ' firstRow="1"' : ''}${el.banded ? ' bandRow="1"' : ''}`,
        // encodeURIComponent leaves only characters that need no escaping in an XML attribute.
        ext: el.source ? `<p:ext uri="${TABLE_SOURCE_EXT}"><ud:tableSource xmlns:ud="urn:universal-docs" data="${encodeURIComponent(JSON.stringify(el.source))}"/></p:ext>` : '',
      });
    }
  }
  if (!extras.size && !chartLinks.size) return { data, warnings };
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(data);
  // A table's frame is named for its element (shapeName); its a:tblPr follows before any other shape's cNvPr.
  const frame = /(<p:cNvPr id="\d+" name="ff-([\w.-]{1,80})"\/>(?:(?!<p:cNvPr )[\s\S])*?)<a:tblPr\/>/g;
  for (const name of Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) {
    const xml = await zip.file(name)!.async('string');
    // A chart's frame: its name, then its (empty) non-visual properties, where the link goes.
    const chartFrame = /(<p:cNvPr id="\d+" name="ff-([\w.-]{1,80})" descr="[^"]*"\/>\s*<p:cNvGraphicFramePr\/>\s*<p:nvPr>)(\s*)<\/p:nvPr>/g;
    const next = xml.replace(chartFrame, (all, head: string, id: string) => (chartLinks.has(id) ? `${head}${chartLinks.get(id)}</p:nvPr>` : all)).replace(frame, (all, head: string, id: string) => {
      const extra = extras.get(id);
      if (!extra) return all;
      const withExt = !extra.ext ? head : head.includes('</p:extLst></p:nvPr>') ? head.replace('</p:extLst></p:nvPr>', `${extra.ext}</p:extLst></p:nvPr>`) : head.replace('<p:nvPr/>', `<p:nvPr><p:extLst>${extra.ext}</p:extLst></p:nvPr>`);
      return `${withExt}<a:tblPr${extra.flags}/>`;
    });
    if (next !== xml) zip.file(name, next);
  }
  return { data: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), warnings };
}

/** Build the presentation. Returns the pptxgenjs instance and warnings; writePptx makes the file. */
export async function buildPptx(deck: Deck, title: string, loadImage: ImageLoader): Promise<{ pres: PptxGenJS; warnings: string[] }> {
  const { default: PptxGen } = await import('pptxgenjs');
  const pres = new PptxGen();
  pres.layout = 'LAYOUT_16x9';
  pres.title = title;
  const theme = THEMES[deck.theme];
  const warnings: string[] = [];
  let missingImages = 0;
  let storedVideos = 0;

  for (const slide of deck.slides) {
    const s = pres.addSlide();
    const bg = hexColor(fillColor(slide.bg)) ?? hexColor(theme.bg);
    if (bg) s.background = { color: bg };
    for (const el of slide.elements) await addElement(s, el, slide.bg);
    if (slide.notes) s.addNotes(slide.notes);
  }
  if (missingImages) warnings.push(`${missingImages} image${missingImages === 1 ? '' : 's'} could not be loaded and ${missingImages === 1 ? 'was' : 'were'} left as a placeholder.`);
  if (storedVideos) warnings.push(`${storedVideos} video${storedVideos === 1 ? ' is' : 's are'} not in the file: a video from your files stays in MCP Docs, and its place is marked on the slide.`);
  return { pres, warnings };

  /**
   * A chart as a PowerPoint chart (its data goes into the file with it, so it can be edited there), in the
   * deck's colors. A chart with nothing to show is left out.
   */
  function addChart(s: PptxGenJS.Slide, el: ChartElement, box: { x: number; y: number; w: number; h: number; objectName: string }): void {
    const { chart, data } = el;
    if (!data.series.length) return;
    const textColor = hexColor(theme.text) ?? '1F1F1F';
    const muted = hexColor(theme.muted) ?? '5F6368';
    const labels = data.categories;
    const values = (p: { y: number | null }) => p.y as number;
    const series =
      chart.type === 'scatter'
        ? [{ name: 'X', values: (data.series[0]?.points ?? []).map((p) => p.x ?? null) as number[] }, ...data.series.map((sr) => ({ name: sr.name, values: sr.points.map(values) }))]
        : data.series.map((sr) => ({ name: sr.name, labels, values: sr.points.map(values) }));
    const type = ({ column: 'bar', bar: 'bar', line: 'line', area: 'area', pie: 'pie', scatter: 'scatter' } as const)[chart.type] as PptxGenJS.CHART_NAME;
    const legend = chart.legend ?? (data.series.length > 1 || chart.type === 'pie' ? 'right' : 'none');
    const colors = chart.type === 'pie' ? labels.map((_, i) => (i === 0 ? data.series[0].color : CHART_COLORS[i % CHART_COLORS.length])) : data.series.map((sr) => sr.color);
    s.addChart(type, series, {
      ...box,
      chartColors: colors.map((c) => hexColor(c) ?? '4285F4'),
      showLegend: legend !== 'none',
      ...(legend !== 'none' ? { legendPos: legend === 'bottom' ? 'b' : legend === 'top' ? 't' : 'r' } : {}),
      legendColor: textColor,
      legendFontFace: fontFace(theme.bodyFont),
      ...(chart.title ? { showTitle: true, title: chart.title, titleColor: textColor, titleFontSize: 15, titleFontFace: fontFace(theme.bodyFont) } : { showTitle: false }),
      ...(chart.type === 'column' || chart.type === 'bar' ? { barDir: chart.type === 'bar' ? 'bar' : 'col', barGrouping: chart.stacked ? 'stacked' : 'clustered', barGapWidthPct: 80 } : {}),
      ...(chart.type === 'area' && chart.stacked ? { barGrouping: 'stacked' } : {}),
      ...(chart.type === 'line' ? { lineDataSymbol: 'circle', lineDataSymbolSize: 5, lineSize: 2 } : {}),
      ...(chart.type === 'scatter' ? { lineSize: 0, lineDataSymbol: 'circle', lineDataSymbolSize: 6 } : {}),
      ...(chart.logScale && chart.type !== 'pie' ? { valAxisLogScaleBase: 10 } : {}),
      ...(chart.xTitle && chart.type !== 'pie' ? { showCatAxisTitle: true, catAxisTitle: chart.xTitle, catAxisTitleColor: textColor } : {}),
      ...(chart.yTitle && chart.type !== 'pie' ? { showValAxisTitle: true, valAxisTitle: chart.yTitle, valAxisTitleColor: textColor } : {}),
      catAxisLabelColor: muted,
      valAxisLabelColor: muted,
      catAxisLabelFontFace: fontFace(theme.bodyFont),
      valAxisLabelFontFace: fontFace(theme.bodyFont),
      catAxisLabelFontSize: 9,
      valAxisLabelFontSize: 9,
      valGridLine: { color: hexColor(mixColor(theme.muted, theme.bg, 0.3)) ?? 'E0E0E0', size: 0.75 },
      ...(chart.type === 'pie' ? { showPercent: true, dataLabelColor: 'FFFFFF' } : {}),
    });
  }

  async function addElement(s: PptxGenJS.Slide, el: SlideElement, slideBg: string | undefined): Promise<void> {
    // The element's id is the shape's name, so reading the file back keeps it (server/pptxImport.ts).
    const box = { x: inch(el.x), y: inch(el.y), w: inch(el.w), h: inch(el.h), ...(el.rot ? { rotate: ((el.rot % 360) + 360) % 360 } : {}), objectName: shapeName(el.id) };
    if (el.type === 'text') {
      const runs: PptxGenJS.TextProps[] = el.paragraphs.flatMap((p) => {
        const para: PptxGenJS.TextPropsOptions = {
          ...(p.bullet ? { bullet: { indent: 18 }, indentLevel: p.level ?? 0 } : {}),
          ...(p.size !== undefined ? { fontSize: pt(p.size) } : {}),
          ...(p.bold !== undefined ? { bold: p.bold } : {}),
          ...(p.italic !== undefined ? { italic: p.italic } : {}),
          ...(hexColor(p.color) ? { color: hexColor(p.color) } : {}),
          ...(p.font ? { fontFace: p.font } : {}),
        };
        const pieces = p.runs?.length ? p.runs : [{ text: p.text }];
        // The paragraph's own options go on every run: pptxgenjs reads them from the run that starts a paragraph.
        return pieces.map((r: TextRun, i) => ({
          text: r.text,
          options: {
            ...para,
            breakLine: i === pieces.length - 1,
            ...(r.bold !== undefined ? { bold: r.bold } : {}),
            ...(r.italic !== undefined ? { italic: r.italic } : {}),
            ...(r.underline ? { underline: { style: 'sng' as const } } : {}),
            ...(hexColor(r.color) ? { color: hexColor(r.color) } : {}),
            ...(r.link ? { hyperlink: { url: r.link } } : {}),
          },
        }));
      });
      s.addText(runs.length ? runs : [{ text: '' }], { ...textOptions(el, theme), ...(el.rot ? { rotate: box.rotate } : {}), objectName: box.objectName });
      return;
    }
    if (el.type === 'image') {
      const data = await loadImage(el.src);
      if (data) {
        s.addImage({ data, ...box, sizing: { type: el.fit === 'cover' ? 'cover' : 'contain', w: box.w, h: box.h } });
      } else {
        missingImages++;
        s.addText('Image unavailable', { ...box, shape: pres.ShapeType.rect, line: { color: '9AA0A6', width: 1 }, fill: { type: 'none' }, align: 'center', valign: 'middle', fontSize: 12, color: '9AA0A6' });
      }
      return;
    }
    if (el.type === 'video') {
      // A YouTube video plays in PowerPoint too; a stored file is not copied into the presentation.
      const yt = youtubeId(el.src);
      if (yt) s.addMedia({ type: 'online', link: `https://www.youtube.com/embed/${yt}`, x: box.x, y: box.y, w: box.w, h: box.h, objectName: box.objectName });
      else {
        storedVideos++;
        s.addText('Video', { ...box, shape: pres.ShapeType.rect, line: { color: '9AA0A6', width: 1 }, fill: { color: '202124' }, align: 'center', valign: 'middle', fontSize: 14, color: 'FFFFFF' });
      }
      return;
    }
    if (el.type === 'chart') {
      addChart(s, el, box);
      return;
    }
    if (el.type === 'table') {
      // A PowerPoint table with each cell's look written out (it does not use PowerPoint's table styles), its
      // rows sharing the box's height and its columns the box's width as on the slide.
      const colors = tableColors(el, theme, slideBg);
      const border: PptxGenJS.BorderProps = colors.border === 'none' || !hexColor(colors.border) ? { type: 'none' } : { type: 'solid', color: hexColor(colors.border), pt: 0.75 };
      const rows: PptxGenJS.TableRow[] = el.rows.map((row, r) =>
        row.map((cell, c) => {
          const look = cellLook(el, r, c, colors);
          const fill = hexColor(look.fill);
          return {
            text: cell.text,
            options: {
              bold: look.bold,
              italic: look.italic,
              ...(hexColor(look.color) ? { color: hexColor(look.color) } : {}),
              align: look.align,
              valign: 'middle',
              ...(fill ? { fill: { color: fill, transparency: transparencyOf(look.fill) } } : {}),
            },
          };
        }),
      );
      s.addTable(rows, {
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        colW: colShares(el).map((share) => inch(share * el.w)),
        rowH: el.rows.map(() => inch(el.h / el.rows.length)),
        fontSize: pt(el.style?.size ?? TABLE_SIZE),
        fontFace: el.style?.font ?? fontFace(theme.bodyFont),
        border,
        // Points are 1/72 inch; pptxgenjs takes table cell margins in points.
        margin: [pt(TABLE_PAD.y), pt(TABLE_PAD.x), pt(TABLE_PAD.y), pt(TABLE_PAD.x)],
        objectName: box.objectName,
      });
      return;
    }
    const accent = hexColor(theme.accent) ?? '1A73E8';
    if (el.type === 'line') {
      // Lines, elbow connectors (bentConnector3) and curved connectors (curvedConnector3), flipped to run any direction.
      // Connections are not written: pptxgenjs has no way to name the shape ids a connector would attach to.
      const prst = el.kind === 'elbow' ? 'bentConnector3' : el.kind === 'curved' ? 'curvedConnector3' : 'line';
      const arrow = (a: ArrowStyle | undefined): PptxGenJS.ShapeLineProps['beginArrowType'] => (a && a !== 'none' ? PPTX_ARROW[a] : undefined);
      const begin = arrow(el.startArrow);
      const end = arrow(el.endArrow);
      s.addShape(prst as PptxGenJS.SHAPE_NAME, {
        ...box,
        ...(el.flipH ? { flipH: true } : {}),
        ...(el.flipV ? { flipV: true } : {}),
        line: {
          color: hexColor(el.strokeColor) ?? accent,
          width: pt(el.strokeWidth ?? 3),
          transparency: transparencyOf(el.strokeColor),
          ...(el.dash === 'dash' ? { dashType: 'dash' as const } : el.dash === 'dot' ? { dashType: 'sysDot' as const } : {}),
          ...(begin ? { beginArrowType: begin } : {}),
          ...(end ? { endArrowType: end } : {}),
        },
      });
      return;
    }
    // Shapes
    const strokeColor = hexColor(el.stroke);
    if (el.shape === 'line') {
      const diagonal = el.w > 0 && el.h > 0;
      const vertical = el.h > el.w;
      const lineColor = el.stroke ?? el.fill;
      s.addShape(pres.ShapeType.line, {
        ...box,
        ...(diagonal ? {} : vertical ? { w: 0 } : { h: 0 }),
        ...(diagonal && el.flip ? { flipV: true } : {}),
        line: {
          color: hexColor(lineColor) ?? accent,
          width: pt(el.strokeWidth ?? 3),
          transparency: transparencyOf(lineColor),
          ...(el.arrow === 'start' || el.arrow === 'both' ? { beginArrowType: 'triangle' } : {}),
          ...(el.arrow === 'end' || el.arrow === 'both' ? { endArrowType: 'triangle' } : {}),
        },
      });
      return;
    }
    // A gradient is written as its first color; a freeform as the rectangle around it.
    const flat = fillColor(el.fill);
    const fill: PptxGenJS.ShapeFillProps = el.fill === 'none' ? { type: 'none' } : { color: hexColor(flat) ?? accent, transparency: transparencyOf(flat) };
    const sw = el.strokeWidth ?? (strokeColor ? 2 : 0);
    const line: PptxGenJS.ShapeLineProps = strokeColor && sw ? { color: strokeColor, width: pt(sw), transparency: transparencyOf(el.stroke) } : { type: 'none' };
    const shapeType = (pres.ShapeType as unknown as Record<string, PptxGenJS.SHAPE_NAME>)[SHAPES[el.shape].pptx] ?? pres.ShapeType.rect;
    // PowerPoint's arc box is the whole ellipse; ours is the tight box around the stroke.
    const g = el.shape === 'arc' ? arcGeometry(el, sw) : undefined;
    const common = {
      ...(g ? { x: inch(g.cx - g.rx), y: inch(g.cy - g.ry), w: inch(2 * g.rx), h: inch(2 * g.ry), objectName: box.objectName } : box),
      fill,
      line,
      ...(el.shape === 'rounded' ? { rectRadius: inch(16) } : {}),
      ...(el.shape === 'arc' ? { angleRange: [el.startAngle ?? 270, el.endAngle ?? 0] as [number, number] } : {}),
    };
    if (el.text) {
      const color = hexColor(el.textColor) ?? (el.fill === 'none' ? hexColor(theme.text) : 'FFFFFF');
      s.addText(el.text, { ...common, shape: shapeType, align: 'center', valign: 'middle', fontSize: pt(el.textSize ?? 18), fontFace: el.textFont ?? fontFace(theme.bodyFont), ...(el.textBold ? { bold: true } : {}), ...(el.textItalic ? { italic: true } : {}), ...(color ? { color } : {}) });
    } else {
      s.addShape(shapeType, common);
    }
  }
}
