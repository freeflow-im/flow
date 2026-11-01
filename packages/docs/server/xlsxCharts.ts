// Charts in Excel files, which ExcelJS neither reads nor writes. Writing: after ExcelJS has written the workbook,
// each tab's charts (shared/chart.ts) go in as DrawingML chart parts, with a drawing that anchors them to their
// cell, the relationships between the parts and their content types, and a cache of the values so a reader
// that does not calculate (a previewer, Quick Look) still draws them. Reading: the charts of an .xlsx become
// tab charts when they are of a kind ours can be (column, bar, line, area, pie, scatter, with their 3-D and
// doughnut cousins drawn flat), and the others are counted so the import can say they would be lost.
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { CHART_COLORS, chartData, resolveRef, type Chart, type ChartData, type ChartSeries, type ChartType, type LegendPosition } from '../shared/chart.ts';
import { colToName } from '../shared/cellref.ts';
import type { Engine } from '../shared/formula/engine.ts';
import { renameSheetRefs } from '../shared/formula/adjust.ts';
import type { NumberFormat, Tab, Workbook } from '../shared/types.ts';

const EMU_PER_PX = 9525;
const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
/**
 * A chart's own id, kept in its drawing object (an extension, as Office keeps its creation ids there), so that
 * reading the file again gives the chart the same id and a slide linked to it (ChartSource) still finds it.
 */
export const CHART_ID_EXT = 'urn:universal-docs:chart-id';
const REL_CHART = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart';
const REL_DRAWING = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing';
const CT_CHART = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const CT_DRAWING = 'application/vnd.openxmlformats-officedocument.drawing+xml';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A sheet name as Excel references write it: quoted when it is not a plain word. */
const sheetRef = (name: string) => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);

/** A chart reference of ours as an absolute Excel reference ('Sheet 1'!$A$2:$A$9), with the exported tab names. */
function excelRef(wb: Workbook, own: Tab, ref: string, names: Map<string, string>): string | null {
  const at = resolveRef(wb, own, ref);
  if (typeof at === 'string') return null;
  const { r1, c1, r2, c2 } = at.range;
  const cell = (r: number, c: number) => `$${colToName(c)}$${r + 1}`;
  const area = r1 === r2 && c1 === c2 ? cell(r1, c1) : `${cell(r1, c1)}:${cell(r2, c2)}`;
  return `${sheetRef(names.get(at.tab.id) ?? at.tab.name)}!${area}`;
}

/** Excel's number format code for the values' format, for the axis. */
function formatCode(f: { fmt?: NumberFormat; dp?: number } | undefined): string {
  const dp = f?.dp ?? 2;
  const dec = dp > 0 ? `.${'0'.repeat(dp)}` : '';
  switch (f?.fmt) {
    case 'currency':
      return `"$"#,##0${dec}`;
    case 'percent':
      return `0${dec}%`;
    case 'number':
      return `#,##0${dec}`;
    case 'date':
      return 'yyyy-mm-dd';
    default:
      return 'General';
  }
}

const solid = (hex: string) => `<a:solidFill><a:srgbClr val="${hex.replace('#', '').toUpperCase()}"/></a:solidFill>`;

function rich(text: string, size = 1400): string {
  return `<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}" b="0"/></a:pPr><a:r><a:rPr lang="en-US" sz="${size}" b="0"/><a:t>${esc(text)}</a:t></a:r></a:p></c:rich></c:tx>`;
}

const titleXml = (text: string, size?: number) => `<c:title>${rich(text, size)}<c:overlay val="0"/></c:title>`;

