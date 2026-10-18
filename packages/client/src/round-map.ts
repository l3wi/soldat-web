/** Coalesce authoritative map epochs before the next rendering frame.
 * Returning to the rendered map must discard any uncommitted different map. */
export function roundMapDisposition(rendered: string, pending: string | undefined, requested: string): "discard" | "retain" | "prepare" {
  if (requested === rendered) return "discard";
  return requested === pending ? "retain" : "prepare";
}
