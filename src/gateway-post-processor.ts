import BpmnModdle from 'bpmn-moddle';
import { type Bounds, GATEWAY_TYPES } from './bpmn-types.js';

// ─── visual boundary geometry ─────────────────────────────────────────────────

/**
 * Point on the **rectangle** boundary of `bounds` in the direction from the
 * centre toward `from`.
 */
function rectangleBoundaryPoint(
  from: { x: number; y: number },
  bounds: Bounds,
): { x: number; y: number } {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const dx = from.x - cx;
  const dy = from.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: bounds.y };
  const halfW = bounds.width / 2;
  const halfH = bounds.height / 2;
  const s = Math.min(halfW / Math.abs(dx), halfH / Math.abs(dy));
  return { x: Math.round(cx + dx * s), y: Math.round(cy + dy * s) };
}

// ─── waypoint snapping ────────────────────────────────────────────────────────

/**
 * Post-process BPMNEdge waypoints for boundary events:
 *
 *  - Boundary events (source only): the ELK port is zero-size; snap the first
 *    waypoint from the port centre to the rendered 36×36 shape boundary.
 *  - Gateways: ELK now routes directly from/to the diamond cardinal vertex via
 *    explicit FIXED_POS ports — no snapping needed.
 *  - All other shapes: ELK's ORTHOGONAL routing already places waypoints
 *    correctly on the rectangle boundary — leave them as-is.
 */
export function snapConnectionEndpoints(
  plane: any,
  boundsMap: Map<string, Bounds>,
  elementMap: Map<string, any>,
  moddle: BpmnModdle,
): void {
  for (const el of plane.planeElement) {
    if (el.$type !== 'bpmndi:BPMNEdge') continue;
    const wps: any[] = el.waypoint;
    if (wps.length < 2) continue;

    const srcId: string | undefined = el.bpmnElement.sourceRef?.id;
    if (srcId) {
      const src = elementMap.get(srcId);
      const srcBounds = boundsMap.get(srcId);
      if (src && srcBounds && src.$type === 'bpmn:BoundaryEvent') {
        // Move first waypoint from zero-size port centre to shape perimeter.
        const snapped = rectangleBoundaryPoint({ x: wps[1].x, y: wps[1].y }, srcBounds);
        wps[0] = (moddle as any).create('dc:Point', snapped);
      }
    }
  }
}

// ─── N/S gateway path reconstruction ─────────────────────────────────────────

/**
 * Returns true if the axis-aligned segment would pass through the interior of
 * any element in boundsMap (excluding elements in `skip`).
 *
 * isHorizontal  true  → segment is y=fixed, x ∈ [lo, hi]
 *               false → segment is x=fixed, y ∈ [lo, hi]
 *
 * margin: each bounding-box is inset by this many pixels before testing,
 * preventing false positives when a path merely touches a shared boundary.
 */
function segmentCrossesAnyElement(
  isHorizontal: boolean,
  fixed: number,
  lo: number,
  hi: number,
  skip: Set<string>,
  boundsMap: Map<string, Bounds>,
  margin = 2,
): boolean {
  for (const [id, box] of boundsMap) {
    if (skip.has(id)) continue;
    const bx0 = box.x + margin;
    const bx1 = box.x + box.width - margin;
    const by0 = box.y + margin;
    const by1 = box.y + box.height - margin;
    if (bx1 <= bx0 || by1 <= by0) continue; // box collapses after margin shrink
    if (isHorizontal) {
      if (fixed > by0 && fixed < by1 && lo < bx1 && hi > bx0) return true;
    } else {
      if (fixed > bx0 && fixed < bx1 && lo < by1 && hi > by0) return true;
    }
  }
  return false;
}

/**
 * For gateway edges whose connected element sits strictly above or below the
 * gateway, ELK (direction RIGHT) still exits from the EAST/WEST port and bends
 * around the diamond, producing 2–3 extra waypoints.  This post-processor
 * replaces those paths with a clean 1-bend L-shape that starts/ends at the
 * correct cardinal diamond tip (NORTH or SOUTH).
 *
 * The rebuild is skipped for an edge if either segment of the proposed L-shape
 * would pass through the interior of another diagram element — in that case
 * ELK's original routing (which avoids the obstacle) is preserved as-is.
 *
 * Edges connecting two gateways are always skipped — EAST/WEST routing already
 * gives a clean path in normal layouts.
 */
