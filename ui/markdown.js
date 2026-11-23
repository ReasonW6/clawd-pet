// Markdown in the chat's replies (pet.js), for what a model puts in a short reply
// rather than all of CommonMark: paragraphs, headings, lists, quotes, code, tables,
// links, bold / italic / struck text and formulas. Everything is escaped first and only
// the tags made here come out, since a reply may echo what a web page said; links go
// out only as http(s) or mailto, and images only as links, never loaded. **Bold**
// also closes next to Chinese punctuation, where CommonMark would leave the stars.
//
// Formulas ($…$, $$…$$, \(…\), \[…\]) go through KaTeX (vendor/katex), loaded the
// first time one turns up, as MathML: the WebView draws that with the system's math
// font, so no stylesheet or fonts come with it.
//
// A plain script like the others: it defines window.renderMarkdown.

(function () {
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ESC[c]);

  // ---- formulas

  let katex = null;
  let katexState = "none"; // "loading", "ready" or "failed"
  /** Called once KaTeX is in, to draw again what showed formulas as source meanwhile. */
  const waiting = new Set();
  const drawn = new Map(); // (display ? "d" : "i") + source -> html

  function loadKatex() {
    if (katexState !== "none") return;
    katexState = "loading";
    const script = document.createElement("script");
    script.src = "vendor/katex/katex.min.js";
    script.onload = () => {
      katex = window.katex;
      katexState = katex ? "ready" : "failed";
      for (const f of waiting) f();
      waiting.clear();
    };
    script.onerror = () => {
      katexState = "failed";
      waiting.clear();
    };
    document.head.append(script);
  }

  function math(tex, display, onReady) {
    const source = () => `<code class="tex">${esc(display ? `$$${tex}$$` : `$${tex}$`)}</code>`;
    if (katexState !== "ready") {
      if (katexState !== "failed") {
        if (onReady) waiting.add(onReady);
        loadKatex();
      }
      return source();
    }
    const key = (display ? "d" : "i") + tex;
    let html = drawn.get(key);
    if (html === undefined) {
      try {
        // trust: false (the default) keeps \href, \url and the like out.
        html = katex.renderToString(tex.trim(), { displayMode: display, output: "mathml", throwOnError: false, strict: "ignore", maxSize: 10, maxExpand: 200 });
      } catch {
        html = source();
      }
      if (drawn.size > 300) drawn.clear();
      drawn.set(key, html);
    }
    return html;
  }

  // ---- inline

  const SAFE_URL = /^(https?:\/\/|mailto:)/i;
  /** What usually ends a sentence rather than a bare link. */
  const URL_TAIL = new Set(".,;:!?'\"。，、；：！？）」』】》*_");
  /** Text that reads as a formula, not as \(…\) or \[…\] in a regex or a path. */
  const TEXY = /[\\^_{}=+<>\s]/;
  const PLACEHOLDER = /\u0000/;
  /** A line longer than this shows as plain text: some of the marks' patterns take
   *  the square of a line's length when left open, and a reply is drawn every frame. */
  const MAX_LINE = 4000;

  /** A bare link without what follows it: the end of the sentence, the bold or italic
   *  marks round it, or a ")" it doesn't open. */
  function bareUrl(url) {
    let end = url.length;
    let open = 0;
    for (const c of url) open += c === "(" ? 1 : c === ")" ? -1 : 0;
    for (;;) {
      const c = url[end - 1];
      if (c === ")" && open < 0) open++;
      else if (!URL_TAIL.has(c)) break;
      end--;
    }
    return url.slice(0, end);
  }

  /**
   * One line of text, with its marks turned into tags. `kept` is shared with the call
   * this one is for a link's text in, whose placeholders that text may carry; `inLink`
   * keeps bare links out of a link's text.
   */
  function inline(text, onReady, kept = [], inLink = false) {
    // Bits already turned into HTML wait behind a marker that escaping leaves alone
    // (renderMarkdown takes any such marker out of the source first).
    const keep = (html) => `\u0000${kept.push(html) - 1}\u0000`;
    if (text.length > MAX_LINE) return esc(text);
    // A formula with code in it, or a link with a marker in its address, stays text.
    const formula = (display, test) => (m, tex) => (PLACEHOLDER.test(tex) || (test && !TEXY.test(tex)) ? m : keep(math(tex, display, onReady)));
    let s = text;
    s = s.replace(/(`+)([\s\S]+?)\1(?!`)/g, (_, __, code) => keep(`<code>${esc(code)}</code>`));
    s = s.replace(/\\\$/g, () => keep("$"));
    s = s.replace(/\$\$([\s\S]+?)\$\$/g, formula(true));
    s = s.replace(/\\\(([\s\S]+?)\\\)/g, formula(false, true));
    s = s.replace(/\\\[([\s\S]+?)\\\]/g, formula(true, true));
    // $…$ that doesn't start or end in a space, nor runs into a Latin letter or digit on
    // either side: "$5 and $10" stays money, and "$PATH:$HOME" a path; Chinese text
    // right next to a formula is usual.
    s = s.replace(/(?<![A-Za-z0-9])\$([^\s$](?:[^$\n]*?[^\s$\\])?)\$(?![A-Za-z0-9])/g, formula(false));
    // Backslash escapes. Not "(" and ")", which only escape as formula delimiters:
    // "\(^o^)/" is a face. Marks that only mean something at the start of a line only
    // escape there, so a path keeps its "\.".
    s = s.replace(/^(\s*\d*)\\([#+\-.>!])/, (_, lead, c) => lead + keep(esc(c)));
    s = s.replace(/\\([\\`*_{}[\]~|]|!(?=\[))/g, (_, c) => keep(esc(c)));
    const url = String.raw`((?:[^\s()\u0000]|\([^\s()\u0000]*\))+)(?:\s+"[^"\n]*")?\)`;
    s = s.replace(new RegExp(String.raw`!\[([^\[\]\n]{0,300})\]\(` + url, "g"), (_, alt, href) => keep(link(href, esc(`🖼 ${alt || "图片"}`))));
    s = s.replace(new RegExp(String.raw`\[([^\[\]\n]{1,300})\]\(` + url, "g"), (_, label, href) => keep(link(href, inline(label, onReady, kept, true))));
    if (!inLink) {
      s = s.replace(/<((?:https?:\/\/|mailto:)[^\s<>\u0000]+)>/gi, (_, href) => keep(link(href, esc(href))));
      // Chinese text and full-width punctuation right after a link aren't part of it.
      s = s.replace(/https?:\/\/[^\s<>"'\u0000\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]+/gi, (found) => {
        const bare = bareUrl(found);
        return keep(link(bare, esc(bare))) + found.slice(bare.length);
      });
    }
    s = esc(s);
    // Letters and digits of any script count as part of a word round underscores.
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\p{L}\p{N}_])__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}_])/gu, "$1<strong>$2</strong>");
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
    // Faces: a "*" right inside brackets isn't emphasis ("(*^▽^*)"), and "_" only
    // emphasises text that starts and ends with a letter or digit ("_(:з」∠)_", "^_^").
    s = s.replace(/(^|[^\w*(（])\*([^\s*)）](?:[^*\n]*?[^\s*(（])?)\*(?![\w*)）])/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^\p{L}\p{N}_])_([\p{L}\p{N}\u0000](?:[^_\n]*?[\p{L}\p{N}\u0000])?)_(?![\p{L}\p{N}_])/gu, "$1<em>$2</em>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[i]);
  }

  function link(url, label) {
    if (!SAFE_URL.test(url)) return label;
    return `<a href="${esc(url)}" title="${esc(url)}">${label}</a>`;
  }

  // ---- blocks

  const FENCE = /^ {0,3}(`{3,}|~{3,})/;
  const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
  const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  // ">" then a space, another ">" or nothing: ">_<" starts a line, not a quote.
  const QUOTE = /^ {0,3}>(?=\s|>|$)\s?(.*)$/;
  const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;
  const MATH_OPEN = /^\s*(\$\$|\\\[)(.*)$/;
  const TABLE_RULE = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/;
  /** Quotes and lists inside each other this deep are shown as plain text. */
  const MAX_DEPTH = 12;

  /** A row's cells; "\|" is a "|" inside one (inline() drops the backslash). */
  const cellsOf = (l) => l.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/);
  /** A table's header: its next line is a rule with as many columns. */
  const isTable = (line, next) => line.includes("|") && TABLE_RULE.test(next.trim()) && cellsOf(line).length === cellsOf(next).length;
  const width = (s) => s.replace(/\t/g, "    ").length;
  /** `line` without up to `n` columns of its indent. */
  function dedent(line, n) {
    let i = 0;
    for (let col = 0; i < line.length && col < n && /[ \t]/.test(line[i]); i++) col += line[i] === "\t" ? 4 : 1;
    return line.slice(i);
  }

  function blocks(lines, onReady, depth = 0) {
    let out = "";
    let para = [];
    const flush = () => {
      if (para.length) out += `<p>${para.map((l) => inline(l, onReady)).join("<br>")}</p>`;
      para = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      if (!line.trim()) {
        flush();
      } else if ((m = FENCE.exec(line))) {
        // Runs to its closing fence, or to the end while the reply is still coming.
        flush();
        const close = new RegExp(`^ {0,3}\\${m[1][0]}{${m[1].length},}\\s*$`);
        const code = [];
        for (i++; i < lines.length && !close.test(lines[i]); i++) code.push(lines[i]);
        out += `<pre><code>${esc(code.join("\n"))}</code></pre>`;
      } else if ((m = MATH_OPEN.exec(line)) && (m = displayMath(lines, i, m))) {
        flush();
        out += `<div class="math">${math(m.tex, true, onReady)}</div>`;
        i = m.end;
      } else if ((m = HEADING.exec(line))) {
        flush();
        out += `<div class="h h${m[1].length}">${inline(headingText(m[2]), onReady)}</div>`;
      } else if (RULE.test(line)) {
        flush();
        out += "<hr>";
      } else if (depth < MAX_DEPTH && QUOTE.test(line)) {
        flush();
        const quoted = [];
        for (; i < lines.length && (m = QUOTE.exec(lines[i])); i++) quoted.push(m[1]);
        i--;
        out += `<blockquote>${blocks(quoted, onReady, depth + 1)}</blockquote>`;
      } else if (depth < MAX_DEPTH && ITEM.test(line)) {
        flush();
        i = items(lines, i, (html) => (out += html), onReady, depth);
      } else if (isTable(line, lines[i + 1] || "")) {
        flush();
        const cells = (l) => cellsOf(l).map((c) => inline(c.trim(), onReady));
        let t = `<div class="table"><table><thead><tr>${cells(line).map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>`;
        for (i += 2; i < lines.length && lines[i].includes("|"); i++) t += `<tr>${cells(lines[i]).map((c) => `<td>${c}</td>`).join("")}</tr>`;
        i--;
        out += `${t}</tbody></table></div>`;
      } else {
        para.push(line);
      }
    }
    flush();
    return out;
  }

  /** A heading's text without the "#"s that may close it. By hand: a regex for the
   *  closing marks tries a long run of spaces or "#"s again from each of its starts. */
  function headingText(t) {
    t = t.trimEnd();
    let end = t.length;
    while (end > 0 && t[end - 1] === "#") end--;
    if (end === t.length || (end > 0 && !/\s/.test(t[end - 1]))) return t;
    return t.slice(0, end).trimEnd();
  }

  /** A formula on lines of its own from `lines[i]` on, or null (also while it isn't closed yet). */
  function displayMath(lines, i, open) {
    const close = open[1] === "$$" ? "$$" : "\\]";
    let rest = open[2];
    const body = [];
    for (let j = i; j < lines.length; j++) {
      if (j > i) rest = lines[j];
      const at = rest.indexOf(close);
      if (at < 0) {
        body.push(rest);
        continue;
      }
      // Text after it on the same line: a formula inside a paragraph, for inline() to take.
      if (rest.slice(at + close.length).trim()) return null;
      body.push(rest.slice(0, at));
      return { tex: body.join("\n"), end: j };
    }
    return null;
  }

  /**
   * The list starting at `lines[i]`; returns the index of its last line. An item takes
   * the indented lines under it, without the indent its text has, and draws them as
   * blocks of their own: code, formulas, tables and quotes inside an item stay what
   * they are. A fence inside an item runs to its close whatever is in it.
   */
  function items(lines, i, emit, onReady, depth) {
    const found = [];
    let m;
    for (; i < lines.length; i++) {
      const l = lines[i];
      if ((m = ITEM.exec(l))) {
        const indent = width(m[1]);
        found.push({ indent, marker: m[2], col: indent + m[2].length + width(m[3]), lines: [m[4]] });
      } else if (l.trim() && /^\s/.test(l)) {
        const it = found.at(-1);
        const body = dedent(l, it.col);
        it.lines.push(body);
        const fence = FENCE.exec(body);
        if (fence) {
          const close = new RegExp(`^ {0,3}\\${fence[1][0]}{${fence[1].length},}\\s*$`);
          for (i++; i < lines.length; i++) {
            const inner = dedent(lines[i], it.col);
            it.lines.push(inner);
            if (close.test(inner)) break;
          }
        }
      } else if (!l.trim()) {
        const next = lines[i + 1] || "";
        if (ITEM.test(next)) continue; // a gap between items
        if (next.trim() && /^\s/.test(next)) found.at(-1).lines.push(""); // a gap inside one
        else break;
      } else {
        break;
      }
    }
    emit(list(found, onReady, depth));
    return i - 1;
  }

  /** List items, nested by how far each is indented compared with the one before. */
  function list(items, onReady, depth) {
    let html = "";
    const open = []; // { indent, tag }
    for (const it of items) {
      const tag = /\d/.test(it.marker) ? "ol" : "ul";
      while (open.length && it.indent < open.at(-1).indent) html += `</li></${open.pop().tag}>`;
      // A bulleted item at the same indent as a numbered one, or the other way round,
      // starts a list of its own, as in CommonMark.
      if (open.length && it.indent === open.at(-1).indent && open.at(-1).tag !== tag) html += `</li></${open.pop().tag}>`;
      if (!open.length || it.indent > open.at(-1).indent) {
        const n = parseInt(it.marker, 10);
        html += `<${tag}${tag === "ol" && n !== 1 ? ` start="${n}"` : ""}>`;
        open.push({ indent: it.indent, tag });
      } else {
        html += "</li>";
      }
      // Text right after the marker reads on from it rather than as a paragraph.
      html += `<li>${blocks(it.lines, onReady, depth + 1).replace(/^<p>([\s\S]*?)<\/p>/, "$1")}`;
    }
    while (open.length) html += `</li></${open.pop().tag}>`;
    return html;
  }

  /** `onReady`: called once if formulas showed as source while KaTeX loads, to draw again.
   *  A NUL in the source would pass for inline()'s marker, so none is let in. */
  window.renderMarkdown = (src, onReady) => blocks(src.replace(/\u0000/g, "\uFFFD").replace(/\r\n?/g, "\n").split("\n"), onReady);
})();
