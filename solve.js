// fast-sitegen: a faster drop-in for makefun-site 1.0.0.
//
// It answers exactly as makefun-site does on every input (same front matter,
// template dialect, Markdown subset, slug rule and report), but builds the
// answer with a single-pass Markdown scan that writes HTML straight out
// (no token objects), an inline scanner that escapes whole runs at once,
// templates compiled to plain functions, and a few per-case caches. Every
// cache lives inside one run() call: nothing is carried from one case to
// the next, and a build reads no clock, environment, randomness or file.

/** Code-unit order, never the locale's. */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------ text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped, in one pass. */
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/**
 * The slug of `text` for a string holding a character outside ASCII: NFKD,
 * combining marks dropped, then the same walk as the fast path.
 */
function slugifySlow(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/**
 * The slug of `text`: for ASCII it is its own walk (NFKD is the identity
 * there, and no combining mark can occur); anything else takes the slow path.
 * A-Z lowered, each run of characters other than a-z and 0-9 one "-", none at
 * either end, at most 64 characters (a "-" left at the cut dropped), and
 * "untitled" when nothing is left.
 */
function slugifyRaw(text) {
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 127) return slugifySlow(text);
    let k = 0;
    if (c >= 65 && c <= 90) k = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) k = c;
    else {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += String.fromCharCode(k);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** Whether `ch` is whitespace in JavaScript's sense (what \s matches). */
function isWS(ch) {
  const c = ch.charCodeAt(0);
  return (
    c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws =
      c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
      c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
      c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ------------------------------------------------------------------ front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Whether `s` holds only spaces and tabs (or is empty). */
function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ' ' && s[i] !== '\t') return false;
  }
  return true;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether `s` is a date YYYY-MM-DD, a real day from 1970-01-01 to 2099-12-31. */
function isDate(s) {
  if (s.length !== 10 || s[4] !== '-' || s[7] !== '-') return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  return y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
}

/** Whether `s` is a template name: a-z, 0-9 and -, at least one character. */
function isName(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `s` is a slug: a-z and 0-9, single - between, at most 64 characters. */
function isSlugValue(s) {
  if (s.length === 0 || s.length > 64) return false;
  let prevDash = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else return false;
  }
  return !prevDash;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return isDate(raw) ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let k = 0; k < tags.length; k++) {
        const t = tags[k].trim();
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t[i];
          if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags[k] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlugValue(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The lines are walked
 * with indexOf, never split into an array.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // Find the closing line, the next line that is exactly "---".
  let pos = 4;
  let closeStart = -1;
  let closeEnd = -1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    if (lineEnd - pos === 3 && text[pos] === '-' && text[pos + 1] === '-' && text[pos + 2] === '-') {
      closeStart = pos;
      closeEnd = lineEnd;
      break;
    }
    if (nl === -1) break;
    pos = lineEnd + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 1;
  pos = 4;
  while (pos < closeStart) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? closeStart : Math.min(nl, closeStart);
    lineNo++;
    const line = text.slice(pos, lineEnd);
    if (!isBlankLine(line) && line[0] !== '#') {
      // A "key: value" line: a key of a-z and _, a colon, one space and the value.
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if (!((c >= 97 && c <= 122) || c === 95)) break;
        k++;
      }
      if (k === 0 || line[k] !== ':') return { error: `line ${lineNo} is not "key: value"` };
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line[k + 1] === ' ') raw = line.slice(k + 2);
      else return { error: `line ${lineNo} is not "key: value"` };
      raw = raw.replace(/[ \t]+$/, '');
      const key = line.slice(0, k);
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    pos = lineEnd + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd < text.length ? text.slice(closeEnd + 1) : '' };
}

// ------------------------------------------------------------------ markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** A line of spaces and tabs only, or empty. */
function isBlank(s) {
  for (let i = 0; i < s.length; i++) if (s[i] !== ' ' && s[i] !== '\t') return false;
  return true;
}

/** A line trimmed of spaces and tabs at both ends (itself, when there is nothing to trim). */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/**
 * A fence opening line, or null: three backticks and an optional language
 * (A-Z, a-z, 0-9, _, +, -), then spaces or tabs only. The language, or "".
 */
function fenceOpen(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let i = 3;
  let lang = '';
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) {
      lang += line[i];
      i++;
    } else break;
  }
  while (i < line.length) {
    if (line[i] !== ' ' && line[i] !== '\t') return null;
    i++;
  }
  return lang;
}

