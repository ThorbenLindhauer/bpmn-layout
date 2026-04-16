import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import BpmnModdle from 'bpmn-moddle';
import { layout } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): string {
  return readFileSync(resolve(__dirname, 'fixtures', name), 'utf-8');
}

async function parseDi(xml: string) {
  const moddle = new BpmnModdle();
  const { rootElement } = (await moddle.fromXML(xml)) as { rootElement: any };
  const plane = rootElement.diagrams[0].plane;
  const shapes: any[] = plane.planeElement.filter((e: any) => e.$type === 'bpmndi:BPMNShape');
  const edges: any[] = plane.planeElement.filter((e: any) => e.$type === 'bpmndi:BPMNEdge');
  return { shapes, edges };
}

// ─── simple linear process ───────────────────────────────────────────────────

describe('simple linear process', () => {
  it('produces output XML', async () => {
    const result = await layout(fixture('simple-linear.bpmn'));
    expect(typeof result).toBe('string');
    expect(result).toContain('definitions');
  });

  it('creates a BPMNShape for every flow node', async () => {
    const result = await layout(fixture('simple-linear.bpmn'));
    const { shapes } = await parseDi(result);
    const ids = shapes.map((s: any) => s.bpmnElement.id);
    expect(ids).toContain('start1');
    expect(ids).toContain('task1');
    expect(ids).toContain('end1');
  });

  it('creates a BPMNEdge for every sequence flow', async () => {
    const result = await layout(fixture('simple-linear.bpmn'));
    const { edges } = await parseDi(result);
    const ids = edges.map((e: any) => e.bpmnElement.id);
    expect(ids).toContain('sf1');
    expect(ids).toContain('sf2');
  });

  it('assigns non-negative coordinates to all shapes', async () => {
    const result = await layout(fixture('simple-linear.bpmn'));
    const { shapes } = await parseDi(result);
    for (const shape of shapes) {
      expect(shape.bounds.x).toBeGreaterThanOrEqual(0);
      expect(shape.bounds.y).toBeGreaterThanOrEqual(0);
      expect(shape.bounds.width).toBeGreaterThan(0);
      expect(shape.bounds.height).toBeGreaterThan(0);
    }
  });

  it('lays out left-to-right: start < task < end', async () => {
    const result = await layout(fixture('simple-linear.bpmn'));
    const { shapes } = await parseDi(result);
    const byId = Object.fromEntries(shapes.map((s: any) => [s.bpmnElement.id, s.bounds]));
    expect(byId['start1'].x).toBeLessThan(byId['task1'].x);
    expect(byId['task1'].x).toBeLessThan(byId['end1'].x);
  });

  it('gives each edge at least two waypoints', async () => {
    const result = await layout(fixture('simple-linear.bpmn'));
    const { edges } = await parseDi(result);
    for (const edge of edges) {
      expect(edge.waypoint.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ─── parallel gateway ─────────────────────────────────────────────────────────

describe('parallel gateway', () => {
  it('creates shapes for all 6 flow nodes', async () => {
    const result = await layout(fixture('parallel-gateway.bpmn'));
    const { shapes } = await parseDi(result);
    expect(shapes).toHaveLength(6);
  });

  it('creates edges for all 6 sequence flows', async () => {
    const result = await layout(fixture('parallel-gateway.bpmn'));
    const { edges } = await parseDi(result);
    expect(edges).toHaveLength(6);
  });

  it('places parallel branches (taskA, taskB) at different y positions', async () => {
    const result = await layout(fixture('parallel-gateway.bpmn'));
    const { shapes } = await parseDi(result);
    const byId = Object.fromEntries(shapes.map((s: any) => [s.bpmnElement.id, s.bounds]));
    expect(byId['taskA'].y).not.toEqual(byId['taskB'].y);
  });
});

// ─── waypoint boundary connection ────────────────────────────────────────────

// ─── waypoint boundary helpers ───────────────────────────────────────────────

const GATEWAY_ELEMENT_TYPES = new Set([
  'bpmn:ExclusiveGateway', 'bpmn:ParallelGateway', 'bpmn:InclusiveGateway',
  'bpmn:EventBasedGateway', 'bpmn:ComplexGateway',
]);

/**
 * Returns true when `point` lies on one of the four edges of `bounds`,
 * within the given pixel tolerance.
 */
function isOnBoundary(
  point: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number },
  tol = 1,
): boolean {
  const { x, y, width, height } = bounds;
  const inXRange = point.x >= x - tol && point.x <= x + width + tol;
  const inYRange = point.y >= y - tol && point.y <= y + height + tol;
  const onLeft   = Math.abs(point.x - x) <= tol && inYRange;
  const onRight  = Math.abs(point.x - (x + width)) <= tol && inYRange;
  const onTop    = Math.abs(point.y - y) <= tol && inXRange;
  const onBottom = Math.abs(point.y - (y + height)) <= tol && inXRange;
  return onLeft || onRight || onTop || onBottom;
}

/**
 * Returns true when `point` lies on the diamond (rhombus) boundary of `bounds`.
 * Diamond vertices are the midpoints of each bounding-box edge.
 * The boundary satisfies |ΔX/halfW| + |ΔY/halfH| = 1.
 */
function isOnDiamondBoundary(
  point: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number },
  tol = 1,
): boolean {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const halfW = bounds.width / 2;
  const halfH = bounds.height / 2;
  const val = Math.abs(point.x - cx) / halfW + Math.abs(point.y - cy) / halfH;
  // Convert tol from pixels to "val" units using the shorter half-axis
  return Math.abs(val - 1) <= (tol + 1) / Math.min(halfW, halfH);
}

/**
 * Returns true when `point` is at one of the 4 cardinal diamond tips of `bounds`:
 * top (NORTH), bottom (SOUTH), right (EAST), or left (WEST) vertex.
 */
function isAtCardinalDiamondTip(
  point: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number },
  tol = 1,
): boolean {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const isNorth = Math.abs(point.x - cx) <= tol && Math.abs(point.y - bounds.y) <= tol;
  const isSouth = Math.abs(point.x - cx) <= tol && Math.abs(point.y - (bounds.y + bounds.height)) <= tol;
  const isEast  = Math.abs(point.x - (bounds.x + bounds.width)) <= tol && Math.abs(point.y - cy) <= tol;
  const isWest  = Math.abs(point.x - bounds.x) <= tol && Math.abs(point.y - cy) <= tol;
  return isNorth || isSouth || isEast || isWest;
}

/** Dispatches to diamond or rectangle boundary check based on element type. */
function isOnVisualBoundary(
  point: { x: number; y: number },
  elementType: string,
  bounds: { x: number; y: number; width: number; height: number },
  tol = 1,
): boolean {
  return GATEWAY_ELEMENT_TYPES.has(elementType)
    ? isOnDiamondBoundary(point, bounds, tol)
    : isOnBoundary(point, bounds, tol);
}

describe('sequence flow waypoints connect to shape boundaries', () => {
  it('first waypoint of every edge lies on the visual boundary of its source shape', async () => {
    const result = await layout(fixture('gateway-connection.bpmn'));
    const { shapes, edges } = await parseDi(result);
    const infoById = Object.fromEntries(
      shapes.map((s: any) => [s.bpmnElement.id, { bounds: s.bounds, type: s.bpmnElement.$type }]),
    );

    for (const edge of edges) {
      const srcId = edge.bpmnElement.sourceRef?.id ?? edge.bpmnElement.sourceRef;
      const firstWp = edge.waypoint[0];
      const src = infoById[srcId];
      expect(src, `shape not found for source ${srcId}`).toBeDefined();
      expect(
        isOnVisualBoundary(firstWp, src.type, src.bounds),
        `first waypoint (${firstWp.x},${firstWp.y}) of ${edge.bpmnElement.id} is not on visual boundary of source ${srcId} ` +
        `[${src.type}] (x:${src.bounds.x} y:${src.bounds.y} w:${src.bounds.width} h:${src.bounds.height})`,
      ).toBe(true);
    }
  });

  it('last waypoint of every edge lies on the visual boundary of its target shape', async () => {
    const result = await layout(fixture('gateway-connection.bpmn'));
    const { shapes, edges } = await parseDi(result);
    const infoById = Object.fromEntries(
      shapes.map((s: any) => [s.bpmnElement.id, { bounds: s.bounds, type: s.bpmnElement.$type }]),
    );

    for (const edge of edges) {
      const tgtId = edge.bpmnElement.targetRef?.id ?? edge.bpmnElement.targetRef;
      const lastWp = edge.waypoint[edge.waypoint.length - 1];
      const tgt = infoById[tgtId];
      expect(tgt, `shape not found for target ${tgtId}`).toBeDefined();
      expect(
        isOnVisualBoundary(lastWp, tgt.type, tgt.bounds),
        `last waypoint (${lastWp.x},${lastWp.y}) of ${edge.bpmnElement.id} is not on visual boundary of target ${tgtId} ` +
        `[${tgt.type}] (x:${tgt.bounds.x} y:${tgt.bounds.y} w:${tgt.bounds.width} h:${tgt.bounds.height})`,
      ).toBe(true);
    }
  });

  it('edges connecting to a gateway have their endpoint strictly on the diamond face', async () => {
    const result = await layout(fixture('gateway-connection.bpmn'));
    const { shapes, edges } = await parseDi(result);
    const infoById = Object.fromEntries(
      shapes.map((s: any) => [s.bpmnElement.id, { bounds: s.bounds, type: s.bpmnElement.$type }]),
    );

    for (const edge of edges) {
      const srcId = edge.bpmnElement.sourceRef?.id ?? edge.bpmnElement.sourceRef;
      const tgtId = edge.bpmnElement.targetRef?.id ?? edge.bpmnElement.targetRef;

      if (GATEWAY_ELEMENT_TYPES.has(infoById[srcId]?.type)) {
        const firstWp = edge.waypoint[0];
        expect(
          isOnDiamondBoundary(firstWp, infoById[srcId].bounds),
          `${edge.bpmnElement.id} first wp (${firstWp.x},${firstWp.y}) not on diamond of ${srcId}`,
        ).toBe(true);
      }

      if (GATEWAY_ELEMENT_TYPES.has(infoById[tgtId]?.type)) {
        const lastWp = edge.waypoint[edge.waypoint.length - 1];
        expect(
          isOnDiamondBoundary(lastWp, infoById[tgtId].bounds),
          `${edge.bpmnElement.id} last wp (${lastWp.x},${lastWp.y}) not on diamond of ${tgtId}`,
        ).toBe(true);
      }
    }
  });

  it('gateway edge endpoints land at a cardinal diamond tip (N/S/E/W vertex)', async () => {
    for (const fixtureName of ['gateway-connection.bpmn', 'parallel-gateway.bpmn']) {
      const result = await layout(fixture(fixtureName));
      const { shapes, edges } = await parseDi(result);
      const infoById = Object.fromEntries(
        shapes.map((s: any) => [s.bpmnElement.id, { bounds: s.bounds, type: s.bpmnElement.$type }]),
      );

      for (const edge of edges) {
        const srcId = edge.bpmnElement.sourceRef?.id ?? edge.bpmnElement.sourceRef;
        const tgtId = edge.bpmnElement.targetRef?.id ?? edge.bpmnElement.targetRef;

        if (GATEWAY_ELEMENT_TYPES.has(infoById[srcId]?.type)) {
          const firstWp = edge.waypoint[0];
          expect(
            isAtCardinalDiamondTip(firstWp, infoById[srcId].bounds),
            `[${fixtureName}] ${edge.bpmnElement.id} first wp (${firstWp.x},${firstWp.y}) ` +
            `is not at a cardinal tip of ${srcId} ` +
            `(x:${infoById[srcId].bounds.x} y:${infoById[srcId].bounds.y} ` +
            `w:${infoById[srcId].bounds.width} h:${infoById[srcId].bounds.height})`,
          ).toBe(true);
        }

        if (GATEWAY_ELEMENT_TYPES.has(infoById[tgtId]?.type)) {
          const lastWp = edge.waypoint[edge.waypoint.length - 1];
          expect(
            isAtCardinalDiamondTip(lastWp, infoById[tgtId].bounds),
            `[${fixtureName}] ${edge.bpmnElement.id} last wp (${lastWp.x},${lastWp.y}) ` +
            `is not at a cardinal tip of ${tgtId} ` +
            `(x:${infoById[tgtId].bounds.x} y:${infoById[tgtId].bounds.y} ` +
            `w:${infoById[tgtId].bounds.width} h:${infoById[tgtId].bounds.height})`,
          ).toBe(true);
        }
      }
    }
  });
});

// ─── gateway port selection ───────────────────────────────────────────────────

describe('gateway port selection', () => {
  it('fork branches to tasks at different heights exit from different diamond tips', async () => {
    const result = await layout(fixture('parallel-gateway.bpmn'));
    const { shapes, edges } = await parseDi(result);
    const byId = Object.fromEntries(shapes.map((s: any) => [s.bpmnElement.id, s.bounds]));

    // sf2: fork1 -> taskA,  sf3: fork1 -> taskB
    const sf2 = edges.find((e: any) => e.bpmnElement.id === 'sf2')!;
    const sf3 = edges.find((e: any) => e.bpmnElement.id === 'sf3')!;
    expect(sf2, 'edge sf2 not found').toBeDefined();
    expect(sf3, 'edge sf3 not found').toBeDefined();

    const taskAY = byId['taskA'].y + byId['taskA'].height / 2;
    const taskBY = byId['taskB'].y + byId['taskB'].height / 2;

    // Only assert if ELK actually placed the two tasks at meaningfully different heights.
    if (Math.abs(taskAY - taskBY) > 5) {
      const sf2First = sf2.waypoint[0];
      const sf3First = sf3.waypoint[0];
      const sameExitPoint =
        Math.abs(sf2First.x - sf3First.x) <= 1 &&
        Math.abs(sf2First.y - sf3First.y) <= 1;
      expect(
        sameExitPoint,
        `Both fork branches exit from the same point (${sf2First.x},${sf2First.y}) — ` +
        `expected different tips for tasks at y=${taskAY} and y=${taskBY}`,
      ).toBe(false);
    }
  });
});

// ─── boundary events ──────────────────────────────────────────────────────────

describe('boundary events', () => {
  it('creates a BPMNShape for the boundary event', async () => {
    const result = await layout(fixture('boundary-event.bpmn'));
    const { shapes } = await parseDi(result);
    const ids = shapes.map((s: any) => s.bpmnElement.id);
    expect(ids).toContain('be1');
  });

  it('boundary event center lies on the boundary of its host activity', async () => {
    const result = await layout(fixture('boundary-event.bpmn'));
    const { shapes } = await parseDi(result);
    const byId = Object.fromEntries(shapes.map((s: any) => [s.bpmnElement.id, s.bounds]));

    const hostBounds = byId['task1'];
    const beBounds   = byId['be1'];
    expect(hostBounds).toBeDefined();
    expect(beBounds).toBeDefined();

    const beCenter = { x: beBounds.x + beBounds.width / 2, y: beBounds.y + beBounds.height / 2 };
    expect(
      isOnBoundary(beCenter, hostBounds),
      `boundary event center (${beCenter.x},${beCenter.y}) is not on host boundary ` +
      `(x:${hostBounds.x} y:${hostBounds.y} w:${hostBounds.width} h:${hostBounds.height})`,
    ).toBe(true);
  });

  it('boundary event does not overlap the interior of the host activity', async () => {
    const result = await layout(fixture('boundary-event.bpmn'));
    const { shapes } = await parseDi(result);
    const byId = Object.fromEntries(shapes.map((s: any) => [s.bpmnElement.id, s.bounds]));

    const h = byId['task1'];
    const b = byId['be1'];
    const beCenter = { x: b.x + b.width / 2, y: b.y + b.height / 2 };

    // Center must NOT be strictly inside the host rectangle
    const strictlyInside =
      beCenter.x > h.x && beCenter.x < h.x + h.width &&
      beCenter.y > h.y && beCenter.y < h.y + h.height;
    expect(strictlyInside).toBe(false);
  });

  it('sequence flows attached to the boundary event still get edges', async () => {
    const result = await layout(fixture('boundary-event.bpmn'));
    const { edges } = await parseDi(result);
    const ids = edges.map((e: any) => e.bpmnElement.id);
    expect(ids).toContain('sf3');
  });

  it('boundary-event edge first waypoint lies on the boundary event shape boundary', async () => {
    const result = await layout(fixture('boundary-event.bpmn'));
    const { shapes, edges } = await parseDi(result);
    const boundsById = Object.fromEntries(shapes.map((s: any) => [s.bpmnElement.id, s.bounds]));
    const sf3 = edges.find((e: any) => e.bpmnElement.id === 'sf3');
    expect(sf3).toBeDefined();
    const firstWp = sf3.waypoint[0];
    expect(
      isOnBoundary(firstWp, boundsById['be1']),
      `first wp (${firstWp.x},${firstWp.y}) not on be1 boundary ` +
      JSON.stringify(boundsById['be1']),
    ).toBe(true);
  });
});

// ─── multiple boundary events ─────────────────────────────────────────────────

describe('multiple boundary events', () => {
  it('creates shapes for all boundary events', async () => {
    const result = await layout(fixture('multi-boundary-event.bpmn'));
    const { shapes } = await parseDi(result);
    const ids = shapes.map((s: any) => s.bpmnElement.id);
    expect(ids).toContain('be1');
    expect(ids).toContain('be2');
  });

  it('each boundary event center lies on the boundary of its own host', async () => {
    const result = await layout(fixture('multi-boundary-event.bpmn'));
    const { shapes } = await parseDi(result);
    const byId = Object.fromEntries(shapes.map((s: any) => [s.bpmnElement.id, s.bounds]));

    for (const [beId, hostId] of [['be1', 'task1'], ['be2', 'task2']] as const) {
      const beCenter = { x: byId[beId].x + byId[beId].width / 2, y: byId[beId].y + byId[beId].height / 2 };
      expect(
        isOnBoundary(beCenter, byId[hostId]),
        `${beId} center (${beCenter.x},${beCenter.y}) not on ${hostId} boundary ` +
        JSON.stringify(byId[hostId]),
      ).toBe(true);
    }
  });

  it('boundary event outgoing edges exist and first waypoint is on the be boundary', async () => {
    const result = await layout(fixture('multi-boundary-event.bpmn'));
    const { shapes, edges } = await parseDi(result);
    const boundsById = Object.fromEntries(shapes.map((s: any) => [s.bpmnElement.id, s.bounds]));

    for (const [sfId, beId] of [['sf5', 'be1'], ['sf6', 'be2']] as const) {
      const edge = edges.find((e: any) => e.bpmnElement.id === sfId);
      expect(edge, `edge ${sfId} not found`).toBeDefined();
      const firstWp = edge.waypoint[0];
      expect(
        isOnBoundary(firstWp, boundsById[beId]),
        `${sfId} first wp (${firstWp.x},${firstWp.y}) not on ${beId} boundary ` +
        JSON.stringify(boundsById[beId]),
      ).toBe(true);
    }
  });

  it('boundary event targets (errorEnd1, errorEnd2) are positioned by ELK', async () => {
    const result = await layout(fixture('multi-boundary-event.bpmn'));
    const { shapes } = await parseDi(result);
    const byId = Object.fromEntries(shapes.map((s: any) => [s.bpmnElement.id, s.bounds]));
    // ELK must have given these shapes valid, distinct positions
    expect(byId['errorEnd1']).toBeDefined();
    expect(byId['errorEnd2']).toBeDefined();
    expect(byId['errorEnd1'].x).not.toEqual(byId['errorEnd2'].x);
  });
});

// ─── edge orthogonality ──────────────────────────────────────────────────────

describe('edge orthogonality', () => {
  const ALL_FIXTURES = [
    'simple-linear.bpmn',
    'parallel-gateway.bpmn',
    'gateway-connection.bpmn',
    'loop.bpmn',
    'boundary-event.bpmn',
    'multi-boundary-event.bpmn',
  ];

  it('every waypoint segment is axis-aligned (horizontal or vertical)', async () => {
    for (const name of ALL_FIXTURES) {
      const result = await layout(fixture(name));
      const { edges } = await parseDi(result);
      for (const edge of edges) {
        const wps: Array<{ x: number; y: number }> = edge.waypoint;
        for (let i = 0; i < wps.length - 1; i++) {
          const a = wps[i];
          const b = wps[i + 1];
          const isH = Math.abs(a.y - b.y) <= 1;
          const isV = Math.abs(a.x - b.x) <= 1;
          expect(
            isH || isV,
            `[${name}] edge ${edge.bpmnElement.id} segment ${i}→${i + 1}: ` +
            `(${a.x},${a.y})→(${b.x},${b.y}) is not axis-aligned`,
          ).toBe(true);
        }
      }
    }
  });
});

// ─── label preservation ───────────────────────────────────────────────────────

describe('label preservation', () => {
  it('shape label moves by the same delta as the shape', async () => {
    const result = await layout(fixture('labeled-shape.bpmn'));
    const { shapes } = await parseDi(result);
    const task1Shape = shapes.find((s: any) => s.bpmnElement.id === 'task1');
    expect(task1Shape, 'shape for task1 not found').toBeDefined();
    expect(task1Shape.label?.bounds, 'label bounds missing on task1').toBeDefined();
    // Original offset of label from shape origin: (158-150, 198-110) = (8, 88)
    expect(task1Shape.label.bounds.x - task1Shape.bounds.x).toBe(8);
    expect(task1Shape.label.bounds.y - task1Shape.bounds.y).toBe(88);
  });

  it('named edge label bounds are set after re-routing; unnamed edge label bounds are cleared', async () => {
    const result = await layout(fixture('labeled-shape.bpmn'));
    const { edges } = await parseDi(result);
    // sf1 has name="Go!" → label bounds must be set by ELK
    const sf1Edge = edges.find((e: any) => e.bpmnElement.id === 'sf1');
    expect(sf1Edge, 'edge sf1 not found').toBeDefined();
    expect(sf1Edge.label?.bounds, 'sf1 label bounds should be defined for a named edge').toBeDefined();
    // sf2 has no name → stale bounds must be cleared
    const sf2Edge = edges.find((e: any) => e.bpmnElement.id === 'sf2');
    expect(sf2Edge, 'edge sf2 not found').toBeDefined();
    expect(sf2Edge.label?.bounds).toBeUndefined();
  });
});

// ─── labels included in layout ───────────────────────────────────────────────

describe('labels included in layout', () => {
  it('event shapes with names have label bounds set after layout', async () => {
    const result = await layout(fixture('labeled-elements.bpmn'));
    const { shapes } = await parseDi(result);
    const byId = Object.fromEntries(shapes.map((s: any) => [s.bpmnElement.id, s]));
    expect(byId['start1'].label?.bounds, 'start1 label bounds missing').toBeDefined();
    expect(byId['end1'].label?.bounds,   'end1 label bounds missing').toBeDefined();
  });

  it('event label is positioned below the event shape', async () => {
    const result = await layout(fixture('labeled-elements.bpmn'));
    const { shapes } = await parseDi(result);
    const byId = Object.fromEntries(shapes.map((s: any) => [s.bpmnElement.id, s]));
    for (const id of ['start1', 'end1']) {
      const shape = byId[id];
      const lb = shape.label.bounds;
      expect(
        lb.y,
        `${id} label top (${lb.y}) should be at or below shape bottom (${shape.bounds.y + shape.bounds.height})`,
      ).toBeGreaterThanOrEqual(shape.bounds.y + shape.bounds.height);
    }
  });

  it('event label is horizontally centered near the event shape', async () => {
    const result = await layout(fixture('labeled-elements.bpmn'));
    const { shapes } = await parseDi(result);
    const byId = Object.fromEntries(shapes.map((s: any) => [s.bpmnElement.id, s]));
    for (const id of ['start1', 'end1']) {
      const shape = byId[id];
      const shapeCx = shape.bounds.x + shape.bounds.width / 2;
      const lb = shape.label.bounds;
      const labelCx = lb.x + lb.width / 2;
      expect(
        Math.abs(labelCx - shapeCx),
        `${id} label center (${labelCx}) should be near shape center (${shapeCx})`,
      ).toBeLessThanOrEqual(lb.width / 2 + 5);
    }
  });

  it('gateway shape with name has label bounds set after layout', async () => {
    const result = await layout(fixture('labeled-elements.bpmn'));
    const { shapes } = await parseDi(result);
    const byId = Object.fromEntries(shapes.map((s: any) => [s.bpmnElement.id, s]));
    expect(byId['gw1'].label?.bounds, 'gw1 label bounds missing').toBeDefined();
  });

  it('gateway label is positioned below the gateway shape', async () => {
    const result = await layout(fixture('labeled-elements.bpmn'));
    const { shapes } = await parseDi(result);
    const byId = Object.fromEntries(shapes.map((s: any) => [s.bpmnElement.id, s]));
    const gw = byId['gw1'];
    const lb = gw.label.bounds;
    expect(
      lb.y,
      `gw1 label top (${lb.y}) should be at or below gateway bottom (${gw.bounds.y + gw.bounds.height})`,
    ).toBeGreaterThanOrEqual(gw.bounds.y + gw.bounds.height);
  });

  it('named sequence flow has label bounds set after layout', async () => {
    const result = await layout(fixture('labeled-elements.bpmn'));
    const { edges } = await parseDi(result);
    const sf2 = edges.find((e: any) => e.bpmnElement.id === 'sf2');
    expect(sf2, 'edge sf2 not found').toBeDefined();
    expect(sf2.label?.bounds, 'sf2 label bounds should be set for a named sequence flow').toBeDefined();
  });

  it('sequence flow label is positioned within the edge bounding box', async () => {
    const result = await layout(fixture('labeled-elements.bpmn'));
    const { edges } = await parseDi(result);
    const sf2 = edges.find((e: any) => e.bpmnElement.id === 'sf2');
    expect(sf2).toBeDefined();
    const wps: Array<{ x: number; y: number }> = sf2.waypoint;
    const minX = Math.min(...wps.map((p: any) => p.x));
    const maxX = Math.max(...wps.map((p: any) => p.x));
    const minY = Math.min(...wps.map((p: any) => p.y));
    const maxY = Math.max(...wps.map((p: any) => p.y));
    const lb = sf2.label.bounds;
    const labelCx = lb.x + lb.width / 2;
    const labelCy = lb.y + lb.height / 2;
    const tol = 30;
    expect(labelCx, `sf2 label center x (${labelCx}) out of edge x range [${minX},${maxX}]`).toBeGreaterThanOrEqual(minX - tol);
    expect(labelCx, `sf2 label center x (${labelCx}) out of edge x range [${minX},${maxX}]`).toBeLessThanOrEqual(maxX + tol);
    expect(labelCy, `sf2 label center y (${labelCy}) out of edge y range [${minY},${maxY}]`).toBeGreaterThanOrEqual(minY - tol);
    expect(labelCy, `sf2 label center y (${labelCy}) out of edge y range [${minY},${maxY}]`).toBeLessThanOrEqual(maxY + tol);
  });
});

// ─── collapsed subprocess ─────────────────────────────────────────────────────

describe('collapsed subprocess', () => {
  it('the collapsed subprocess shape has isExpanded === false', async () => {
    const result = await layout(fixture('collapsed-subprocess.bpmn'));
    const { shapes } = await parseDi(result);
    const sub1Shape = shapes.find((s: any) => s.bpmnElement.id === 'sub1');
    expect(sub1Shape, 'shape for sub1 not found').toBeDefined();
    expect(sub1Shape.isExpanded).toBe(false);
  });

  it('internal elements of the collapsed subprocess have no shapes in the output', async () => {
    const result = await layout(fixture('collapsed-subprocess.bpmn'));
    const { shapes } = await parseDi(result);
    const ids = shapes.map((s: any) => s.bpmnElement.id);
    expect(ids).not.toContain('innerStart');
    expect(ids).not.toContain('innerTask');
    expect(ids).not.toContain('innerEnd');
  });

  it('process-level elements are laid out left-to-right: start1 < sub1 < end1', async () => {
    const result = await layout(fixture('collapsed-subprocess.bpmn'));
    const { shapes } = await parseDi(result);
    const byId = Object.fromEntries(shapes.map((s: any) => [s.bpmnElement.id, s.bounds]));
    expect(byId['start1']).toBeDefined();
    expect(byId['sub1']).toBeDefined();
    expect(byId['end1']).toBeDefined();
    expect(byId['start1'].x).toBeLessThan(byId['sub1'].x);
    expect(byId['sub1'].x).toBeLessThan(byId['end1'].x);
  });

  it('the collapsed subprocess uses compact size (100×80)', async () => {
    const result = await layout(fixture('collapsed-subprocess.bpmn'));
    const { shapes } = await parseDi(result);
    const sub1Shape = shapes.find((s: any) => s.bpmnElement.id === 'sub1');
    expect(sub1Shape.bounds.width).toBe(100);
    expect(sub1Shape.bounds.height).toBe(80);
  });
});

// ─── pools (collaboration) ───────────────────────────────────────────────────

describe('pools (collaboration)', () => {
  it('creates a BPMNShape for each participant', async () => {
    const result = await layout(fixture('pool.bpmn'));
    const { shapes } = await parseDi(result);
    const ids = shapes.map((s: any) => s.bpmnElement.id);
    expect(ids).toContain('pool1');
    expect(ids).toContain('pool2');
  });

  it('pool shapes have valid positive dimensions', async () => {
    const result = await layout(fixture('pool.bpmn'));
    const { shapes } = await parseDi(result);
    for (const shape of shapes.filter((s: any) => ['pool1', 'pool2'].includes(s.bpmnElement.id))) {
      expect(shape.bounds.width).toBeGreaterThan(0);
      expect(shape.bounds.height).toBeGreaterThan(0);
    }
  });

  it('creates shapes for all flow nodes in both processes', async () => {
    const result = await layout(fixture('pool.bpmn'));
    const { shapes } = await parseDi(result);
    const ids = shapes.map((s: any) => s.bpmnElement.id);
    for (const id of ['start1', 'task1', 'end1', 'start2', 'task2', 'end2']) {
      expect(ids).toContain(id);
    }
  });

  it('creates edges for all sequence flows in both processes', async () => {
    const result = await layout(fixture('pool.bpmn'));
    const { edges } = await parseDi(result);
    const ids = edges.map((e: any) => e.bpmnElement.id);
    for (const id of ['sf1', 'sf2', 'sf3', 'sf4']) {
      expect(ids).toContain(id);
    }
  });

  it('pools are stacked vertically (pool2 below pool1)', async () => {
    const result = await layout(fixture('pool.bpmn'));
    const { shapes } = await parseDi(result);
    const byId = Object.fromEntries(shapes.map((s: any) => [s.bpmnElement.id, s.bounds]));
    expect(byId['pool2'].y).toBeGreaterThanOrEqual(byId['pool1'].y + byId['pool1'].height);
  });

  it('flow nodes are positioned inside their containing pool bounds', async () => {
    const result = await layout(fixture('pool.bpmn'));
    const { shapes } = await parseDi(result);
    const byId = Object.fromEntries(shapes.map((s: any) => [s.bpmnElement.id, s.bounds]));

    for (const [nodeId, poolId] of [
      ['start1', 'pool1'], ['task1', 'pool1'], ['end1', 'pool1'],
      ['start2', 'pool2'], ['task2', 'pool2'], ['end2', 'pool2'],
    ] as const) {
      const pool = byId[poolId];
      const node = byId[nodeId];
      const nodeCx = node.x + node.width / 2;
      const nodeCy = node.y + node.height / 2;
      expect(nodeCx).toBeGreaterThan(pool.x);
      expect(nodeCx).toBeLessThan(pool.x + pool.width);
      expect(nodeCy).toBeGreaterThan(pool.y);
      expect(nodeCy).toBeLessThan(pool.y + pool.height);
    }
  });
});

// ─── gateway inside event subprocess (collaboration) ─────────────────────────

describe('gateway inside event subprocess (collaboration)', () => {
  it('gateway edge endpoints land at a cardinal diamond tip (N/S/E/W)', async () => {
    const result = await layout(fixture('gateway-subprocess.bpmn'));
    const { shapes, edges } = await parseDi(result);
    const infoById = Object.fromEntries(
      shapes.map((s: any) => [s.bpmnElement.id, { bounds: s.bounds, type: s.bpmnElement.$type }]),
    );

    for (const edge of edges) {
      const srcId = edge.bpmnElement.sourceRef?.id ?? edge.bpmnElement.sourceRef;
      const tgtId = edge.bpmnElement.targetRef?.id ?? edge.bpmnElement.targetRef;

      if (GATEWAY_ELEMENT_TYPES.has(infoById[srcId]?.type)) {
        const firstWp = edge.waypoint[0];
        expect(
          isAtCardinalDiamondTip(firstWp, infoById[srcId].bounds),
          `${edge.bpmnElement.id} first wp (${firstWp.x},${firstWp.y}) is not at a cardinal tip of ${srcId} ` +
          `(x:${infoById[srcId].bounds.x} y:${infoById[srcId].bounds.y} ` +
          `w:${infoById[srcId].bounds.width} h:${infoById[srcId].bounds.height})`,
        ).toBe(true);
      }

      if (GATEWAY_ELEMENT_TYPES.has(infoById[tgtId]?.type)) {
        const lastWp = edge.waypoint[edge.waypoint.length - 1];
        expect(
          isAtCardinalDiamondTip(lastWp, infoById[tgtId].bounds),
          `${edge.bpmnElement.id} last wp (${lastWp.x},${lastWp.y}) is not at a cardinal tip of ${tgtId} ` +
          `(x:${infoById[tgtId].bounds.x} y:${infoById[tgtId].bounds.y} ` +
          `w:${infoById[tgtId].bounds.width} h:${infoById[tgtId].bounds.height})`,
        ).toBe(true);
      }
    }
  });

  it('all edge segments are axis-aligned', async () => {
    const result = await layout(fixture('gateway-subprocess.bpmn'));
    const { edges } = await parseDi(result);
    for (const edge of edges) {
      const wps: Array<{ x: number; y: number }> = edge.waypoint;
      for (let i = 0; i < wps.length - 1; i++) {
        const a = wps[i];
        const b = wps[i + 1];
        expect(
          Math.abs(a.y - b.y) <= 1 || Math.abs(a.x - b.x) <= 1,
          `edge ${edge.bpmnElement.id} segment ${i}→${i + 1}: (${a.x},${a.y})→(${b.x},${b.y}) is not axis-aligned`,
        ).toBe(true);
      }
    }
  });
});

// ─── loop (cyclic graph) ─────────────────────────────────────────────────────

describe('loop (cyclic graph)', () => {
  it('creates shapes for all 4 flow nodes', async () => {
    const result = await layout(fixture('loop.bpmn'));
    const { shapes } = await parseDi(result);
    expect(shapes).toHaveLength(4);
  });

  it('creates edges for all 4 sequence flows', async () => {
    const result = await layout(fixture('loop.bpmn'));
    const { edges } = await parseDi(result);
    expect(edges).toHaveLength(4);
  });
});
