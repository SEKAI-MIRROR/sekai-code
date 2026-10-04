// Pi dark theme and Markdown token mapping. Copyright (c) 2025 Mario Zechner,
// MIT; adapted for Sekai's theme lifecycle. See NOTICE.
import { readFileSync } from 'node:fs';
import { parseColor, foregroundAnsi, backgroundAnsi, styleTextWithAnsi, getTerminalColorMode } from '@earendil-works/pi-tui';
import { highlight, supportsLanguage } from './syntax-highlight.mjs';

const data = JSON.parse(readFileSync(new URL('./dark.json', import.meta.url), 'utf8'));
const colors = Object.fromEntries(Object.entries(data.colors).map(([name, value]) => [name, parseColor(data.vars[value] || value)]));
const mode = getTerminalColorMode();
const plain = () => process.env.NO_COLOR !== undefined;
export const fg = name => text => plain() ? String(text) : styleTextWithAnsi(String(text), foregroundAnsi(colors[name], mode), undefined, {});
export const bg = name => text => plain() ? String(text) : styleTextWithAnsi(String(text), undefined, backgroundAnsi(colors[name], mode), {});
const attr = attribute => text => plain() ? String(text) : styleTextWithAnsi(String(text), undefined, undefined, { [attribute]: true });
export const ink = { accent: fg('accent'), muted: fg('muted'), dim: fg('dim'), text: fg('text'), purple: fg('mdCode'), green: fg('success'), red: fg('error'), yellow: fg('warning'), bold: attr('bold'), italic: attr('italic') };
export const selectTheme = { selectedPrefix: fg('accent'), selectedText: fg('accent'), description: fg('muted'), scrollInfo: fg('muted'), noMatch: fg('muted') };
const syntax = Object.fromEntries(Object.entries({ keyword: 'syntaxKeyword', built_in: 'syntaxType', literal: 'syntaxNumber', number: 'syntaxNumber', regexp: 'syntaxString', string: 'syntaxString', comment: 'syntaxComment', doctag: 'syntaxComment', meta: 'muted', function: 'syntaxFunction', title: 'syntaxFunction', class: 'syntaxType', type: 'syntaxType', tag: 'syntaxPunctuation', name: 'syntaxKeyword', attr: 'syntaxVariable', variable: 'syntaxVariable', params: 'syntaxVariable', operator: 'syntaxOperator', punctuation: 'syntaxPunctuation', addition: 'toolDiffAdded', deletion: 'toolDiffRemoved' }).map(([scope, token]) => [scope, fg(token)]));
Object.assign(syntax, { emphasis: ink.italic, strong: ink.bold, link: attr('underline') });
export const markdownTheme = {
 ...Object.fromEntries(Object.entries({ heading: 'mdHeading', link: 'mdLink', linkUrl: 'mdLinkUrl', code: 'mdCode', codeBlock: 'mdCodeBlock', codeBlockBorder: 'mdCodeBlockBorder', quote: 'mdQuote', quoteBorder: 'mdQuoteBorder', hr: 'mdHr', listBullet: 'mdListBullet' }).map(([name, token]) => [name, fg(token)])),
 bold: ink.bold, italic: ink.italic, underline: attr('underline'), strikethrough: attr('strikethrough'),
 highlightCode(code, language) {
  if (!language || !supportsLanguage(language)) return code.split('\n').map(fg('mdCodeBlock'));
  try { return highlight(code, { language, ignoreIllegals: true, theme: syntax }).split('\n'); }
  catch { return code.split('\n').map(fg('mdCodeBlock')); }
 },
};