/** A fence closing line: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let i = 3; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return false;
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n === 0 || n > 6) return null;
  let i = n;
  if (i >= line.length || (line[i] !== ' ' && line[i] !== '\t')) return null;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  let end = line.length;
  while (end > i && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  if (end === i) return null;
  return { depth: n, text: line.slice(i, end) };
}

/** A thematic break: "---" or "***", then spaces or tabs only. */
function isHR(line) {
  if (line.length < 3) return false;
  const m = line[0] === '-' && line[1] === '-' && line[2] === '-';
  const s = line[0] === '*' && line[1] === '*' && line[2] === '*';
  if (!m && !s) return false;
  for (let i = 3; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return false;
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line, fence, heading) {
  return isBlank(line) || fence !== null || heading !== null || isHR(line);
}

/** A bullet item's text, or null: "- " or "* " and what follows. */
function bulletOf(line) {
  if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return line.slice(2);
  return null;
}

/** An ordered item's number and text, or null: 1 to 9 digits, ". " and what follows. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  if (i === 0 || i > 9) return null;
  if (line[i] !== '.' || line[i + 1] !== ' ') return null;
  return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** A list continuation: two or more spaces, then a character other than whitespace. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i >= 2 && i < line.length && !isWS(line[i]);
}

/** The next "**" from `from` outside a backslash escape, within `end`, or -1. */
function findDoubleStar(s, from, end) {
  let j = from;
  while (j + 2 <= end) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j += 2;
      continue;
    }
    if (s[j] === '*' && s[j + 1] === '*') return j;
    j++;
  }
  return -1;
}

/** The next single "*" from `from` (one whose run is not "**"), outside an escape, within `end`, or -1. */
function findSingleStar(s, from, end) {
  let j = from;
  while (j < end) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j += 2;
      continue;
    }
    if (c !== '*') {
      j++;
      continue;
    }
    if (j + 1 < end && s[j + 1] === '*') {
      j += 2;
      continue;
    }
    return j;
  }
  return -1;
}

/** The next `ch` from `from` outside a backslash escape, within `end`, or -1. */
function findUnescapedChar(s, ch, from, end) {
  let j = from;
  while (j < end) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j += 2;
      continue;
    }
    if (s[j] === ch) return j;
    j++;
  }
  return -1;
}

/**
 * `s` from `a` to `b` rendered inline, appended to `parts`. `env.link(target)`
 * is a link's href. Plain runs are escaped whole, so a paragraph of plain
 * text costs one escape pass instead of one per character.
 */
