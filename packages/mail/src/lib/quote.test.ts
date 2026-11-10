import { describe, expect, it } from 'vitest';
import { markQuote, quoteText, splitQuote, splitQuotedText } from './quote';

const marked = (html: string) => {
  const r = markQuote(html);
  const doc = new DOMParser().parseFromString(r.html, 'text/html');
  const hidden = [...doc.body.querySelectorAll('[data-quoted]')].filter((e) => !e.parentElement?.closest('[data-quoted]')).map((e) => e.textContent?.trim()).filter(Boolean);
  doc.body.querySelectorAll('[data-quoted]').forEach((e) => e.remove());
  return { quoted: r.quoted, shown: doc.body.textContent?.trim(), hidden };
};

describe('markQuote', () => {
  it("folds this app's own reply quote: the attribution line and the blockquote", () => {
    const r = marked('<p>Thanks, see you then.</p><p>On Nov 10, 2026, Bo &lt;bo@x.test&gt; wrote:</p><blockquote><p>Lunch?</p></blockquote>');
    expect(r.quoted).toBe(true);
    expect(r.shown).toBe('Thanks, see you then.');
    expect(r.hidden).toEqual(['On Nov 10, 2026, Bo <bo@x.test> wrote:', 'Lunch?']);
  });
  it("folds Gmail's quote, nested in its wrapper, and what follows it", () => {
    const r = marked('<div dir="ltr"><div>Sounds good.</div><br><div class="gmail_quote"><div class="gmail_attr">On Mon, Bo wrote:</div><blockquote class="gmail_quote">Lunch?</blockquote></div></div><div>sent from my phone</div>');
    expect(r.quoted).toBe(true);
    expect(r.shown).toBe('Sounds good.');
    expect(r.hidden).toEqual(['On Mon, Bo wrote:Lunch?', 'sent from my phone']);
  });
  it("folds Apple Mail's cited blockquote with its line above, and Outlook's rule and header", () => {
    const apple = marked('<div>Yes.</div><div><br></div><div>On 10 Nov 2026, at 09:00, Bo wrote:</div><br><blockquote type="cite"><div>Lunch?</div></blockquote>');
    expect(apple.shown).toBe('Yes.');
    expect(apple.hidden).toEqual(['On 10 Nov 2026, at 09:00, Bo wrote:', 'Lunch?']);
    const outlook = marked('<div class="WordSection1"><p>Yes.</p><hr><div id="divRplyFwdMsg"><b>From:</b> Bo<br><b>Sent:</b> Monday</div><div>Lunch?</div></div>');
    expect(outlook.shown).toBe('Yes.');
    expect(outlook.hidden).toEqual(['From: BoSent: Monday', 'Lunch?']);
  });
  it('leaves a message alone when it has no quote, or is nothing but one', () => {
    expect(markQuote('<p>Hello</p><blockquote>a pull quote</blockquote>')).toEqual({ html: '<p>Hello</p><blockquote>a pull quote</blockquote>', quoted: false });
    expect(markQuote('<p>On Monday, Bo wrote:</p><blockquote>Lunch?</blockquote>').quoted).toBe(false);
    expect(markQuote('<div class="gmail_quote">Lunch?</div>').quoted).toBe(false);
  });
});

describe('splitQuote', () => {
  it('splits a reply at its quote when the quote is at the top level', () => {
    expect(splitQuote('<p></p><p>On Nov 10, Bo wrote:</p><blockquote><p>Lunch?</p></blockquote>')).toEqual({ head: '<p></p>', quote: '<p>On Nov 10, Bo wrote:</p><blockquote><p>Lunch?</p></blockquote>' });
  });
  it('does not split a quote nested in a wrapper, or a message without one', () => {
    expect(splitQuote('<div><p>Hi</p><div class="gmail_quote">Lunch?</div></div>')).toBeNull();
    expect(splitQuote('<p>Hi</p>')).toBeNull();
  });
});

describe('quoteText', () => {
  it('renders quoted HTML as text with a blank line between blocks', () => {
    expect(quoteText('<p>On Nov 10, Bo wrote:</p><blockquote><p>Lunch?<br>Noon</p></blockquote>')).toBe('On Nov 10, Bo wrote:\n\nLunch?\nNoon');
  });
});

describe('splitQuotedText', () => {
  it('splits plain text at the attribution line above the ">" lines', () => {
    expect(splitQuotedText('Yes.\n\nOn Mon, Bo wrote:\n> Lunch?\n> Noon')).toEqual({ head: 'Yes.', quote: 'On Mon, Bo wrote:\n> Lunch?\n> Noon' });
    expect(splitQuotedText('Yes.\n> Lunch?')).toEqual({ head: 'Yes.', quote: '> Lunch?' });
  });
  it('returns null with no quote, or nothing before it', () => {
    expect(splitQuotedText('Yes.\nSee you.')).toBeNull();
    expect(splitQuotedText('> Lunch?\n> Noon')).toBeNull();
    expect(splitQuotedText('On Mon, Bo wrote:\n> Lunch?')).toBeNull();
  });
});
