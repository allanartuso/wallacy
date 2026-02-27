/**
 * ANSI escape code utilities for rendering terminal output in HTML.
 */

const SGR: Record<number, string> = {
  0: "",
  1: "font-weight:bold",
  2: "opacity:.6",
  3: "font-style:italic",
  4: "text-decoration:underline",
  22: "",
  23: "",
  24: "",
  30: "color:#1e1e1e",
  31: "color:var(--red)",
  32: "color:var(--green)",
  33: "color:var(--yellow)",
  34: "color:var(--blue)",
  35: "color:#c586c0",
  36: "color:#4ec9b0",
  37: "color:var(--fg)",
  39: "",
  90: "color:#888",
  91: "color:#f48771",
  92: "color:#89d185",
  93: "color:#e5e510",
  94: "color:#6796e6",
  95: "color:#d670d6",
  96: "color:#2bc1c4",
  97: "color:#e5e5e5",
};

/** Strip all ANSI escape sequences from a string. */
export function stripAnsi(s: string): string {
  if (!s) return "";
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Convert ANSI escape codes to styled HTML spans. */
export function ansiToHtml(s: string): string {
  if (!s) return "";

  const parts: string[] = [];
  let open = 0;
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(s)) !== null) {
    if (m.index > last) {
      parts.push(escapeHtml(s.slice(last, m.index)));
    }
    last = m.index + m[0].length;

    const codes = m[1].split(";");
    for (const codeStr of codes) {
      const c = parseInt(codeStr, 10);
      if (c === 0 || c === 39 || c === 22 || c === 23 || c === 24) {
        while (open > 0) {
          parts.push("</span>");
          open--;
        }
      } else if (SGR[c]) {
        parts.push(`<span style="${SGR[c]}">`);
        open++;
      }
    }
  }

  if (last < s.length) {
    parts.push(escapeHtml(s.slice(last)));
  }

  while (open > 0) {
    parts.push("</span>");
    open--;
  }

  return parts.join("");
}

/** Escape HTML special characters. */
export function escapeHtml(s: string): string {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Extract basename from a file path (handles both / and \). */
export function basename(p: string): string {
  return String(p).split(/[/\\]/).pop() || p;
}

/** Format a value for display in expected/actual diffs. */
export function formatValue(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "string") return `"${v}"`;
  if (typeof v === "object") {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }
  return String(v);
}
