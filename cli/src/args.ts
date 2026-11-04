/**
 * A small argv parser: `--flag value`, `--flag=value`, boolean `--flag` / `--no-flag`,
 * repeatable flags and short aliases (`-F`, `-y`, `-h`, `-V`). Flag types come from one table so
 * global flags may appear anywhere on the command line.
 */

export type FlagType = "string" | "boolean" | "multi";

export interface FlagSpec {
  type: FlagType;
  description: string;
  /** Placeholder shown in help, e.g. "<id>". */
  value?: string;
  short?: string;
}

export interface ParsedArgs {
  positionals: string[];
  /** string → last value, multi → every value, boolean → true/false. */
  flags: Map<string, string | string[] | boolean>;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseArgv(
  argv: readonly string[],
  specs: ReadonlyMap<string, FlagSpec>,
): ParsedArgs {
  const shorts = new Map<string, string>();
  for (const [name, spec] of specs) if (spec.short) shorts.set(spec.short, name);
  const positionals: string[] = [];
  const flags = new Map<string, string | string[] | boolean>();
  const set = (name: string, spec: FlagSpec, value: string | boolean) => {
    if (spec.type === "multi") {
      const prev = flags.get(name);
      flags.set(name, [...(Array.isArray(prev) ? prev : []), String(value)]);
    } else flags.set(name, value);
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    let name: string | undefined;
    let inline: string | undefined;
    if (token.startsWith("--") && token.length > 2) {
      const eq = token.indexOf("=");
      name = eq > 0 ? token.slice(2, eq) : token.slice(2);
      inline = eq > 0 ? token.slice(eq + 1) : undefined;
    } else if (/^-[A-Za-z]$/.test(token)) {
      name = shorts.get(token.slice(1));
      if (!name) throw new UsageError(`Unknown flag ${token}`);
    } else {
      positionals.push(token);
      continue;
    }
    let spec = specs.get(name);
    if (!spec && name.startsWith("no-")) {
      const base = specs.get(name.slice(3));
      if (base?.type === "boolean") {
        flags.set(name.slice(3), false);
        continue;
      }
    }
    if (!spec) throw new UsageError(`Unknown flag --${name}`);
    if (spec.type === "boolean") {
      if (inline === undefined) set(name, spec, true);
      else if (["true", "1", "yes"].includes(inline)) set(name, spec, true);
      else if (["false", "0", "no"].includes(inline)) set(name, spec, false);
      else throw new UsageError(`--${name} takes true or false`);
      continue;
    }
    let value = inline;
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      i += 1;
    }
    spec = spec as FlagSpec;
    set(name, spec, value);
  }
  return { positionals, flags };
}

/** Typed accessors over parsed flags. */
export class Flags {
  constructor(private readonly map: ParsedArgs["flags"]) {}

  has(name: string): boolean {
    return this.map.has(name);
  }

  string(name: string): string | undefined {
    const v = this.map.get(name);
    if (Array.isArray(v)) return v[v.length - 1];
    return typeof v === "string" ? v : undefined;
  }

  bool(name: string): boolean | undefined {
    const v = this.map.get(name);
    return typeof v === "boolean" ? v : undefined;
  }

  list(name: string): string[] {
    const v = this.map.get(name);
    if (Array.isArray(v)) return v;
    return typeof v === "string" ? [v] : [];
  }

  int(name: string, opts: { min?: number; max?: number } = {}): number | undefined {
    const raw = this.string(name);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new UsageError(`--${name} must be a whole number`);
    if (opts.min !== undefined && n < opts.min)
      throw new UsageError(`--${name} must be ≥ ${opts.min}`);
    if (opts.max !== undefined && n > opts.max)
      throw new UsageError(`--${name} must be ≤ ${opts.max}`);
    return n;
  }

  number(name: string): number | undefined {
    const raw = this.string(name);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number`);
    return n;
  }

  names(): string[] {
    return [...this.map.keys()];
  }
}
