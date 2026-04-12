// ─── element map builder ──────────────────────────────────────────────────────

/** Build a flat id → element map by recursively traversing BPMN root elements. */
export function buildElementMap(elements: any[], map = new Map<string, any>()): Map<string, any> {
  for (const el of elements) {
    if (el.id) map.set(el.id as string, el);
    if (el.flowElements) buildElementMap(el.flowElements, map);
    if (el.participants) buildElementMap(el.participants, map);
    if (el.lanes) buildElementMap(el.lanes, map);
  }
  return map;
}
