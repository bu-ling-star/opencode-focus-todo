/**
 * Ambient declarations for the modules OpenCode injects into TUI plugins.
 *
 * A TUI plugin is compiled by OpenCode's own Bun pipeline, which rewrites these
 * bare specifiers to runtime modules built into the executable
 * (`@opentui/solid`, `solid-js`, `@opencode/plugin/tui`, ...). The real packages
 * are therefore never installed in this repository and never need to be.
 *
 * These declarations mirror the API the host actually provides so that
 * `tsc --noEmit` can still check `.opencode/plugin/tui.tsx`. They cover only the
 * members this plugin uses; see IMPLEMENTATION_NOTES.md §11 for how they were
 * verified against the running executable.
 */

declare module "solid-js" {
  export function createMemo<T>(compute: () => T): () => T
  export function createSignal<T>(initial: T): [() => T, (next: T | ((previous: T) => T)) => T]
  export function createEffect<T>(compute: () => T): void
  export function onCleanup(cleanup: () => void): void

  export function For<T>(props: {
    readonly each: readonly T[] | undefined
    readonly children?: (item: T, index: () => number) => unknown
  }): unknown

  export function Show(props: { readonly when: unknown; readonly children?: unknown }): unknown
}

declare module "@opentui/solid/jsx-runtime" {
  export function jsx(type: unknown, props: unknown, key?: unknown): unknown
  export function jsxs(type: unknown, props: unknown, key?: unknown): unknown
  export function jsxDEV(type: unknown, props: unknown, key?: unknown): unknown
  export function Fragment(props: { readonly children?: unknown }): unknown
}

/**
 * JSX element types. Declared globally because the compiler option is
 * `jsx: "preserve"`: tsc never emits JSX here (the host's Bun pipeline does the
 * real transform), so this exists only to type-check the markup.
 */
declare namespace JSX {
  interface IntrinsicProps {
    /** Props are relayed to the underlying OpenTUI renderable. */
    readonly [key: string]: unknown
    readonly children?: unknown
    readonly fg?: string
    readonly flexDirection?: "row" | "column"
    readonly gap?: number
    readonly truncate?: boolean
  }

  interface IntrinsicElements {
    box: IntrinsicProps
    text: IntrinsicProps
  }
}
