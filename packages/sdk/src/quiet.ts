// bigint-buffer (a transitive spl-token dependency) warns when its optional native build is
// missing; the pure-JS fallback is correct, so the warning is dropped for CLI output.
const warn = console.warn;
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("bigint: Failed to load bindings")) return;
  warn(...args);
};
export {};