/** The DrawingML chart part of one chart. */
export function chartXml(wb: Workbook, engine: Engine, own: Tab, chart: Chart, names: Map<string, string>): string {
  const data = chartData(wb, engine, own, chart);
  const cats = chart.categories ? excelRef(wb, own, chart.categories, names) : null;
  const strCache = (values: string[]) => `<c:strCache><c:ptCount val="${values.length}"/>${values.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join('')}</c:strCache>`;
  const numCache = (values: (number | null | undefined)[]) =>
    `<c:numCache><c:formatCode>${esc(formatCode(data.format))}</c:formatCode><c:ptCount val="${values.length}"/>${values.map((v, i) => (v == null ? '' : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join('')}</c:numCache>`;
  const type = chart.type;
  const stacked = !!chart.stacked && (type === 'column' || type === 'bar' || type === 'area');
  const sers = chart.series
    .map((s, i) => {
      const d = data.series[i];
      const values = excelRef(wb, own, s.values, names);
      if (!values || !d) return '';
      const nameRef = s.nameRef ? excelRef(wb, own, s.nameRef, names) : null;
      // A series without a name has none in the file either (Excel calls it "Series 1", as ours does).
      const tx = nameRef ? `<c:tx><c:strRef><c:f>${esc(nameRef)}</c:f>${strCache([d.name])}</c:strRef></c:tx>` : s.name ? `<c:tx><c:v>${esc(s.name)}</c:v></c:tx>` : '';
      const color = d.color;
      const spPr =
        type === 'line'
          ? `<c:spPr><a:ln w="28575" cap="rnd">${solid(color)}<a:round/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr>${solid(color)}<a:ln>${solid(color)}</a:ln></c:spPr></c:marker>`
          : type === 'scatter'
            ? `<c:spPr><a:ln w="19050"><a:noFill/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="6"/><c:spPr>${solid(color)}<a:ln>${solid(color)}</a:ln></c:spPr></c:marker>`
            : type === 'pie'
              ? ''
              : `<c:spPr>${solid(color)}</c:spPr>`;
      const val = `<c:numRef><c:f>${esc(values)}</c:f>${numCache(d.points.map((p) => p.y))}</c:numRef>`;
      if (type === 'scatter') {
        const x = cats ? `<c:xVal><c:numRef><c:f>${esc(cats)}</c:f>${numCache(d.points.map((p) => p.x))}</c:numRef></c:xVal>` : '';
        return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx}${spPr}${x}<c:yVal>${val}</c:yVal><c:smooth val="0"/></c:ser>`;
      }
      const cat = cats ? `<c:cat><c:strRef><c:f>${esc(cats)}</c:f>${strCache(data.categories)}</c:strRef></c:cat>` : '';
      // A pie's slices take the palette, as ours do (varyColors), but its first one keeps the series' color.
      const dPt = type === 'pie' && s.color ? `<c:dPt><c:idx val="0"/><c:bubble3D val="0"/><c:spPr>${solid(s.color)}</c:spPr></c:dPt>` : '';
      return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx}${spPr}${dPt}${cat}<c:val>${val}</c:val>${type === 'line' ? '<c:smooth val="0"/>' : ''}</c:ser>`;
    })
    .join('');
  const axIds = '<c:axId val="500000001"/><c:axId val="500000002"/>';
  let plot: string;
  if (type === 'column' || type === 'bar') {
    plot = `<c:barChart><c:barDir val="${type === 'bar' ? 'bar' : 'col'}"/><c:grouping val="${stacked ? 'stacked' : 'clustered'}"/><c:varyColors val="0"/>${sers}<c:gapWidth val="80"/>${stacked ? '<c:overlap val="100"/>' : ''}${axIds}</c:barChart>`;
  } else if (type === 'line') plot = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${sers}<c:marker val="1"/>${axIds}</c:lineChart>`;
  else if (type === 'area') plot = `<c:areaChart><c:grouping val="${stacked ? 'stacked' : 'standard'}"/><c:varyColors val="0"/>${sers}${axIds}</c:areaChart>`;
  else if (type === 'pie') plot = `<c:pieChart><c:varyColors val="1"/>${sers}<c:firstSliceAng val="0"/></c:pieChart>`;
  else plot = `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${sers}${axIds}</c:scatterChart>`;

  // The axes: categories (or x values) and values; a bar chart's run the other way.
  let axes = '';
  if (type !== 'pie') {
    const horizontal = type === 'bar';
    const valScaling = `<c:scaling>${chart.logScale ? '<c:logBase val="10"/>' : ''}<c:orientation val="minMax"/></c:scaling>`;
    const grid = '<c:majorGridlines><c:spPr><a:ln w="9525">' + solid('#E0E0E0') + '</a:ln></c:spPr></c:majorGridlines>';
    const catTitle = chart.xTitle ? titleXml(chart.xTitle, 1100) : '';
    const valTitle = chart.yTitle ? titleXml(chart.yTitle, 1100) : '';
    const valAx = (id: string, cross: string, pos: string, title: string, scaling: string, gridlines: string, code: string) =>
      `<c:valAx><c:axId val="${id}"/>${scaling}<c:delete val="0"/><c:axPos val="${pos}"/>${gridlines}${title}<c:numFmt formatCode="${esc(code)}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${cross}"/><c:crosses val="autoZero"/><c:crossBetween val="${type === 'scatter' ? 'midCat' : 'between'}"/></c:valAx>`;
    if (type === 'scatter') {
      axes = valAx('500000001', '500000002', 'b', catTitle, '<c:scaling><c:orientation val="minMax"/></c:scaling>', '', formatCode(data.xFormat)) + valAx('500000002', '500000001', 'l', valTitle, valScaling, grid, formatCode(data.format));
    } else {
      axes =
        `<c:catAx><c:axId val="500000001"/><c:scaling><c:orientation val="${horizontal ? 'maxMin' : 'minMax'}"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? 'l' : 'b'}"/>${catTitle}<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="500000002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>` +
        valAx('500000002', '500000001', horizontal ? 'b' : 'l', valTitle, valScaling, grid, formatCode(data.format));
    }
  }
  const legendPos: Record<LegendPosition, string> = { right: 'r', bottom: 'b', top: 't', none: '' };
  const legend = chart.legend ?? (chart.series.length > 1 || type === 'pie' ? 'right' : 'none');
  const legendXml = legend === 'none' ? '' : `<c:legend><c:legendPos val="${legendPos[legend]}"/><c:overlay val="0"/></c:legend>`;
  const title = chart.title ? titleXml(chart.title) + '<c:autoTitleDeleted val="0"/>' : '<c:autoTitleDeleted val="1"/>';
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:roundedCorners val="0"/>` +
    `<c:chart>${title}<c:plotArea><c:layout/>${plot}${axes}</c:plotArea>${legendXml}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>` +
    `<c:spPr>${solid('#FFFFFF')}<a:ln w="9525">${solid('#DADCE0')}</a:ln></c:spPr></c:chartSpace>`
  );
}

