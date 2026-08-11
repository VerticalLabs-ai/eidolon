// Lightweight regex-based syntax highlighter for the CodeEditor (M6).
//
// No external dependency — tokenizes JavaScript/TypeScript/Python source into
// colored <span>s for keywords, strings, comments, numbers, and function
// names. The result is rendered behind a transparent <textarea> so the user
// edits the textarea while seeing the highlighted overlay (a common minimal
// pattern). Highlighting is best-effort and cosmetic; it never alters the
// buffer.

import { useMemo } from "react";

interface Token {
  type: "keyword" | "string" | "comment" | "number" | "function" | "punct" | "plain";
  value: string;
}

const JS_KEYWORDS = new Set([
  "abstract", "async", "await", "break", "case", "catch", "class", "const",
  "continue", "debugger", "default", "delete", "do", "else", "enum", "export",
  "extends", "false", "finally", "for", "from", "function", "if", "implements",
  "import", "in", "instanceof", "interface", "let", "new", "null", "of",
  "package", "private", "protected", "public", "return", "static", "super",
  "switch", "this", "throw", "true", "try", "type", "typeof", "undefined",
  "var", "void", "while", "with", "yield", "as",
]);

const PY_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break",
  "class", "continue", "def", "del", "elif", "else", "except", "finally",
  "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

function tokenize(code: string, language: string): Token[] {
  const keywords = language === "python" ? PY_KEYWORDS : JS_KEYWORDS;
  const tokens: Token[] = [];
  let i = 0;
  const n = code.length;

  const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c);
  const isIdent = (c: string) => /[A-Za-z0-9_$]/.test(c);
  const isDigit = (c: string) => /[0-9]/.test(c);

  while (i < n) {
    const c = code[i];

    // Line comment: // or # (python)
    if ((c === "/" && code[i + 1] === "/") || (language === "python" && c === "#")) {
      let j = i + 1;
      while (j < n && code[j] !== "\n") j++;
      tokens.push({ type: "comment", value: code.slice(i, j) });
      i = j;
      continue;
    }
    // Block comment /* ... */
    if (c === "/" && code[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(code[j] === "*" && code[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      tokens.push({ type: "comment", value: code.slice(i, j) });
      i = j;
      continue;
    }
    // Strings: ', ", `
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < n && code[j] !== quote) {
        if (code[j] === "\\") j++;
        j++;
      }
      j = Math.min(n, j + 1);
      tokens.push({ type: "string", value: code.slice(i, j) });
      i = j;
      continue;
    }
    // Numbers
    if (isDigit(c) || (c === "." && isDigit(code[i + 1]))) {
      let j = i + 1;
      while (j < n && /[0-9._xXeE+\-a-fA-F]/.test(code[j])) j++;
      tokens.push({ type: "number", value: code.slice(i, j) });
      i = j;
      continue;
    }
    // Identifiers / keywords / functions
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdent(code[j])) j++;
      const word = code.slice(i, j);
      // Look ahead for `(` → function call (skip whitespace)
      let k = j;
      while (k < n && /\s/.test(code[k])) k++;
      if (keywords.has(word)) {
        tokens.push({ type: "keyword", value: word });
      } else if (code[k] === "(") {
        tokens.push({ type: "function", value: word });
      } else {
        tokens.push({ type: "plain", value: word });
      }
      i = j;
      continue;
    }
    // Punctuation / operators
    if (/[{}()[\];:,.<>+\-*/%=!?&|^~@]/.test(c)) {
      tokens.push({ type: "punct", value: c });
      i++;
      continue;
    }
    // Whitespace + other
    tokens.push({ type: "plain", value: c });
    i++;
  }
  return tokens;
}

const TOKEN_CLASS: Record<Token["type"], string> = {
  keyword: "text-fuchsia-400",
  string: "text-emerald-400",
  comment: "text-text-secondary/60 italic",
  number: "text-amber-400",
  function: "text-sky-400",
  punct: "text-text-secondary",
  plain: "text-text-primary",
};

export function CodeHighlight({
  code,
  language,
}: {
  code: string;
  language: string;
}) {
  const tokens = useMemo(() => tokenize(code, language), [code, language]);
  return (
    <pre
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 m-0 overflow-auto whitespace-pre px-4 py-3 font-mono text-xs leading-5"
    >
      <code>
        {tokens.map((t, idx) => (
          <span key={idx} className={TOKEN_CLASS[t.type]}>
            {t.value}
          </span>
        ))}
      </code>
    </pre>
  );
}
