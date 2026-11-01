import { describe, expect, it } from 'vitest';
import { buildSlide, newId, slideTitle, type Deck, type ImageElement, type LineElement, type ShapeElement, type TableElement, type TextElement, type ChartElement } from '../shared/deck.ts';
import { fontFace, hexColor, writePptx } from '../shared/pptxExport.ts';
import JSZip from 'jszip';
import { importPptx, isPptx } from './pptxImport.ts';

// A 1×1 red PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

async function pptxBuffer(deck: Deck): Promise<{ buf: Buffer; warnings: string[] }> {
  const { data, warnings } = await writePptx(deck, 'Round trip', async (src) => (src.startsWith('data:') ? src : null));
  return { buf: Buffer.from(data), warnings };
}

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/**
 * A presentation the way Google Slides exports one: text takes its size, weight, color and font from the master's
 * text styles and placeholders, not from the runs.
 */
async function googleStylePptx(): Promise<Buffer> {
  const rels = (items: [string, string, string][]) =>
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${target.startsWith('http') ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
  const lvl = (inner: string) => `<a:lvl1pPr>${inner}</a:lvl1pPr>`;
  const sp = (id: string, inner: string) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="s${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>${inner}</p:sp>`;
  const ph = (id: string, phAttrs: string, inner: string) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="s${id}"/><p:cNvSpPr txBox="1"/><p:nvPr><p:ph ${phAttrs}/></p:nvPr></p:nvSpPr>${inner}</p:sp>`;
  const xfrm = (x: number, y: number, cx: number, cy: number, flip = '') => `<a:xfrm${flip}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
  const geom = (prst: string) => `<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>`;
  const theme = `<a:theme ${NS} name="T"><a:themeElements><a:clrScheme name="Simple Light"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="595959"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="4285F4"/></a:accent1><a:accent2><a:srgbClr val="212121"/></a:accent2><a:accent3><a:srgbClr val="78909C"/></a:accent3><a:accent4><a:srgbClr val="FFAB40"/></a:accent4><a:accent5><a:srgbClr val="0097A7"/></a:accent5><a:accent6><a:srgbClr val="EEFF41"/></a:accent6><a:hlink><a:srgbClr val="0097A7"/></a:hlink><a:folHlink><a:srgbClr val="0097A7"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Verdana"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;
  const master =
    `<p:sldMaster ${NS}><p:cSld><p:spTree>` +
    ph('1', 'type="title"', `<p:spPr>${xfrm(311700, 445025, 8520600, 572700)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle>${lvl('<a:defRPr sz="2800"><a:solidFill><a:schemeClr val="dk1"/></a:solidFill></a:defRPr>')}</a:lstStyle><a:p/></p:txBody>`) +
    ph('2', 'idx="1" type="body"', `<p:spPr>${xfrm(311700, 1152475, 8520600, 3416400)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle>${lvl('<a:lnSpc><a:spcPct val="115000"/></a:lnSpc><a:buChar char="●"/><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="dk2"/></a:solidFill></a:defRPr>')}</a:lstStyle><a:p/></p:txBody>`) +
    `</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
    `<p:txStyles><p:titleStyle>${lvl('<a:defRPr b="0" sz="1400"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr>')}</p:titleStyle>` +
    `<p:bodyStyle>${lvl('<a:defRPr b="0" sz="1400"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr>')}</p:bodyStyle>` +
    `<p:otherStyle>${lvl('<a:defRPr b="0" i="1" sz="1400"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:latin typeface="Arial"/></a:defRPr>')}</p:otherStyle></p:txStyles></p:sldMaster>`;
  const layout =
    `<p:sldLayout ${NS}><p:cSld><p:spTree>` +
    ph('1', 'type="title"', `<p:spPr>${xfrm(311700, 445025, 8520600, 572700)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle>${lvl('<a:defRPr/>')}</a:lstStyle><a:p/></p:txBody>`) +
    ph('2', 'idx="1" type="body"', `<p:spPr>${xfrm(311700, 1152475, 8520600, 3416400)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle>${lvl('<a:defRPr/>')}</a:lstStyle><a:p/></p:txBody>`) +
    `</p:spTree></p:cSld></p:sldLayout>`;
  const run = (text: string, rPr = '<a:rPr lang="en"/>') => `<a:r>${rPr}<a:t>${text}</a:t></a:r>`;
  const link = (text: string) => run(text, '<a:rPr lang="en" u="sng"><a:solidFill><a:schemeClr val="hlink"/></a:solidFill><a:hlinkClick r:id="rId9"/></a:rPr>');
  const fill = `<a:solidFill><a:schemeClr val="lt2"/></a:solidFill><a:ln w="9525"><a:solidFill><a:schemeClr val="dk2"/></a:solidFill><a:headEnd type="none"/><a:tailEnd type="none"/></a:ln>`;
  const shapeBody = (ps: string) => `<p:txBody><a:bodyPr anchor="ctr" bIns="91425" lIns="91425" rIns="91425" tIns="91425"><a:noAutofit/></a:bodyPr><a:lstStyle/>${ps}</p:txBody>`;
  const cxn = (id: string, x: string, ln: string) => `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="c${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${x}${geom('straightConnector1')}<a:noFill/><a:ln w="9525"><a:solidFill><a:schemeClr val="dk2"/></a:solidFill>${ln}</a:ln></p:spPr></p:cxnSp>`;
  const slide =
    `<p:sld ${NS}><p:cSld><p:spTree>` +
    ph('10', 'type="title"', `<p:spPr>${xfrm(311700, 445025, 8520600, 572700)}${geom('rect')}</p:spPr><p:txBody><a:bodyPr><a:normAutofit fontScale="90000"/></a:bodyPr><a:lstStyle/><a:p><a:pPr><a:buNone/></a:pPr>${run('Intro')}</a:p></p:txBody>`) +
    ph('11', 'idx="1" type="body"', `<p:spPr>${xfrm(311700, 1152475, 8520600, 3416400)}${geom('rect')}</p:spPr><p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle/>` +
      `<a:p><a:pPr><a:spcBef><a:spcPts val="0"/></a:spcBef><a:buNone/></a:pPr>${run('Deployed on Fly.io:')}</a:p>` +
      `<a:p><a:pPr marL="457200" indent="-342900"><a:spcBef><a:spcPts val="1200"/></a:spcBef><a:buChar char="-"/></a:pPr>${run('sc-dashboard')}</a:p>` +
      `<a:p><a:pPr marL="457200" indent="-342900"><a:spcBef><a:spcPts val="0"/></a:spcBef><a:buChar char="-"/></a:pPr>${run('engine')}</a:p></p:txBody>`) +
    sp('12', `<p:spPr>${xfrm(490800, 1325150, 2110500, 1246500)}${geom('rect')}${fill}</p:spPr>${shapeBody(`<a:p><a:pPr algn="ctr"><a:buNone/></a:pPr>${link('Fly.io')}${run(' machines')}</a:p>`)}`) +
    sp('13', `<p:spPr>${xfrm(3523875, 1168075, 1757050, 1560725)}${geom('flowChartMagneticDisk')}${fill}</p:spPr>${shapeBody(`<a:p><a:pPr algn="ctr"><a:buNone/></a:pPr>${run('Redis')}</a:p>`)}`) +
    sp('14', `<p:spPr>${xfrm(6000000, 3000000, 1500000, 800000)}${geom('rect')}${fill}</p:spPr>${shapeBody(`<a:p><a:pPr algn="ctr"><a:buNone/></a:pPr>${link('Rollbar')}${run(' ')}</a:p><a:p><a:pPr algn="ctr"><a:buNone/></a:pPr>${run('ops@example.com')}</a:p>`)}`) +
    sp('15', `<p:spPr>${xfrm(6000000, 4000000, 1500000, 800000)}${geom('roundRect')}<a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr><p:style><a:lnRef idx="2"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style>${shapeBody(`<a:p>${run('Styled')}</a:p>`)}`) +
    cxn('16', xfrm(2601300, 1948400, 922500, 0), '<a:headEnd type="none"/><a:tailEnd type="triangle"/>') +
    cxn('17', xfrm(1546050, 2571650, 360900, 628200), '<a:headEnd type="none"/><a:tailEnd type="triangle"/>') +
    cxn('18', xfrm(1546050, 3571650, 360900, 628200, ' flipH="1"'), '<a:headEnd type="triangle"/><a:tailEnd type="none"/>') +
    // An elbow connector from the bottom of shape 12 (site 2) to the top of shape 13 (site 0), dashed, with an open arrowhead.
    `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="19" name="c19"/><p:cNvCxnSpPr><a:stCxn id="12" idx="2"/><a:endCxn id="13" idx="0"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr><p:spPr>${xfrm(1500000, 3000000, 2000000, 600000)}${geom('bentConnector3')}<a:ln w="19050"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:prstDash val="sysDash"/><a:tailEnd type="arrow"/></a:ln></p:spPr></p:cxnSp>` +
    `</p:spTree></p:cSld></p:sld>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('_rels/.rels', rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]));
  zip.file('ppt/presentation.xml', `<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'slide', 'slides/slide1.xml']]));
  zip.file('ppt/slideMasters/slideMaster1.xml', master);
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]));
  zip.file('ppt/slideLayouts/slideLayout1.xml', layout);
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]));
  zip.file('ppt/theme/theme1.xml', theme);
  zip.file('ppt/slides/slide1.xml', slide);
  zip.file('ppt/slides/_rels/slide1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId9', 'hyperlink', 'https://fly.io']]));
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