export function rebuildGatewayEdgePaths(
  plane: any,
  boundsMap: Map<string, Bounds>,
  elementMap: Map<string, any>,
  moddle: BpmnModdle,
): void {
  function makePt(x: number, y: number) {
    return (moddle as any).create('dc:Point', { x, y });
  }

  for (const el of plane.planeElement) {
    if (el.$type !== 'bpmndi:BPMNEdge') continue;
    const wps: any[] = el.waypoint;
    if (wps.length < 2) continue;

    const srcId: string | undefined = el.bpmnElement.sourceRef?.id;
    const tgtId: string | undefined = el.bpmnElement.targetRef?.id;
    const src = srcId ? elementMap.get(srcId) : undefined;
    const tgt = tgtId ? elementMap.get(tgtId) : undefined;

    // Skip gateway-to-gateway edges — EAST/WEST path is already clean.
    if (src && GATEWAY_TYPES.has(src.$type as string) &&
        tgt && GATEWAY_TYPES.has(tgt.$type as string)) continue;

    // ── outgoing from gateway ────────────────────────────────────────────────
    if (src && GATEWAY_TYPES.has(src.$type as string)) {
      const gwB = boundsMap.get(srcId!);
      const tgtB = tgtId ? boundsMap.get(tgtId) : undefined;
      if (gwB && tgtB) {
        const gwCx  = gwB.x + gwB.width / 2;
        const gwY   = gwB.y;
        const gwBot = gwB.y + gwB.height;
        const tgtCy = tgtB.y + tgtB.height / 2;
        // Last waypoint is already on the target boundary — keep it as the far end.
        const farEnd = wps[wps.length - 1];

        let tipY: number | undefined;
        if (tgtCy <= gwY) tipY = gwY;          // target above → NORTH tip
        else if (tgtCy >= gwBot) tipY = gwBot;  // target below → SOUTH tip

        if (tipY !== undefined) {
          const skip = new Set<string>([srcId!, ...(tgtId ? [tgtId] : [])]);
          // Skip ancestor containers (elements whose bounds fully enclose the gateway).
          for (const [id, box] of boundsMap) {
            if (!skip.has(id) &&
                box.x <= gwB.x && box.y <= gwB.y &&
                box.x + box.width  >= gwB.x + gwB.width &&
                box.y + box.height >= gwB.y + gwB.height) skip.add(id);
          }
          const vertLo = Math.min(tipY, farEnd.y);
          const vertHi = Math.max(tipY, farEnd.y);
          const horizLo = Math.min(gwCx, farEnd.x);
          const horizHi = Math.max(gwCx, farEnd.x);
          // Only rebuild if neither segment of the L-shape crosses another element.
          if (!segmentCrossesAnyElement(false, gwCx, vertLo, vertHi, skip, boundsMap) &&
              !segmentCrossesAnyElement(true, farEnd.y, horizLo, horizHi, skip, boundsMap)) {
            const tip = makePt(gwCx, tipY);
            el.waypoint = Math.abs(farEnd.y - tipY) <= 0.5
              ? [tip, farEnd]
              : [tip, makePt(gwCx, farEnd.y), farEnd];
          }
        }
        // else: target at same height → EAST/WEST path already correct.
      }
    }

    // ── incoming to gateway ──────────────────────────────────────────────────
    if (tgt && GATEWAY_TYPES.has(tgt.$type as string)) {
      const gwB = boundsMap.get(tgtId!);
      const srcB = srcId ? boundsMap.get(srcId) : undefined;
      if (gwB && srcB) {
        const gwCx  = gwB.x + gwB.width / 2;
        const gwY   = gwB.y;
        const gwBot = gwB.y + gwB.height;
        const srcCy = srcB.y + srcB.height / 2;
        // First waypoint is already on the source boundary — keep it as the far end.
        const farEnd = wps[0];

        let tipY: number | undefined;
        if (srcCy <= gwY) tipY = gwY;          // source above → NORTH tip
        else if (srcCy >= gwBot) tipY = gwBot;  // source below → SOUTH tip

        if (tipY !== undefined) {
          const skip = new Set<string>([...(srcId ? [srcId] : []), tgtId!]);
          // Skip ancestor containers (elements whose bounds fully enclose the gateway).
          for (const [id, box] of boundsMap) {
            if (!skip.has(id) &&
                box.x <= gwB.x && box.y <= gwB.y &&
                box.x + box.width  >= gwB.x + gwB.width &&
                box.y + box.height >= gwB.y + gwB.height) skip.add(id);
          }
          const horizLo = Math.min(farEnd.x, gwCx);
          const horizHi = Math.max(farEnd.x, gwCx);
          const vertLo = Math.min(farEnd.y, tipY);
          const vertHi = Math.max(farEnd.y, tipY);
          // Only rebuild if neither segment of the L-shape crosses another element.
          if (!segmentCrossesAnyElement(true, farEnd.y, horizLo, horizHi, skip, boundsMap) &&
              !segmentCrossesAnyElement(false, gwCx, vertLo, vertHi, skip, boundsMap)) {
            const tip = makePt(gwCx, tipY);
            el.waypoint = Math.abs(farEnd.y - tipY) <= 0.5
              ? [farEnd, tip]
              : [farEnd, makePt(gwCx, farEnd.y), tip];
          }
        }
        // else: source at same height → EAST/WEST path already correct.
      }
    }
  }
}