/** The drawing part of a tab: each chart anchored at its cell with its size (a one-cell anchor: it moves with the cell). */
function drawingXml(charts: Chart[], firstRel: number): string {
  const anchors = charts
    .map(
      (ch, i) =>
        `<xdr:oneCellAnchor><xdr:from><xdr:col>${ch.anchor.c}</xdr:col><xdr:colOff>${Math.round(ch.anchor.dx * EMU_PER_PX)}</xdr:colOff><xdr:row>${ch.anchor.r}</xdr:row><xdr:rowOff>${Math.round(ch.anchor.dy * EMU_PER_PX)}</xdr:rowOff></xdr:from>` +
        `<xdr:ext cx="${Math.round(ch.w * EMU_PER_PX)}" cy="${Math.round(ch.h * EMU_PER_PX)}"/>` +
        `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="${esc(ch.title ? `Chart ${i + 1}: ${ch.title}` : `Chart ${i + 1}`).slice(0, 250)}"><a:extLst><a:ext uri="${CHART_ID_EXT}"><ud:chart xmlns:ud="urn:universal-docs" id="${esc(ch.id)}"/></a:ext></a:extLst></xdr:cNvPr><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
        `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" r:id="rId${firstRel + i}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">${anchors}</xdr:wsDr>`;
}

const relsXml = (rels: { id: string; type: string; target: string }[]) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`).join('')}</Relationships>`;

/** The worksheet part of each sheet, by its position in the workbook (from workbook.xml and its relationships). */
async function sheetParts(zip: JSZip): Promise<{ name: string; part: string }[]> {
  const book = (await zip.file('xl/workbook.xml')?.async('string')) ?? '';
  const rels = (await zip.file('xl/_rels/workbook.xml.rels')?.async('string')) ?? '';
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  }
  const out: { name: string; part: string }[] = [];
  for (const m of book.matchAll(/<sheet\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[0])?.[1] ?? '';
    const id = /\br:id="([^"]+)"/.exec(m[0])?.[1];
    const part = id ? targets.get(id) : undefined;
    if (part) out.push({ name: decodeXml(name), part });
  }
  return out;
}

