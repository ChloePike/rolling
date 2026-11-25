// Minimal typing for Node 22's built-in `node:sqlite` (this package has no @types/node).
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] };
    close(): void;
  }
}
declare module "node:fs" {
  export function readFileSync(path: URL | string, encoding: "utf8"): string;
  export function readdirSync(path: URL | string): string[];
}
declare class URL {
  constructor(url: string, base?: string | URL);
}
interface ImportMeta {
  url: string;
}
