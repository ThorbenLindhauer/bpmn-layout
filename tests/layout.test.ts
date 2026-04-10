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

describe('sequence flow waypoints connect to shape boundaries', () => {
  it('first waypoint of every edge lies on its source shape boundary', async () => {
    const result = await layout(fixture('gateway-connection.bpmn'));
    const { shapes, edges } = await parseDi(result);
    const boundsById = Object.fromEntries(shapes.map((s: any) => [s.bpmnElement.id, s.bounds]));

    for (const edge of edges) {
      const srcId = edge.bpmnElement.sourceRef?.id ?? edge.bpmnElement.sourceRef;
      const firstWp = edge.waypoint[0];
      const srcBounds = boundsById[srcId];
      expect(srcBounds, `bounds not found for source ${srcId}`).toBeDefined();
      expect(
        isOnBoundary(firstWp, srcBounds),
        `first waypoint (${firstWp.x},${firstWp.y}) of ${edge.bpmnElement.id} is not on boundary of source ${srcId} ` +
        `(x:${srcBounds.x} y:${srcBounds.y} w:${srcBounds.width} h:${srcBounds.height})`,
      ).toBe(true);
    }
  });

  it('last waypoint of every edge lies on its target shape boundary', async () => {
    const result = await layout(fixture('gateway-connection.bpmn'));
    const { shapes, edges } = await parseDi(result);
    const boundsById = Object.fromEntries(shapes.map((s: any) => [s.bpmnElement.id, s.bounds]));

    for (const edge of edges) {
      const tgtId = edge.bpmnElement.targetRef?.id ?? edge.bpmnElement.targetRef;
      const lastWp = edge.waypoint[edge.waypoint.length - 1];
      const tgtBounds = boundsById[tgtId];
      expect(tgtBounds, `bounds not found for target ${tgtId}`).toBeDefined();
      expect(
        isOnBoundary(lastWp, tgtBounds),
        `last waypoint (${lastWp.x},${lastWp.y}) of ${edge.bpmnElement.id} is not on boundary of target ${tgtId} ` +
        `(x:${tgtBounds.x} y:${tgtBounds.y} w:${tgtBounds.width} h:${tgtBounds.height})`,
      ).toBe(true);
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
