// Temporary: the same libraries in the same script, but only loaded when a request asks (?load=1).
const load = () => Promise.all([import('@anthropic-ai/sdk'), import('openai'), import('xlsx'), import('exceljs'), import('pptxgenjs')]);
export default {
  async fetch(req) {
    const n = new URL(req.url).searchParams.has('load') ? (await load()).length : 0;
    return new Response('ok ' + n, { headers: { 'cache-control': 'no-store' } });
  },
};