/**
 * A designed template the way PowerPoint saves one: the look lives in the layout (a dark background, a freeform,
 * a turned title placeholder with outlined capitals, a round picture placeholder) and the slide only fills it in.
 */
/** A designed template; `merged` makes the table's first row one cell across both columns. */
async function templatePptx(merged = false): Promise<Buffer> {
  const rels = (items: [string, string, string][]) =>
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
  const xfrm = (x: number, y: number, cx: number, cy: number, extra = '') => `<a:xfrm${extra}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
  const nv = (id: number, ph = '') => `<p:nvSpPr><p:cNvPr id="${id}" name="s${id}"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr>`;
  const theme = `<a:theme ${NS} name="T"><a:themeElements><a:clrScheme name="c"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="00FF00"/></a:accent1><a:accent2><a:srgbClr val="8040C0"/></a:accent2></a:clrScheme><a:fontScheme name="f"><a:majorFont><a:latin typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;
  const master =
    `<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></p:bgPr></p:bg><p:spTree>` +
    `<p:sp>${nv(2, '<p:ph type="title"/>')}<p:spPr>${xfrm(0, 0, 9144000, 914400)}</p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p/></p:txBody></p:sp>` +
    // The master's slide number has idx 4: a slide's "idx 4" body placeholder must not take its look.
    `<p:sp>${nv(3, '<p:ph type="sldNum" idx="4"/>')}<p:spPr>${xfrm(8229600, 0, 914400, 457200)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="900" cap="all"/></a:lvl1pPr></a:lstStyle><a:p/></p:txBody></p:sp>` +
    `</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt1" tx2="dk1"/>` +
    `<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4000" cap="all"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:titleStyle>` +
    `<p:bodyStyle><a:lvl1pPr><a:buChar char="+"/><a:buClr><a:schemeClr val="accent1"/></a:buClr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:bodyStyle></p:txStyles></p:sldMaster>`;
  const layout =
    `<p:sldLayout ${NS}><p:cSld><p:spTree>` +
    `<p:sp>${nv(5)}<p:spPr>${xfrm(0, 0, 4572000, 2286000)}<a:custGeom><a:pathLst><a:path w="200" h="100"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="200" y="0"/></a:lnTo><a:cubicBezTo><a:pt x="200" y="50"/><a:pt x="100" y="100"/><a:pt x="0" y="100"/></a:cubicBezTo><a:close/></a:path></a:pathLst></a:custGeom><a:noFill/><a:ln w="19050"><a:solidFill><a:schemeClr val="accent1"><a:alpha val="50000"/></a:schemeClr></a:solidFill></a:ln></p:spPr></p:sp>` +
    `<p:sp>${nv(6, '<p:ph type="title"/>')}<p:spPr>${xfrm(-914400, 1828800, 4572000, 914400, ' rot="16200000"')}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr algn="ctr"><a:defRPr><a:ln w="12700"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:ln><a:noFill/></a:defRPr></a:lvl1pPr></a:lstStyle><a:p/></p:txBody></p:sp>` +
    `<p:sp>${nv(7, '<p:ph type="pic" idx="13"/>')}<p:spPr>${xfrm(4572000, 914400, 1828800, 1828800)}<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom></p:spPr></p:sp>` +
    `<p:sp>${nv(8, '<p:ph idx="4"/>')}<p:spPr>${xfrm(4572000, 3200400, 3657600, 914400)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr><a:lnSpc><a:spcPts val="2800"/></a:lnSpc><a:defRPr sz="1400"/></a:lvl1pPr></a:lstStyle><a:p/></p:txBody></p:sp>` +
    `</p:spTree></p:cSld></p:sldLayout>`;
  const cell = (text: string, borders = '', tc = '') => `<a:tc${tc}><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en" sz="1400"/><a:t>${text}</a:t></a:r></a:p></a:txBody><a:tcPr anchor="ctr">${borders}</a:tcPr></a:tc>`;
  const blue = (side: string) => `<a:${side} w="38100"><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></a:${side}>`;
  const slide =
    `<p:sld ${NS}><p:cSld><p:spTree>` +
    `<p:sp>${nv(2, '<p:ph type="title"/>')}<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en"/><a:t>artist</a:t></a:r></a:p></p:txBody></p:sp>` +
    `<p:pic><p:nvPicPr><p:cNvPr id="3" name="p"/><p:cNvPicPr/><p:nvPr><p:ph type="pic" idx="13"/></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"><a:duotone><a:prstClr val="black"/><a:schemeClr val="accent2"/></a:duotone></a:blip><a:srcRect l="10000" r="20000"/><a:stretch/></p:blipFill><p:spPr/></p:pic>` +
    `<p:sp>${nv(4, '<p:ph idx="4"/>')}<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en"/><a:t>One</a:t></a:r></a:p></p:txBody></p:sp>` +
    `<p:sp>${nv(5)}<p:spPr>${xfrm(6858000, 0, 2286000, 5143500, ' flipH="1"')}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:gradFill><a:gsLst><a:gs pos="0"><a:schemeClr val="tx1"><a:alpha val="0"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="tx1"/></a:gs></a:gsLst><a:lin ang="10800000"/></a:gradFill></p:spPr></p:sp>` +
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="t"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="914400" y="3657600"/><a:ext cx="1828800" cy="914400"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid><a:gridCol w="914400"/><a:gridCol w="914400"/></a:tblGrid>` +
    `<a:tr h="457200">${merged ? `${cell('A', blue('lnB'), ' gridSpan="2"')}${cell('', blue('lnB'), ' hMerge="1"')}` : `${cell('A', blue('lnB'))}${cell('B', blue('lnB'))}`}</a:tr><a:tr h="457200">${cell('1', blue('lnT'))}${cell('2', blue('lnT'))}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>` +
    `</p:spTree></p:cSld></p:sld>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('ppt/presentation.xml', `<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', rels([['rId2', 'slide', 'slides/slide1.xml']]));
  zip.file('ppt/slideMasters/slideMaster1.xml', master);
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([['rId2', 'theme', '../theme/theme1.xml']]));
  zip.file('ppt/slideLayouts/slideLayout1.xml', layout);
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]));
  zip.file('ppt/theme/theme1.xml', theme);
  zip.file('ppt/slides/slide1.xml', slide);
  zip.file('ppt/slides/_rels/slide1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'image', '../media/image1.png']]));
  zip.file('ppt/media/image1.png', Buffer.from(PNG.split(',')[1], 'base64'));
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

describe('pptx export and import', () => {
  it('draws a designed template: layout artwork, inherited placement, outlined text, cropped pictures, gradients and tables', async () => {
    const { deck, warnings } = await importPptx(await templatePptx(), async () => '/api/images/00000000-0000-0000-0000-000000000000');
    expect(warnings).toEqual([]);
    const slide = deck.slides[0];
    // The master's background, since neither the slide nor the layout sets one.
    expect(slide.bg).toBe('#000000');
    const els = slide.elements;
    // The layout's freeform comes first (under the slide's own shapes), as a path in a 100×100 box.
    const freeform = els[0] as ShapeElement;
    expect(freeform).toMatchObject({ type: 'shape', x: 0, y: 0, w: 480, h: 240, fill: 'none', stroke: 'rgba(0, 255, 0, 0.5)', strokeWidth: 2 });
    expect(freeform.path).toBe('M0,0 L100,0 C100,50 50,100 0,100 Z');
    // The title takes its box and quarter turn from the layout, its outline from the layout's list style, and
    // its capitals, size and vertical centering from the master.
    const title = els.find((e): e is TextElement => e.type === 'text' && e.role === 'title')!;
    expect(title).toMatchObject({ rot: -90, style: { size: 53, outline: '#00ff00', caps: true, align: 'center', valign: 'middle' } });
    expect(Math.abs(title.x + title.w / 2 - 144)).toBeLessThanOrEqual(1);
    // The picture fills its placeholder: cropped, cut to the placeholder's ellipse, in the duotone's two colors.
    const pic = els.find((e): e is ImageElement => e.type === 'image')!;
    expect(pic).toMatchObject({ x: 480, y: 96, w: 192, h: 192, crop: { l: 0.1, t: 0, r: 0.2, b: 0 }, clip: 'ellipse(50% 50% at 50% 50%)', duotone: ['#000000', '#8040c0'] });
    // A body placeholder with idx 4 follows the layout's idx 4 (and the master's body style), not the master's slide number.
    const body = els.find((e): e is TextElement => e.type === 'text' && e.paragraphs[0].text === 'One')!;
    expect(body.style).toEqual({ size: 19, color: '#ffffff', lineHeight: 2, bulletChar: '+', bulletColor: '#00ff00' });
    expect(body.paragraphs[0].bullet).toBe(true);
    // A mirrored gradient runs the other way.
    const fade = els.find((e): e is ShapeElement => e.type === 'shape' && !!e.fill?.startsWith('linear-gradient'))!;
    expect(fade.fill).toBe('linear-gradient(90deg, rgba(0, 0, 0, 0) 0%, #000000 100%)');
    // The table: one table element with its cells' text, alignment and size, and the border color it has.
    const table = els.find((e): e is TableElement => e.type === 'table')!;
    expect(table).toMatchObject({ x: 96, y: 384, w: 192, h: 96, style: { size: 19, border: '#0000ff' } });
    expect(table.rows).toEqual([
      [
        { text: 'A', align: 'center' },
        { text: 'B', align: 'center' },
      ],
      [
        { text: '1', align: 'center' },
        { text: '2', align: 'center' },
      ],
    ]);
    expect(table.cols).toBeUndefined();
    expect(els.some((e) => e.type === 'line')).toBe(false);
  });

  it('draws a table with merged cells, which ours cannot hold, as text boxes and the borders between them', async () => {
    const { deck } = await importPptx(await templatePptx(true), async () => '/api/images/00000000-0000-0000-0000-000000000000');
    const els = deck.slides[0].elements;
    expect(els.some((e) => e.type === 'table')).toBe(false);
    const cells = els.filter((e): e is TextElement => e.type === 'text' && ['A', '1', '2'].includes(e.paragraphs[0].text));
    expect(cells.map((c) => [c.paragraphs[0].text, c.w, c.style?.align, c.style?.valign])).toEqual([['A', 173, 'center', 'middle'], ['1', 77, 'center', 'middle'], ['2', 77, 'center', 'middle']]);
    const rules = els.filter((e): e is LineElement => e.type === 'line');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ x: 96, y: 432, w: 192, h: 0, strokeColor: '#0000ff', strokeWidth: 4 });
  });

  it('round-trips tables: cells, their look, column widths, the header row and banding', async () => {
    const s = buildSlide('blank', {}, newId);
    const table: TableElement = {
      id: newId(),
      type: 'table',
      x: 80,
      y: 100,
      w: 600,
      h: 160,
      cols: [0.5, 0.25, 0.25],
      header: true,
      banded: true,
      style: { size: 20, font: 'Georgia', border: '#888888' },
      rows: [
        [{ text: 'Region' }, { text: 'Q1', align: 'right' }, { text: 'Q2', align: 'right' }],
        [{ text: 'North\nand east' }, { text: '10', align: 'right' }, { text: '12', align: 'right' }],
        [{ text: 'South' }, { text: '7', align: 'right' }, { text: '9', align: 'right', fill: '#ffeeaa', color: '#aa0000' }],
        [{ text: 'Total', bold: true, italic: true }, { text: '17', align: 'right', bold: true }, { text: '21', align: 'right', bold: true }],
      ],
    };
    s.elements.push(table);
    const { buf, warnings } = await pptxBuffer({ version: 1, theme: 'light', slides: [s] });
    expect(warnings).toEqual([]);
    const back = (await importPptx(buf, async () => '/api/images/x')).deck.slides[0].elements.find((e): e is TableElement => e.type === 'table')!;
    expect(back).toMatchObject({ id: table.id, x: 80, y: 100, w: 600, h: 160, header: true, banded: true, style: { size: 20, font: 'Georgia', border: '#888888' } });
    expect(back.cols).toEqual([0.5, 0.25, 0.25]);
    // The cells' text and own look come back; the header's and the bands' fills are written out on each cell.
    expect(back.rows.map((r) => r.map((c) => c.text))).toEqual(table.rows.map((r) => r.map((c) => c.text)));
    expect(back.rows[0][0]).toMatchObject({ fill: '#1a73e8', color: '#ffffff' });
    expect(back.rows[0][0].bold).toBeUndefined();
    expect(back.rows[2][2]).toMatchObject({ align: 'right', fill: '#ffeeaa', color: '#aa0000' });
    expect(back.rows[3][0]).toMatchObject({ bold: true, italic: true });
    expect(back.rows[1][0].fill).toBeUndefined();
  });

  it('round-trips charts as PowerPoint charts: their kind, data, titles and axes, and the spreadsheet chart they show', async () => {
    const s = buildSlide('blank', {}, newId);
    const data = { categories: ['Jan', 'Feb', 'Mar'], series: [{ name: 'Input', color: '#ff0000', points: [{ y: 10 }, { y: null }, { y: 0.5 }] }, { name: 'Output', color: '#ea4335', points: [{ y: 30 }, { y: 20 }, { y: 2 }] }], format: { fmt: 'currency' as const, dp: 2 } };
    const line: ChartElement = { id: newId(), type: 'chart', x: 80, y: 60, w: 480, h: 300, chart: { id: 'c1', type: 'line', title: 'Prices', legend: 'bottom', logScale: true, yTitle: 'USD', series: [{ values: 'B2:B4' }, { values: 'C2:C4' }] }, data, source: { sheet: 'sheet-1', title: 'Figures', tabId: 't1', tab: 'Prices', chart: 'c1', rev: 'r1' } };
    const bars: ChartElement = { id: newId(), type: 'chart', x: 600, y: 60, w: 300, h: 300, chart: { id: 'c2', type: 'bar', stacked: true, legend: 'none', series: [{ values: 'B2:B4' }] }, data: { categories: ['a', 'b'], series: [{ name: 'Units', color: '#4285f4', points: [{ y: 3 }, { y: 4 }] }] } };
    s.elements.push(line, bars);
    const { buf, warnings } = await pptxBuffer({ version: 1, theme: 'light', slides: [s] });
    expect(warnings).toEqual([]);
    const { deck, warnings: read } = await importPptx(buf, async () => '/api/images/x');
    expect(read).toEqual([]);
    const charts = deck.slides[0].elements.filter((e): e is ChartElement => e.type === 'chart');
    const back = charts.find((c) => c.id === line.id)!;
    expect(back).toMatchObject({ x: 80, y: 60, w: 480, h: 300, source: line.source, chart: { type: 'line', title: 'Prices', legend: 'bottom', logScale: true, yTitle: 'USD' } });
    expect(back.data.categories).toEqual(['Jan', 'Feb', 'Mar']);
    expect(back.data.series.map((x) => [x.name, x.points.map((p) => p.y)])).toEqual([
      ['Input', [10, null, 0.5]],
      ['Output', [30, 20, 2]],
    ]);
    expect(back.data.series[0].color).toBe('#ff0000');
    const backBars = charts.find((c) => c.id === bars.id)!;
    expect(backBars).toMatchObject({ chart: { type: 'bar', stacked: true, legend: 'none' } });
    expect(backBars).not.toHaveProperty('source');
  });

  it('keeps the spreadsheet range a table is linked to', async () => {
    const s = buildSlide('blank', {}, newId);
    const source = { sheet: 'abc123', title: 'Q3 "final" & more', tabId: 't1', tab: 'Sales <EU>', range: 'A1:B2', rev: '2026-10-19T10:00:00.000Z' };
    const table: TableElement = { id: newId(), type: 'table', x: 80, y: 100, w: 400, h: 80, rows: [[{ text: 'a' }, { text: 'b' }], [{ text: 'c' }, { text: 'd' }]], source };
    const plain: TableElement = { ...table, id: newId(), y: 300, source: undefined };
    delete plain.source;
    s.elements.push(table, plain);
    const { buf } = await pptxBuffer({ version: 1, theme: 'light', slides: [s] });
    const tables = (await importPptx(buf, async () => '/api/images/x')).deck.slides[0].elements.filter((e): e is TableElement => e.type === 'table');
    expect(tables.find((t) => t.id === table.id)?.source).toEqual(source);
    expect(tables.find((t) => t.id === plain.id)).not.toHaveProperty('source');
  });


  it('round-trips arcs with their angles and no warning', async () => {
    const s = buildSlide('blank', {}, newId);
    s.elements.push({ id: newId(), type: 'shape', shape: 'arc', x: 180, y: 187, w: 223, h: 223, fill: 'none', stroke: '#ff0000', strokeWidth: 3, startAngle: 90, endAngle: 200 });
    const { buf } = await pptxBuffer({ version: 1, theme: 'light', slides: [s] });
    const { deck, warnings } = await importPptx(buf, async () => '/api/images/x');
    const arc = deck.slides[0].elements.find((e): e is ShapeElement => e.type === 'shape' && e.shape === 'arc')!;
    expect(arc).toMatchObject({ fill: 'none', stroke: '#ff0000', startAngle: 90, endAngle: 200 });
    expect(warnings.join(' ')).not.toMatch(/arc/);
  });

  it('inherits text styles from the master and layout, keeps link colors to links, and converts lines and cylinders', async () => {
    const { deck, warnings } = await importPptx(await googleStylePptx(), async () => '');
    expect(warnings).toEqual([]);
    const els = deck.slides[0].elements;
    const texts = els.filter((e): e is TextElement => e.type === 'text');
    // The title: 28pt from the master placeholder, shrunk to 90% by autofit, regular weight, the heading font.
    const title = texts.find((t) => t.role === 'title')!;
    expect(title.style).toEqual({ size: 34, font: 'Arial', bold: false });
    // The body: 18pt in the theme's dark gray from the master placeholder, 115% line spacing, the body font;
    // the widest gap between paragraphs stands for the box.
    const body = texts.find((t) => t.paragraphs[0].text === 'Deployed on Fly.io:')!;
    expect(body.style).toEqual({ size: 24, font: 'Verdana', color: '#595959', lineHeight: 1.38, paraSpacing: 16, bulletChar: '-' });
    expect(body.paragraphs.map((p) => !!p.bullet)).toEqual([false, true, true]);
    // Text in a plain shape: 14pt italic (the master's "other" style) in the theme text color, not white, and
    // a hyperlink inside it does not recolor the whole box.
    const fly = texts.find((t) => t.paragraphs[0].text === 'Fly.io machines')!;
    expect(fly.style).toEqual({ size: 19, font: 'Arial', italic: true, align: 'center', valign: 'middle' });
    // The link itself survives as a run in the link color; the rest of the paragraph is plain.
    expect(fly.paragraphs[0].runs).toEqual([{ text: 'Fly.io', link: 'https://fly.io', color: '#0097a7' }, { text: ' machines' }]);
    // A paragraph that is only a link keeps the link color.
    const rollbar = texts.find((t) => t.paragraphs[0].text === 'Rollbar ')!;
    expect(rollbar.style?.color).toBeUndefined();
    expect(rollbar.paragraphs[0].color).toBe('#0097a7');
    expect(rollbar.paragraphs[1].color).toBeUndefined();
    // A styled shape's font reference gives its text color (PowerPoint's light text on filled shapes).
    expect(texts.find((t) => t.paragraphs[0].text === 'Styled')!.style?.color).toBe('#ffffff');
    // Cylinders, and connectors with their arrowheads and diagonals.
    expect(els.find((e) => e.type === 'shape' && e.shape === 'cylinder')).toMatchObject({ fill: '#eeeeee', stroke: '#595959' });
    const lines = els.filter((e): e is LineElement => e.type === 'line');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({ kind: 'straight', h: 0, endArrow: 'triangle', strokeColor: '#595959', strokeWidth: 1 });
    expect(lines[1]).toMatchObject({ w: 38, h: 66, endArrow: 'triangle' });
    expect(lines[1].flipH).toBeUndefined();
    expect(lines[2]).toMatchObject({ w: 38, h: 66, startArrow: 'triangle', flipH: true }); // flipped: the start is on the right
    // Elbow connectors keep their route, dash, arrowhead and the shapes they are attached to.
    const rect = els.find((e) => e.type === 'shape' && e.shape === 'rect' && e.text === undefined && e.id === lines[3].startConnection?.elementId);
    const disk = els.find((e) => e.type === 'shape' && e.shape === 'cylinder')!;
    expect(lines[3]).toMatchObject({ kind: 'elbow', dash: 'dash', endArrow: 'open', strokeColor: '#ff0000', startConnection: { site: 'bottom' }, endConnection: { elementId: disk.id, site: 'top' } });
    expect(rect).toBeDefined();
  });

  it('converts colors and fonts for PowerPoint', () => {
    expect(hexColor('#1a73e8')).toBe('1A73E8');
    expect(hexColor('#abc')).toBe('AABBCC');
    expect(hexColor('red')).toBeUndefined();
    expect(fontFace("Georgia, 'Times New Roman', serif")).toBe('Georgia');
    expect(fontFace("'Google Sans', Roboto, sans-serif")).toBe('Arial');
  });

  it('round-trips text, bullets, shapes, pictures, backgrounds and notes', async () => {
    const title = buildSlide('title', { title: 'Quarterly review', subtitle: 'October 2026', notes: 'Welcome everyone' }, newId);
    const body = buildSlide('title-body', { title: 'Highlights', body: ['Revenue up 12%', '  Mostly in EMEA', 'Churn down'], background: '#123456' }, newId);
    body.elements.push(
      { id: newId(), type: 'shape', shape: 'ellipse', x: 700, y: 380, w: 120, h: 120, fill: '#00aa00', text: 'Go' },
      { id: newId(), type: 'shape', shape: 'line', x: 60, y: 500, w: 400, h: 0, stroke: '#ff0000', strokeWidth: 4 },
      { id: newId(), type: 'shape', shape: 'star', x: 500, y: 400, w: 100, h: 100, fill: '#ffcc00' },
      { id: newId(), type: 'shape', shape: 'rounded', x: 60, y: 420, w: 200, h: 40, fill: 'rgba(255, 255, 255, 0.12)', stroke: 'rgba(255, 255, 255, 0.3)', strokeWidth: 1 },
      { id: newId(), type: 'shape', shape: 'line', x: 480, y: 160, w: 0, h: 200, stroke: '#00ff00', strokeWidth: 2 },
      {
        id: newId(),
        type: 'text',
        x: 620,
        y: 400,
        w: 200,
        h: 100,
        paragraphs: [
          { text: '2-3x', size: 47, bold: false },
          { text: 'Average program cost reduction', bold: true },
          { text: 'See the report', runs: [{ text: 'See the ' }, { text: 'report', link: 'https://example.com/report' }] },
        ],
        style: { size: 17, align: 'center', color: '#ffffff', font: 'Poppins', lineHeight: 1.5 },
      },
      { id: newId(), type: 'shape', shape: 'arrow', x: 300, y: 420, w: 160, h: 60, fill: 'none', stroke: '#0000ff', strokeWidth: 2 },
      { id: newId(), type: 'shape', shape: 'cylinder', x: 840, y: 100, w: 80, h: 100, fill: '#dddddd', stroke: '#333333', strokeWidth: 1 },
      { id: newId(), type: 'shape', shape: 'line', x: 700, y: 60, w: 120, h: 80, flip: true, arrow: 'both', stroke: '#123456', strokeWidth: 2 },
      { id: newId(), type: 'image', x: 600, y: 160, w: 200, h: 150, src: PNG },
      { id: newId(), type: 'line', kind: 'elbow', x: 100, y: 200, w: 150, h: 90, flipV: true, dash: 'dot', startArrow: 'diamond', endArrow: 'circle', strokeColor: '#abcdef', strokeWidth: 3 },
      { id: newId(), type: 'line', kind: 'curved', x: 100, y: 320, w: 150, h: 40, endArrow: 'open' },
    );
    const deck: Deck = { version: 1, theme: 'light', slides: [title, body] };

    const { buf, warnings: exportWarnings } = await pptxBuffer(deck);
    expect(exportWarnings).toEqual([]);
    expect(await isPptx(buf)).toBe(true);
    expect(await isPptx(Buffer.from('not a zip'))).toBe(false);

    const stored: { type: string; size: number }[] = [];
    const { deck: imported, warnings } = await importPptx(buf, async (type, data) => {
      stored.push({ type, size: data.length });
      return `/api/images/00000000-0000-0000-0000-00000000000${stored.length}`;
    });
    expect(warnings).toEqual([]);
    expect(imported.slides).toHaveLength(2);

    const s1 = imported.slides[0];
    expect(slideTitle(s1)).toBe('Quarterly review');
    expect(s1.notes).toBe('Welcome everyone');
    expect(s1.layout).toBe('title');
    const t1 = s1.elements.find((e): e is TextElement => e.type === 'text' && e.role === 'title')!;
    // Positions survive within a point or two (EMU rounding).
    expect(Math.abs(t1.x - 60)).toBeLessThanOrEqual(2);
    expect(Math.abs(t1.w - 840)).toBeLessThanOrEqual(2);
    expect(t1.style).toMatchObject({ align: 'center', valign: 'bottom', size: 40 });
    const sub = s1.elements.find((e): e is TextElement => e.type === 'text' && e.role === 'subtitle')!;
    expect(sub.paragraphs[0].text).toBe('October 2026');

    const s2 = imported.slides[1];
    expect(s2.bg).toBe('#123456');
    const bodyEl = s2.elements.find((e): e is TextElement => e.type === 'text' && e.role === 'body')!;
    expect(bodyEl.paragraphs).toEqual([
      { text: 'Revenue up 12%', bullet: true },
      { text: 'Mostly in EMEA', bullet: true, level: 1 },
      { text: 'Churn down', bullet: true },
    ]);
    const ellipse = s2.elements.find((e): e is ShapeElement => e.type === 'shape' && e.shape === 'ellipse')!;
    // A filled shape with text comes back as the shape plus a centered text element on top, so styling survives.
    expect(ellipse).toMatchObject({ fill: '#00aa00' });
    expect(ellipse.text).toBeUndefined();
    const go = s2.elements[s2.elements.indexOf(ellipse) + 1] as TextElement;
    expect(go).toMatchObject({ type: 'text', paragraphs: [{ text: 'Go' }], style: { align: 'center', valign: 'middle', color: '#ffffff' } });
    expect(Math.abs(ellipse.x - 700)).toBeLessThanOrEqual(2);
    const line = s2.elements.find((e): e is LineElement => e.type === 'line')!;
    expect(line).toMatchObject({ strokeColor: '#ff0000', h: 0 });
    expect(line.strokeWidth).toBeGreaterThanOrEqual(3);
    // Translucent fills, vertical lines and per-paragraph sizes survive too.
    const pill = s2.elements.find((e): e is ShapeElement => e.type === 'shape' && e.shape === 'rounded')!;
    expect(pill.fill).toBe('rgba(255, 255, 255, 0.12)');
    expect(pill.stroke).toBe('rgba(255, 255, 255, 0.3)');
    const vline = s2.elements.find((e): e is LineElement => e.type === 'line' && e.w === 0)!;
    expect(Math.abs(vline.h - 200)).toBeLessThanOrEqual(2);
    expect(vline.strokeColor).toBe('#00ff00');
    const figure = s2.elements.find((e): e is TextElement => e.type === 'text' && e.paragraphs[0]?.text === '2-3x')!;
    expect(figure.style).toMatchObject({ size: 47, align: 'center', color: '#ffffff', font: 'Poppins', lineHeight: 1.5 });
    expect(figure.paragraphs[0].size).toBeUndefined(); // the first paragraph is the box's own style
    expect(figure.paragraphs[1]).toMatchObject({ text: 'Average program cost reduction', size: 17, bold: true });
    expect(figure.paragraphs[2].runs).toEqual([{ text: 'See the ' }, { text: 'report', link: 'https://example.com/report' }]);

    // Preset geometries map both ways through the shape table.
    expect(s2.elements.find((e): e is ShapeElement => e.type === 'shape' && e.shape === 'star')).toMatchObject({ fill: '#ffcc00', w: 100, h: 100 });
    expect(s2.elements.find((e): e is ShapeElement => e.type === 'shape' && e.shape === 'arrow')).toMatchObject({ fill: 'none', stroke: '#0000ff' });
    // Cylinders, diagonal lines and arrowheads round-trip too.
    expect(s2.elements.find((e): e is ShapeElement => e.type === 'shape' && e.shape === 'cylinder')).toMatchObject({ fill: '#dddddd', stroke: '#333333' });
    const diagonal = s2.elements.find((e): e is LineElement => e.type === 'line' && e.w > 0 && e.h > 0)!;
    expect(diagonal).toMatchObject({ flipV: true, startArrow: 'triangle', endArrow: 'triangle', strokeColor: '#123456' });
    expect(Math.abs(diagonal.w - 120)).toBeLessThanOrEqual(2);
    expect(Math.abs(diagonal.h - 80)).toBeLessThanOrEqual(2);
    // Elbow and curved connectors keep their kind, flips, dash and arrowheads.
    const elbow = s2.elements.find((e): e is LineElement => e.type === 'line' && e.kind === 'elbow')!;
    expect(elbow).toMatchObject({ flipV: true, dash: 'dot', startArrow: 'diamond', endArrow: 'circle', strokeColor: '#abcdef' });
    expect(s2.elements.find((e): e is LineElement => e.type === 'line' && e.kind === 'curved')).toMatchObject({ endArrow: 'open' });
    const img = s2.elements.find((e): e is ImageElement => e.type === 'image')!;
    expect(img.src).toBe('/api/images/00000000-0000-0000-0000-000000000001');
    expect(stored).toEqual([{ type: 'image/png', size: expect.any(Number) }]);
  });

  it('gives the same ids each time a file is read, and keeps the ids of a presentation it wrote', async () => {
    const IMG = '/api/images/00000000-0000-0000-0000-000000000000';
    const ids = (d: Deck) => d.slides.map((sl) => sl.elements.map((e) => e.id));
    // A file the app did not write: the same ids on every read.
    const template = await templatePptx();
    const first = (await importPptx(template, async () => IMG)).deck;
    const again = (await importPptx(template, async () => IMG)).deck;
    expect(ids(again)).toEqual(ids(first));
    expect(new Set(ids(first).flat()).size).toBe(ids(first).flat().length);

    // One the app wrote: its elements come back with the ids they had.
    const slide = buildSlide('title-body', { title: 'Plan', body: ['One', 'Two'] }, newId);
    slide.elements.push({ id: newId(), type: 'shape', shape: 'rect', x: 100, y: 400, w: 80, h: 40, fill: '#ff0000' });
    const deck: Deck = { version: 1, theme: 'light', slides: [slide] };
    const { buf } = await pptxBuffer(deck);
    const back = (await importPptx(buf, async () => IMG)).deck;
    expect(ids(back)).toEqual(ids(deck));
    expect(ids((await importPptx(buf, async () => IMG)).deck)).toEqual(ids(deck));
  });

  it('reports what it drops and rejects files that are not presentations', async () => {
    await expect(importPptx(Buffer.from('nope'), async () => '')).rejects.toThrow(/not a valid PowerPoint/);
    const deck: Deck = { version: 1, theme: 'dark', slides: [buildSlide('image', { title: 'Pic', image: 'https://example.com/missing.png' }, newId)] };
    const { buf, warnings } = await pptxBuffer(deck); // the image cannot be loaded in this test
    expect(warnings[0]).toMatch(/1 image could not be loaded/);
    const { deck: imported } = await importPptx(buf, async () => '');
    expect(imported.slides[0].bg).toBe('#1b1b1f'); // the dark theme's background travels as a slide color
    expect(imported.slides[0].elements.some((e) => e.type === 'text' && e.paragraphs[0].text === 'Image unavailable')).toBe(true);
  });
});
