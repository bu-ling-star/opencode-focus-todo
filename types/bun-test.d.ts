/**
 * Minimal ambient types for the `bun:test` runner so `tsc --noEmit` can check
 * this repo without pulling in node_modules. `bun test` is the real runner.
 */
declare module "bun:test" {
  type Fn = () => void | Promise<void>
  interface Matchers {
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
    toContain(expected: unknown): void
    toBeUndefined(): void
    toBeDefined(): void
    toBeNull(): void
    toHaveLength(expected: number): void
    toBeLessThan(expected: number): void
    toBeLessThanOrEqual(expected: number): void
    toBeGreaterThan(expected: number): void
    toBeGreaterThanOrEqual(expected: number): void
    toMatchObject(expected: unknown): void
    toMatch(pattern: RegExp): void
    readonly not: Matchers
    resolves: { toBeUndefined(): Promise<void> }
  }
  export function test(name: string, fn: Fn): void
  export function it(name: string, fn: Fn): void
  export function beforeEach(fn: () => void | Promise<void>): void
  export function describe(name: string, fn: () => void): void
  export function expect(actual: unknown): Matchers
  export const mock: { module(name: string, factory: () => unknown): void }
}

/** Provided by both Bun and Node; declared here so `lib: ["ES2022"]` stays sufficient. */
declare function setTimeout(handler: (value?: unknown) => void, timeout?: number): unknown

/** Bun runtime globals used by the tests: module resolution probing and the module path. */
declare const Bun: { resolveSync(moduleId: string, parent: string): string }

declare interface ImportMeta {
  readonly dir: string
}
