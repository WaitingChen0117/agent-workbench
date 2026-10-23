// node:sqlite 的最小类型声明（@types/node v20 尚未包含）。
// 只声明本项目实际用到的子集，避免为此升级 @types/node。
declare module "node:sqlite" {
  export class StatementSync {
    run(
      ...params: unknown[]
    ): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  export class DatabaseSync {
    constructor(location: string, options?: { open?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