const decodeXml = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const relsPathOf = (part: string) => part.replace(/([^/]+)$/, '_rels/$1.rels');

/**
 * The Excel file ExcelJS wrote for `wb` with the tabs' charts put in. `names` are the sheet names the file
 * uses for the tabs (they may have been cleaned up), by tab id.
 */
export async function addChartsToXlsx(file: Buffer, wb: Workbook, engine: Engine, names: Map<string, string>): Promise<Buffer> {
  if (!wb.tabs.some((t) => t.charts?.length)) return file;
  const zip = await JSZip.loadAsync(file);
  const parts = await sheetParts(zip);
  let types = (await zip.file('[Content_Types].xml')!.async('string')) ?? '';
  let chartNo = Object.keys(zip.files).filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n)).length;
  let drawingNo = Object.keys(zip.files).filter((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n)).length;
  for (const [i, tab] of wb.tabs.entries()) {
    const charts = tab.charts ?? [];
    const sheet = parts[i];
    if (!charts.length || !sheet) continue;
    const sheetXml = await zip.file(sheet.part)?.async('string');
    // A sheet with a drawing of its own already (not one ExcelJS writes for us) is left as it is.
    if (!sheetXml || /<drawing\b/.test(sheetXml)) continue;
    const drawing = `drawing${++drawingNo}.xml`;
    const chartRels: { id: string; type: string; target: string }[] = [];
    charts.forEach((ch, k) => {
      const name = `chart${++chartNo}.xml`;
      zip.file(`xl/charts/${name}`, chartXml(wb, engine, tab, ch, names));
      chartRels.push({ id: `rId${k + 1}`, type: REL_CHART, target: `../charts/${name}` });
      types = types.replace('</Types>', `<Override PartName="/xl/charts/${name}" ContentType="${CT_CHART}"/></Types>`);
    });
    zip.file(`xl/drawings/${drawing}`, drawingXml(charts, 1));
    zip.file(`xl/drawings/_rels/${drawing}.rels`, relsXml(chartRels));
    types = types.replace('</Types>', `<Override PartName="/xl/drawings/${drawing}" ContentType="${CT_DRAWING}"/></Types>`);
    // The sheet's relationship to its drawing, and the drawing element in its place among the sheet's parts.
    const relsPath = relsPathOf(sheet.part);
    const existing = await zip.file(relsPath)?.async('string');
    const ids = new Set([...(existing ?? '').matchAll(/\bId="([^"]+)"/g)].map((m) => m[1]));
    let n = ids.size + 1;
    while (ids.has(`rId${n}`)) n++;
    const rel = `<Relationship Id="rId${n}" Type="${REL_DRAWING}" Target="../drawings/${drawing}"/>`;
    zip.file(relsPath, existing ? existing.replace('</Relationships>', `${rel}</Relationships>`) : relsXml([{ id: `rId${n}`, type: REL_DRAWING, target: `../drawings/${drawing}` }]));
    const drawingEl = `<drawing r:id="rId${n}"/>`;
    const after = /<(legacyDrawing|legacyDrawingHF|drawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/.exec(sheetXml);
    let xml = after ? `${sheetXml.slice(0, after.index)}${drawingEl}${sheetXml.slice(after.index)}` : sheetXml.replace('</worksheet>', `${drawingEl}</worksheet>`);
    if (!/xmlns:r=/.test(xml.slice(0, xml.indexOf('>', xml.indexOf('<worksheet'))))) xml = xml.replace('<worksheet ', `<worksheet xmlns:r="${NS_R}" `);
    zip.file(sheet.part, xml);
  }
  zip.file('[Content_Types].xml', types);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

// ---------------------------------------------------------------------------
// Reading

type X = Record<string, unknown>;
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false, isArray: (name) => ['ser', 'pt', 'twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor', 'p', 'r', 'Relationship', 'dPt'].includes(name) });
const obj = (v: unknown): X | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as X) : undefined);
const arr = (v: unknown): X[] => (Array.isArray(v) ? (v as X[]) : v ? [v as X] : []);
const attr = (n: X | undefined, a: string): string | undefined => (n ? (n[`@${a}`] as string | undefined) : undefined);
const val = (n: unknown) => attr(obj(n), 'val');

