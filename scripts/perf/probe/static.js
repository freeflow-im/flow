// Temporary: the heavy libraries loaded when the script starts, as the suite's Worker loads them today.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import pptxgen from 'pptxgenjs';
globalThis.__keep = [Anthropic, OpenAI, XLSX, ExcelJS, pptxgen];
export default { fetch: () => new Response('ok ' + globalThis.__keep.length, { headers: { 'cache-control': 'no-store' } }) };