function inlineInto(s, a, b, env, parts) {
  let i = a;
  let run = a;
  const flush = (to) => {
    if (to > run) parts.push(escapeHtml(s.slice(run, to)));
  };
  while (i < b) {
    const c = s[i];
    if (c === '\\' && i + 1 < b && ESCAPABLE.has(s[i + 1])) {
      flush(i);
      parts.push(ESCAPES[s[i + 1]] ?? s[i + 1]);
      i += 2;
      run = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) {
        flush(i);
        parts.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (i + 1 < b && s[i + 1] === '*') {
        const j = findDoubleStar(s, i + 2, b);
        if (j !== -1 && j > i + 2) {
          flush(i);
          parts.push('<strong>');
          inlineInto(s, i + 2, j, env, parts);
          parts.push('</strong>');
          i = j + 2;
          run = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, b);
      if (j !== -1 && j > i + 1) {
        flush(i);
        parts.push('<em>');
        inlineInto(s, i + 1, j, env, parts);
        parts.push('</em>');
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescapedChar(s, ']', i + 1, b);
      let m = -1;
      if (k !== -1 && k + 1 < b && s[k + 1] === '(') {
        m = s.indexOf(')', k + 2);
        if (m === -1 || m >= b) m = -1;
      }
      if (m !== -1) {
        const target = s.slice(k + 2, m);
        if (target !== '' && !/\s/.test(target)) {
          flush(i);
          parts.push('<a href="', escapeHtml(env.link(target)), '">');
          inlineInto(s, i + 1, k, env, parts);
          parts.push('</a>');
          i = m + 1;
          run = i;
          continue;
        }
      }
      i++;
      continue;
    }
    i++;
  }
  flush(b);
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inlineStr(s, env) {
  const parts = [];
  inlineInto(s, 0, s.length, env, parts);
  return parts.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and
 * its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * Blocks are scanned line by line and written straight out, with no tokens.
 */
function renderMarkdown(src, env, slugify) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = '';
  let hasExcerpt = false;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = fenceOpen(line);
    if (fence !== null) {
      i++;
      const body = [];
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      // Escaping the body whole is the same as escaping each line: the
      // escape table never touches "\n", and each line gains one after it.
      blocks.push(`<pre><code${fence === '' ? '' : ` class="language-${escapeHtml(fence)}"`}>${body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inlineStr(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line[0] === '>') {
      const qlines = [];
      while (i < n && lines[i][0] === '>') {
        let l = lines[i].slice(1);
        if (l[0] === ' ') l = l.slice(1);
        l = trimLine(l);
        if (l !== '') qlines.push(l);
        i++;
      }
      blocks.push(qlines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(qlines.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      const start = isOrdered ? ordered.num : 1;
      while (i < n) {
        if (isOrdered) {
          const m = orderedOf(lines[i]);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            i++;
            continue;
          }
        } else {
          const m = bulletOf(lines[i]);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
            continue;
          }
        }
        if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let block = `${open}\n`;
      for (const item of items) block += `<li>${inlineStr(item.join('\n'), env)}</li>\n`;
      block += `</${tag}>`;
      blocks.push(block);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n) {
      const l = lines[i];
      if (endsParagraph(l, fenceOpen(l), headingOf(l))) break;
      body.push(trimLine(l));
      i++;
    }
    const html = inlineStr(body.join('\n'), env);
    if (!hasExcerpt) {
      excerpt = html;
      hasExcerpt = true;
    }
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt };
}

// ------------------------------------------------------------------ templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = /^if (not )?(\S+)$/.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = /^include "([a-z0-9-]+)"$/.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * A template's node tree compiled to a function (scope, depth) => string.
 * The tree is walked once, at compile time; a render is plain string building
 * with direct loops, and a for loop reuses one frame and one loop object,
 * mutating them per element instead of allocating a scope per element.
 */
function compileTemplate(nodes, R) {
  const paths = [];
  let uid = 0;
  const pathConst = (path) => {
    const idx = paths.length;
    paths.push(JSON.stringify(path));
    return `P${idx}`;
  };
  const gen = (list, scope, code) => {
    for (const n of list) {
      if (n.kind === 'text') code.push(`o.push(${JSON.stringify(n.text)});`);
      else if (n.kind === 'var') code.push(`o.push(E(W(G(${scope},${pathConst(n.path)}))));`);
      else if (n.kind === 'raw') code.push(`o.push(W(G(${scope},${pathConst(n.path)})));`);
      else if (n.kind === 'if') {
        code.push(`if(${n.not ? '!' : ''}TR(G(${scope},${pathConst(n.path)}))){`);
        gen(n.then, scope, code);
        code.push('}');
        if (n.else !== null) {
          code.push('else{');
          gen(n.else, scope, code);
          code.push('}');
        }
      } else if (n.kind === 'for') {
        const u = uid++;
        const fs = `F${u}`;
        code.push(`{const _x${u}=G(${scope},${pathConst(n.path)});if(Array.isArray(_x${u})){const ${fs}={vars:{},parent:${scope}};const _l${u}={index:0,first:false,last:false,length:_x${u}.length};${fs}.vars["loop"]=_l${u};for(let _k${u}=0;_k${u}<_x${u}.length;_k${u}++){${fs}.vars[${JSON.stringify(n.name)}]=_x${u}[_k${u}];_l${u}.index=_k${u}+1;_l${u}.first=_k${u}===0;_l${u}.last=_k${u}===_x${u}.length-1;`);
        gen(n.body, fs, code);
        code.push('}}}');
      } else if (n.kind === 'include') {
        code.push(`if(D<${INCLUDE_DEPTH}){const _t=T.get(${JSON.stringify(n.name)});if(_t!==undefined)_t(${scope},D+1,o);}`);
      }
    }
  };
  const code = [];
  gen(nodes, 'S', code);
  const src = 'const {T,E,W,G,TR}=R;' + paths.map((p, k) => `const P${k}=${p};`).join('') + 'return function(S,D,o){' + code.join('') + '}';
  return new Function('R', src)(R);
}

// ------------------------------------------------------------------ the build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `target` opens with a scheme (`https:`, `mailto:` ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const base = input.site.base_url.replace(/\/+$/, '');
  const report = [];

  // Per-case caches: a slug per distinct text, and a resolved link per
  // (source directory, target) that names a page or a static file. A broken
  // link is never cached: its report names its own source.
  const slugCache = new Map();
  const slugify = (t) => {
    const hit = slugCache.get(t);
    if (hit !== undefined) return hit;
    const s = slugifyRaw(t);
    slugCache.set(t, s);
    return s;
  };
  const linkCache = new Map();

  // Templates, parsed in code-unit order of their name; one that does not
  // parse is reported and left out, as if it were not there.
  const compiled = new Map();
  const R = { T: compiled, E: escapeHtml, W: textOf, G: lookup, TR: truthy };
  for (const name of Object.keys(input.templates).sort()) {
    try {
      compiled.set(name, compileTemplate(parseTemplate(name, input.templates[name]), R));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // Sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, then each page's directory and url: its slug made unique
  // in its directory, in source order. The checks run in the reference order,
  // and the first one that fails is the one reported.
  const kept = [];
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!compiled.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    kept.push(s);
  }

  const bySource = new Map();
  for (const s of kept) bySource.set(s.path, s);
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();

  // Each body's Markdown, its links resolved to the pages and static files they name.
  for (const s of kept) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const link = (target) => {
      if (hasScheme(target) || target[0] === '/' || target[0] === '#') return target;
      const key = `${dir}\u0000${target}`;
      const hit = linkCache.get(key);
      if (hit !== undefined) return hit;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      let out;
      if (path !== null && bySource.has(path)) out = `${bySource.get(path).url}${frag}`;
      else if (path !== null && staticPaths.has(path)) out = `${base}/${path}${frag}`;
      else {
        broken.add(`broken-link ${srcPath} -> ${target}`);
        return target;
      }
      linkCache.set(key, out);
      return out;
    };
    const md = renderMarkdown(s.body, { link }, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = wordsOf(s.body);
  }

  // The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // A page's link record, a tag, a post's card and a page, as templates read them.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });

  // Every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fn = compiled.get(name);
    if (fn === undefined) return null;
    const o = [];
    fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, 0, o);
    return o.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort();
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