/** Plain text of a title's rich text. */
function titleText(title: X | undefined): string | undefined {
  const rich = obj(obj(obj(title)?.tx)?.rich);
  if (!rich) return undefined;
  const text = arr(rich.p)
    .map((p) => arr(p.r).map((r) => String(r.t ?? '')).join(''))
    .join(' ')
    .trim();
  return text || undefined;
}

/** An Excel chart formula (Sheet1!$B$2:$B$9) as one of our chart references from `own`, or null for what ours cannot hold. */
function ourRef(f: unknown, own: string, renames: Map<string, string>): string | null {
  if (typeof f !== 'string') return null;
  let s = f.trim();
  // Several areas, ("Sheet1!$A$1,Sheet1!$A$3"), or a name: not a range ours can be.
  if (!s || s.startsWith('(') || s.includes(',')) return null;
  for (const [from, to] of renames) s = renameSheetRefs(`=${s}`, from, to).slice(1);
  const m = /^(?:('(?:[^']|'')+'|[^!]+)!)?(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)$/i.exec(s);
  if (!m) return null;
  const sheet = m[1] ? (m[1].startsWith("'") ? m[1].slice(1, -1).replace(/''/g, "'") : m[1]) : own;
  const range = m[2].replace(/\$/g, '').toUpperCase();
  return sheet.toLowerCase() === own.toLowerCase() ? range : `${sheetRef(sheet)}!${range}`;
}

function colorOf(spPr: unknown): string | undefined {
  const sp = obj(spPr);
  const rgb = val(obj(sp?.solidFill)?.srgbClr) ?? val(obj(obj(obj(sp?.ln)?.solidFill))?.srgbClr);
  return rgb && /^[0-9a-f]{6}$/i.test(rgb) ? `#${rgb.toLowerCase()}` : undefined;
}

const PLOTS: [string, ChartType][] = [
  ['barChart', 'column'],
  ['bar3DChart', 'column'],
  ['lineChart', 'line'],
  ['line3DChart', 'line'],
  ['areaChart', 'area'],
  ['area3DChart', 'area'],
  ['pieChart', 'pie'],
  ['pie3DChart', 'pie'],
  ['doughnutChart', 'pie'],
  ['scatterChart', 'scatter'],
];

