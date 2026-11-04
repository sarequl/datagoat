/**
 * Split a migration file into statements for `db.batch()`. Handles `--` and block comments,
 * single/double/backtick-quoted strings and identifiers, and `CREATE TRIGGER ... BEGIN ... END;`
 * bodies (semicolons inside them do not end the statement).
 */
export function splitSqlStatements(source: string): string[] {
  const out: string[] = [];
  let current = "";
  let i = 0;
  let depth = 0; // BEGIN ... END nesting inside CREATE TRIGGER
  const flush = () => {
    const stmt = current.trim();
    if (stmt) out.push(stmt);
    current = "";
  };
  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];
    if (ch === "-" && next === "-") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end + 1;
      current += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      current += " ";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === close) {
          if (close !== "]" && source[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      current += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch) && !/[A-Za-z0-9_]/.test(source[i - 1] ?? " ")) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))?.[0] ?? ch;
      const upper = word.toUpperCase();
      if (upper === "BEGIN" && /\bCREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(current))
        depth++;
      else if ((upper === "END" || upper === "COMMIT") && depth > 0 && upper === "END") depth--;
      current += word;
      i += word.length;
      continue;
    }
    if (ch === ";" && depth === 0) {
      flush();
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  flush();
  return out;
}
