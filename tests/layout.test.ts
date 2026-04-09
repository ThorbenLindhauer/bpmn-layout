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