/** One Excel chart part as a chart of ours (without its place), or null when it is a kind ours cannot be. */
export function readChart(xml: string, own: string, renames: Map<string, string>, id: string): Omit<Chart, 'anchor' | 'w' | 'h'> | null {
  const doc = obj(parser.parse(xml));
  const chartEl = obj(obj(doc?.chartSpace)?.chart);
  const plotArea = obj(chartEl?.plotArea);
  if (!plotArea) return null;
  // One kind of plot only (a combination chart is not one ours can be).
  const kinds = PLOTS.filter(([k]) => plotArea[k] !== undefined);
  const other = Object.keys(plotArea).some((k) => k.endsWith('Chart') && !PLOTS.some(([p]) => p === k));
  if (kinds.length !== 1 || other || arr(plotArea[kinds[0][0]]).length !== 1) return null;
  const [key, base] = kinds[0];
  const plot = arr(plotArea[key])[0];
  let type = base;
  if (key.startsWith('bar') && val(plot.barDir) === 'bar') type = 'bar';
  const grouping = val(plot.grouping);
  const series: ChartSeries[] = [];
  let categories: string | undefined;
  for (const ser of arr(plot.ser)) {
    const valueRef = ourRef(obj(obj(type === 'scatter' ? ser.yVal : ser.val)?.numRef)?.f, own, renames);
    if (!valueRef) return null;
    const out: ChartSeries = { values: valueRef };
    const tx = obj(ser.tx);
    const nameRef = ourRef(obj(tx?.strRef)?.f, own, renames);
    if (nameRef) out.nameRef = nameRef;
    else if (typeof tx?.v === 'string' && tx.v) out.name = tx.v;
    const color = colorOf(type === 'line' || type === 'scatter' ? (obj(obj(ser.marker)?.spPr) ?? ser.spPr) : ser.spPr) ?? (type === 'line' ? colorOf(ser.spPr) : undefined);
    // The palette's color for its place is the default, not a color of its own.
    if (color && color !== CHART_COLORS[series.length % CHART_COLORS.length]) out.color = color;
    series.push(out);
    if (!categories) {
      const cat = obj(type === 'scatter' ? ser.xVal : ser.cat);
      const ref = ourRef(obj(cat?.strRef)?.f ?? obj(cat?.numRef)?.f ?? obj(cat?.multiLvlStrRef)?.f, own, renames);
      if (ref) categories = ref;
    }
  }
  if (!series.length) return null;
  const chart: Omit<Chart, 'anchor' | 'w' | 'h'> = { id, type, series, ...(categories ? { categories } : {}) };
  if ((grouping === 'stacked' || grouping === 'percentStacked') && (type === 'column' || type === 'bar' || type === 'area')) chart.stacked = true;
  const title = titleText(obj(chartEl?.title));
  if (title) chart.title = title;
  const legend = obj(chartEl?.legend);
  const pos = val(legend?.legendPos);
  chart.legend = !legend ? 'none' : pos === 'b' ? 'bottom' : pos === 't' ? 'top' : 'right';
  const valAxes = arr(plotArea.valAx);
  const catAx = arr(plotArea.catAx)[0] ?? arr(plotArea.dateAx)[0] ?? (type === 'scatter' ? valAxes[0] : undefined);
  const valueAx = type === 'scatter' ? valAxes[1] : valAxes[0];
  if (val(obj(valueAx?.scaling)?.logBase)) chart.logScale = true;
  const xTitle = titleText(obj(catAx?.title));
  const yTitle = titleText(obj(valueAx?.title));
  if (xTitle) chart.xTitle = xTitle;
  if (yTitle) chart.yTitle = yTitle;
  return chart;
}

/** Size along an axis from one cell (and offset) to another, in pixels, with the tab's sizes. */
function span(sizes: Record<string, number>, def: number, from: number, fromOff: number, to: number, toOff: number): number {
  let px = 0;
  for (let i = from; i < to; i++) px += sizes[i] ?? def;
  return Math.max(0, px - fromOff + toOff);
}

/**
 * The charts of an .xlsx, put on the tabs they are on (in sheet order). Returns how many could not be (a kind
 * of chart, or a range, ours cannot hold), which the import reports as lost.
 */
