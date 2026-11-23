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
  const URL_TAIL = /[.,;:!?'"。，、；：！？）」』】》]+$/;

  /** One line of text, with its marks turned into tags. */
  function inline(text, onReady) {
    const kept = [];
    // Bits already turned into HTML wait behind a marker that escaping leaves alone.
    const keep = (html) => `\u0000${kept.push(html) - 1}\u0000`;
    let s = text;
    s = s.replace(/(`+)([\s\S]+?)\1(?!`)/g, (_, __, code) => keep(`<code>${esc(code)}</code>`));
    s = s.replace(/\\\$/g, () => keep("$"));
    s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => keep(math(tex, true, onReady)));
    s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => keep(math(tex, false, onReady)));
    s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => keep(math(tex, true, onReady)));
    // $…$ that doesn't start or end in a space, nor run into a digit: "$5 and $10" stays money.
    s = s.replace(/\$([^\s$](?:[^$\n]*?[^\s$\\])?)\$(?!\d)/g, (_, tex) => keep(math(tex, false, onReady)));
    s = s.replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, (_, c) => keep(esc(c)));
    s = s.replace(/!\[([^\]\n]*)\]\((\S+?)(?:\s+"[^"]*")?\)/g, (_, alt, url) => keep(link(url, esc(`🖼 ${alt || "图片"}`))));
    s = s.replace(/\[([^\]\n]+)\]\((\S+?)(?:\s+"[^"]*")?\)/g, (_, label, url) => keep(link(url, inline(label, onReady))));
    s = s.replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/gi, (_, url) => keep(link(url, esc(url))));
    s = s.replace(/https?:\/\/[^\s<>"'\u0000]+/gi, (url) => {
      const tail = (URL_TAIL.exec(url) || [""])[0];
      const bare = url.slice(0, url.length - tail.length);
      return keep(link(bare, esc(bare))) + tail;
    });
    s = esc(s);
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>");
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
    s = s.replace(/(^|[^\w*])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?![\w*])/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^\w])_([^\s_](?:[^_\n]*?[^\s_])?)_(?!\w)/g, "$1<em>$2</em>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[i]);
  }

  function link(url, label) {
    if (!SAFE_URL.test(url)) return label;
    return `<a href="${esc(url)}" title="${esc(url)}">${label}</a>`;
  }

  // ---- blocks

  const FENCE = /^ {0,3}(`{3,}|~{3,})/;
  const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
  const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const QUOTE = /^ {0,3}>\s?(.*)$/;
  const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const MATH_OPEN = /^\s*(\$\$|\\\[)(.*)$/;
  const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

  function blocks(lines, onReady) {
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
        out += `<div class="h h${m[1].length}">${inline(m[2], onReady)}</div>`;
      } else if (RULE.test(line)) {
        flush();
        out += "<hr>";
      } else if (QUOTE.test(line)) {
        flush();
        const quoted = [];
        for (; i < lines.length && (m = QUOTE.exec(lines[i])); i++) quoted.push(m[1]);
        i--;
        out += `<blockquote>${blocks(quoted, onReady)}</blockquote>`;
      } else if (ITEM.test(line)) {
        flush();
        const items = [];
        for (; i < lines.length; i++) {
          const l = lines[i];
          if ((m = ITEM.exec(l))) items.push({ indent: m[1].replace(/\t/g, "    ").length, marker: m[2], lines: [m[3]] });
          else if (l.trim() && /^\s/.test(l)) items.at(-1).lines.push(l.trim()); // carries on the item
          else if (!l.trim() && ITEM.test(lines[i + 1] || "")) continue; // a gap between items
          else break;
        }
        i--;
        out += list(items, onReady);
      } else if (line.includes("|") && TABLE_RULE.test(lines[i + 1] || "")) {
        flush();
        const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => inline(c.trim(), onReady));
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

  /** List items, nested by how far each is indented compared with the one before. */
  function list(items, onReady) {
    let html = "";
    const open = []; // { indent, tag }
    for (const it of items) {
      const tag = /\d/.test(it.marker) ? "ol" : "ul";
      while (open.length && it.indent < open.at(-1).indent) html += `</li></${open.pop().tag}>`;
      if (!open.length || it.indent > open.at(-1).indent) {
        const n = parseInt(it.marker, 10);
        html += `<${tag}${tag === "ol" && n !== 1 ? ` start="${n}"` : ""}>`;
        open.push({ indent: it.indent, tag });
      } else {
        html += "</li>";
      }
      html += `<li>${it.lines.map((l) => inline(l, onReady)).join("<br>")}`;
    }
    while (open.length) html += `</li></${open.pop().tag}>`;
    return html;
  }

  /** `onReady`: called once if formulas showed as source while KaTeX loads, to draw again. */
  window.renderMarkdown = (src, onReady) => blocks(src.replace(/\r\n?/g, "\n").split("\n"), onReady);
})();