export async function readXlsxCharts(zip: JSZip, tabs: Tab[], renames: Map<string, string>): Promise<number> {
  // ExcelJS reads worksheets only: a chart sheet (a tab that is one chart) is not a tab here.
  const all = await sheetParts(zip);
  const parts = all.filter((p) => p.part.includes('/worksheets/'));
  let dropped = all.length - parts.length;
  for (const [i, sheet] of parts.entries()) {
    const tab = tabs[i];
    if (!tab) continue;
    const sheetRels = parser.parse((await zip.file(relsPathOf(sheet.part))?.async('string')) ?? '') as X;
    const rel = (rels: X, id: string | undefined) => arr(obj(rels.Relationships)?.Relationship).find((r) => attr(r, 'Id') === id);
    const resolve = (from: string, target: string) => {
      if (target.startsWith('/')) return target.slice(1);
      const dir = from.split('/').slice(0, -1);
      for (const seg of target.split('/')) {
        if (seg === '..') dir.pop();
        else if (seg !== '.') dir.push(seg);
      }
      return dir.join('/');
    };
    const sheetXml = (await zip.file(sheet.part)?.async('string')) ?? '';
    const drawingId = /<drawing\b[^>]*\br:id="([^"]+)"/.exec(sheetXml)?.[1];
    const drawingRel = drawingId ? rel(sheetRels, drawingId) : undefined;
    if (!drawingRel) continue;
    const drawingPart = resolve(sheet.part, String(attr(drawingRel, 'Target')));
    const drawing = obj(obj(parser.parse((await zip.file(drawingPart)?.async('string')) ?? ''))?.wsDr);
    const drawingRels = parser.parse((await zip.file(relsPathOf(drawingPart))?.async('string')) ?? '') as X;
    if (!drawing) continue;
    const charts: Chart[] = [];
    const anchors: [string, X][] = [...arr(drawing.twoCellAnchor).map((a): [string, X] => ['two', a]), ...arr(drawing.oneCellAnchor).map((a): [string, X] => ['one', a]), ...arr(drawing.absoluteAnchor).map((a): [string, X] => ['abs', a])];
    for (const [kind, a] of anchors) {
      const frame = obj(a.graphicFrame);
      const chartRef = obj(obj(obj(frame?.graphic)?.graphicData)?.chart);
      const rid = attr(chartRef, 'id');
      if (!rid) continue;
      const chartRel = rel(drawingRels, rid);
      const chartPart = chartRel ? resolve(drawingPart, String(attr(chartRel, 'Target'))) : null;
      const xml = chartPart ? await zip.file(chartPart)?.async('string') : undefined;
      // The id it was written with; one made elsewhere (Excel) is named by its tab and its object in the
      // drawing, which Excel keeps, so it is the same every time the file is read.
      const props = obj(obj(frame?.nvGraphicFramePr)?.cNvPr);
      const ext = arr(obj(props?.extLst)?.ext).find((e) => attr(e, 'uri') === CHART_ID_EXT);
      const id = attr(obj(ext?.chart), 'id') || `xlsx-${i + 1}-${attr(props, 'id') ?? charts.length + 1}`;
      const read = xml ? readChart(xml, renames.get(sheet.name) ?? sheet.name, renames, id) : null;
      if (!read) {
        dropped++;
        continue;
      }
      // Its place: the from cell and offset, and its size from the to cell or the extent.
      const from = obj(a.from);
      const num = (v: unknown) => Number(v ?? 0) || 0;
      const fc = num(from?.col);
      const fr = num(from?.row);
      const fco = num(from?.colOff) / EMU_PER_PX;
      const fro = num(from?.rowOff) / EMU_PER_PX;
      let w: number;
      let h: number;
      if (kind === 'two') {
        const to = obj(a.to);
        w = span(tab.colWidths, 100, fc, fco, num(to?.col), num(to?.colOff) / EMU_PER_PX);
        h = span(tab.rowHeights, 21, fr, fro, num(to?.row), num(to?.rowOff) / EMU_PER_PX);
      } else {
        const ext = obj(a.ext);
        w = num(attr(ext, 'cx')) / EMU_PER_PX;
        h = num(attr(ext, 'cy')) / EMU_PER_PX;
      }
      const anchor = kind === 'abs' ? { r: 0, c: 0, dx: Math.round(num(attr(obj(a.pos), 'x')) / EMU_PER_PX), dy: Math.round(num(attr(obj(a.pos), 'y')) / EMU_PER_PX) } : { r: fr, c: fc, dx: Math.round(fco), dy: Math.round(fro) };
      charts.push({ ...read, anchor, w: Math.max(120, Math.round(w) || 600), h: Math.max(80, Math.round(h) || 371) });
    }
    if (charts.length) tab.charts = charts.slice(0, 50);
  }
  return dropped;
}

/** Our number format for an Excel format code, roughly: enough for a chart's axis and tooltips. */
function formatOfCode(code: unknown): { fmt?: NumberFormat; dp?: number } | undefined {
  if (typeof code !== 'string' || !code || code === 'General') return undefined;
  const dp = /\.(0+)/.exec(code)?.[1].length ?? 0;
  if (code.includes('%')) return { fmt: 'percent', dp };
  if (/[$€£¥]/.test(code)) return { fmt: 'currency', dp };
  if (/[yd]/i.test(code)) return { fmt: 'date' };
  return { fmt: 'number', dp };
}

/** The values a cache holds, by index (a missing point is a gap), as many as it says it has. */
function cacheValues(cache: X | undefined): (string | null)[] {
  if (!cache) return [];
  const pts = arr(cache.pt);
  const n = Math.min(MAX_CACHE, Math.max(Number(val(cache.ptCount) ?? 0) || 0, ...pts.map((p) => Number(attr(p, 'idx') ?? 0) + 1)));
  const out: (string | null)[] = new Array(n).fill(null);
  for (const p of pts) {
    const i = Number(attr(p, 'idx') ?? -1);
    const v = p.v;
    if (i >= 0 && i < n && v !== undefined && v !== '') out[i] = String(v);
  }
  return out;
}
const MAX_CACHE = 2000;

/**
 * A chart part read with the data it keeps (the caches of its series): what a chart in a PowerPoint file
 * shows, for a slide chart that has no spreadsheet behind it. Null for a kind ours cannot be.
 */
export function readChartWithData(xml: string): { chart: Omit<Chart, 'anchor' | 'w' | 'h'>; data: ChartData } | null {
  const chart = readChart(xml, 'Sheet1', new Map(), 'chart');
  if (!chart) return null;
  const plotArea = obj(obj(obj(obj(parser.parse(xml))?.chartSpace)?.chart)?.plotArea);
  const plot = arr(plotArea?.[PLOTS.find(([k]) => plotArea?.[k] !== undefined)![0]])[0];
  const sers = arr(plot?.ser);
  const scatter = chart.type === 'scatter';
  const num = (v: string | null) => (v === null || !Number.isFinite(Number(v)) ? null : Number(v));
  let categories: string[] = [];
  let format: ReturnType<typeof formatOfCode>;
  let xFormat: ReturnType<typeof formatOfCode>;
  const series = sers.map((ser, i) => {
    const tx = obj(ser.tx);
    const name = cacheValues(obj(obj(tx?.strRef)?.strCache))[0] ?? (typeof tx?.v === 'string' ? tx.v : '') ?? '';
    const valCache = obj(obj(obj(scatter ? ser.yVal : ser.val)?.numRef)?.numCache);
    format ??= formatOfCode(valCache?.formatCode);
    const ys = cacheValues(valCache).map(num);
    let xs: (number | null)[] | null = null;
    const cat = obj(scatter ? ser.xVal : ser.cat);
    // Labels in one level, or several (multiLvlStrRef: pptxgenjs writes them so), of which the first is the innermost.
    const multi = obj(obj(cat?.multiLvlStrRef)?.multiLvlStrCache);
    const firstLevel: X | undefined = multi ? { ptCount: multi.ptCount, pt: arr(arr(multi.lvl)[0]?.pt) } : undefined;
    const catCache = obj(obj(cat?.strRef)?.strCache) ?? obj(obj(cat?.numRef)?.numCache) ?? firstLevel ?? obj(obj(cat?.strLit)) ?? obj(obj(cat?.numLit));
    if (scatter) {
      xs = cacheValues(catCache).map(num);
      xFormat ??= formatOfCode(catCache?.formatCode);
    } else if (!categories.length) categories = cacheValues(catCache).map((v) => v ?? '');
    return {
      name: name || `Series ${i + 1}`,
      color: chart.series[i]?.color ?? CHART_COLORS[i % CHART_COLORS.length],
      points: ys.map((y, k) => ({ y, ...(xs ? { x: xs[k] ?? null } : {}) })),
    };
  });
  if (!categories.length) categories = Array.from({ length: Math.max(0, ...series.map((s) => s.points.length)) }, (_, k) => String(k + 1));
  return { chart, data: { categories, series, ...(format ? { format } : {}), ...(xFormat ? { xFormat } : {}) } };
}
