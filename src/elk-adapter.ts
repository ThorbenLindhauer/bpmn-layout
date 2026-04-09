import BpmnModdle from 'bpmn-moddle';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, ElkExtendedEdge } from 'elkjs';

// ─── default element sizes ────────────────────────────────────────────────────

const ELEMENT_SIZES: Record<string, { width: number; height: number }> = {
  'bpmn:Task': { width: 100, height: 80 },
  'bpmn:UserTask': { width: 100, height: 80 },
  'bpmn:ServiceTask': { width: 100, height: 80 },
  'bpmn:ScriptTask': { width: 100, height: 80 },
  'bpmn:ManualTask': { width: 100, height: 80 },
  'bpmn:BusinessRuleTask': { width: 100, height: 80 },
  'bpmn:SendTask': { width: 100, height: 80 },
  'bpmn:ReceiveTask': { width: 100, height: 80 },
  'bpmn:CallActivity': { width: 100, height: 80 },
  'bpmn:StartEvent': { width: 36, height: 36 },
  'bpmn:EndEvent': { width: 36, height: 36 },
  'bpmn:IntermediateCatchEvent': { width: 36, height: 36 },
  'bpmn:IntermediateThrowEvent': { width: 36, height: 36 },
  'bpmn:BoundaryEvent': { width: 36, height: 36 },
  'bpmn:ExclusiveGateway': { width: 50, height: 50 },
  'bpmn:ParallelGateway': { width: 50, height: 50 },
  'bpmn:InclusiveGateway': { width: 50, height: 50 },
  'bpmn:EventBasedGateway': { width: 50, height: 50 },
  'bpmn:ComplexGateway': { width: 50, height: 50 },
  'bpmn:SubProcess': { width: 350, height: 200 },
  'bpmn:AdHocSubProcess': { width: 350, height: 200 },
  'bpmn:Participant': { width: 600, height: 150 },
  'bpmn:Lane': { width: 580, height: 150 },
};

const DEFAULT_SIZE = { width: 100, height: 80 };

function sizeOf(element: any) {
  return ELEMENT_SIZES[element.$type as string] ?? DEFAULT_SIZE;
}

// ─── element classification ───────────────────────────────────────────────────

const EDGE_TYPES = new Set(['bpmn:SequenceFlow', 'bpmn:MessageFlow']);

const IGNORED_TYPES = new Set([
  'bpmn:DataObjectReference',
  'bpmn:DataStoreReference',
  'bpmn:DataInputAssociation',
  'bpmn:DataOutputAssociation',
  'bpmn:Association',
  'bpmn:TextAnnotation',
  'bpmn:Property',
  'bpmn:DataObject',
]);

function isFlowNode(el: any): boolean {
  const t: string = el.$type;
  return !EDGE_TYPES.has(t) && !IGNORED_TYPES.has(t);
}

// ─── ELK layout options ───────────────────────────────────────────────────────

const ELK_LAYOUT_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.layered.spacing.nodeNodeBetweenLayers': '80',
  'elk.spacing.nodeNode': '30',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.unnecessaryBendpoints': 'true',
};

// ─── ELK graph building ───────────────────────────────────────────────────────

/**
 * Recursively build an ELK node for a BPMN process/subprocess.
 * Boundary events are excluded from ELK nodes — they are positioned separately.
 */
function buildElkChildren(
  process: any,
): { children: ElkNode[]; edges: ElkExtendedEdge[] } {
  const flowElements: any[] = process.flowElements ?? [];

  // Exclude boundary events from regular layout nodes
  const flowNodes = flowElements.filter(
    (e: any) => isFlowNode(e) && e.$type !== 'bpmn:BoundaryEvent',
  );
  const sequenceFlows = flowElements.filter((e: any) => EDGE_TYPES.has(e.$type));

  const nodeIdSet = new Set(flowNodes.map((n: any) => n.id as string));

  const children: ElkNode[] = flowNodes.map((node: any) => {
    const size = sizeOf(node);
    const elkNode: ElkNode = { id: node.id as string, width: size.width, height: size.height };

    if ((node.flowElements as any[] | undefined)?.length) {
      const sub = buildElkChildren(node);
      elkNode.children = sub.children;
      elkNode.edges = sub.edges;
      elkNode.layoutOptions = ELK_LAYOUT_OPTIONS;
    }

    return elkNode;
  });

  // Only include flows whose source AND target are both regular (non-boundary) nodes
  const edges: ElkExtendedEdge[] = sequenceFlows
    .filter((sf: any) => nodeIdSet.has(sf.sourceRef?.id) && nodeIdSet.has(sf.targetRef?.id))
    .map((sf: any) => ({
      id: sf.id as string,
      sources: [sf.sourceRef.id as string],
      targets: [sf.targetRef.id as string],
    }));

  return { children, edges };
}

function buildElkGraph(process: any): ElkNode {
  const { children, edges } = buildElkChildren(process);
  return { id: process.id as string, layoutOptions: ELK_LAYOUT_OPTIONS, children, edges };
}

// ─── collect boundary events and their flows ──────────────────────────────────

/** Walk all flowElements (including nested subprocesses) to collect boundary events. */
function collectBoundaryEvents(elements: any[], result: any[] = []): any[] {
  for (const el of elements) {
    if (el.$type === 'bpmn:BoundaryEvent') result.push(el);
    if (el.flowElements) collectBoundaryEvents(el.flowElements, result);
  }
  return result;
}

/**
 * Collect sequence flows that touch a boundary event
 * (i.e. flows that ELK does not handle because the boundary event was excluded).
 */
function collectBoundaryFlows(elements: any[], boundaryIds: Set<string>, result: any[] = []): any[] {
  for (const el of elements) {
    if (
      EDGE_TYPES.has(el.$type) &&
      (boundaryIds.has(el.sourceRef?.id) || boundaryIds.has(el.targetRef?.id))
    ) {
      result.push(el);
    }
    if (el.flowElements) collectBoundaryFlows(el.flowElements, boundaryIds, result);
  }
  return result;
}

// ─── DI building ─────────────────────────────────────────────────────────────

type Bounds = { x: number; y: number; width: number; height: number };

function extractWaypoints(edge: ElkExtendedEdge): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  for (const section of (edge as any).sections ?? []) {
    points.push(section.startPoint);
    for (const bp of section.bendPoints ?? []) points.push(bp);
    points.push(section.endPoint);
  }
  return points;
}

function collectShapesAndEdges(
  elkNode: ElkNode,
  moddle: BpmnModdle,
  elementMap: Map<string, any>,
  boundsMap: Map<string, Bounds>,
  offsetX = 0,
  offsetY = 0,
): { shapes: any[]; edges: any[] } {
  const shapes: any[] = [];
  const edges: any[] = [];

  for (const child of elkNode.children ?? []) {
    const element = elementMap.get(child.id);
    if (!element) continue;

    const absX = offsetX + (child.x ?? 0);
    const absY = offsetY + (child.y ?? 0);
    const w = child.width ?? sizeOf(element).width;
    const h = child.height ?? sizeOf(element).height;

    boundsMap.set(child.id, { x: absX, y: absY, width: w, height: h });

    shapes.push(
      (moddle as any).create('bpmndi:BPMNShape', {
        id: `${child.id}_di`,
        bpmnElement: element,
        bounds: (moddle as any).create('dc:Bounds', { x: absX, y: absY, width: w, height: h }),
      }),
    );

    if (child.children?.length) {
      const sub = collectShapesAndEdges(child, moddle, elementMap, boundsMap, absX, absY);
      shapes.push(...sub.shapes);
      edges.push(...sub.edges);
    }
  }

  for (const edge of elkNode.edges ?? []) {
    const element = elementMap.get(edge.id);
    if (!element) continue;

    const waypoints = extractWaypoints(edge as ElkExtendedEdge).map((p) =>
      (moddle as any).create('dc:Point', { x: offsetX + p.x, y: offsetY + p.y }),
    );

    edges.push(
      (moddle as any).create('bpmndi:BPMNEdge', {
        id: `${edge.id}_di`,
        bpmnElement: element,
        waypoint: waypoints,
      }),
    );
  }

  return { shapes, edges };
}

// ─── boundary event positioning ───────────────────────────────────────────────

/**
 * Place each boundary event at the bottom edge of its host activity.
 * Multiple boundary events on the same host are distributed evenly along the bottom.
 */
function positionBoundaryEvents(
  boundaryEvents: any[],
  boundsMap: Map<string, Bounds>,
  moddle: BpmnModdle,
): { shapes: any[]; newBounds: Map<string, Bounds> } {
  const shapes: any[] = [];
  const newBounds = new Map<string, Bounds>();

  // Group by host activity id
  const byHost = new Map<string, any[]>();
  for (const be of boundaryEvents) {
    const hostId: string | undefined = be.attachedToRef?.id;
    if (!hostId) continue;
    if (!byHost.has(hostId)) byHost.set(hostId, []);
    byHost.get(hostId)!.push(be);
  }

  for (const [hostId, events] of byHost) {
    const hostBounds = boundsMap.get(hostId);
    if (!hostBounds) continue;

    const count = events.length;
    for (let i = 0; i < count; i++) {
      const be = events[i];
      const size = sizeOf(be); // 36 × 36

      // Distribute evenly along the bottom edge of the host
      const fraction = (i + 1) / (count + 1);
      const cx = hostBounds.x + hostBounds.width * fraction;
      const cy = hostBounds.y + hostBounds.height; // bottom edge

      const beBounds: Bounds = {
        x: cx - size.width / 2,
        y: cy - size.height / 2,
        width: size.width,
        height: size.height,
      };

      newBounds.set(be.id as string, beBounds);

      shapes.push(
        (moddle as any).create('bpmndi:BPMNShape', {
          id: `${be.id}_di`,
          bpmnElement: be,
          bounds: (moddle as any).create('dc:Bounds', beBounds),
        }),
      );
    }
  }

  return { shapes, newBounds };
}

// ─── boundary flow edge creation ──────────────────────────────────────────────

/**
 * Find the point on the boundary of `bounds` closest to `from`,
 * by projecting the center-to-`from` ray onto the rectangle boundary.
 */
function boundaryPoint(from: { x: number; y: number }, bounds: Bounds): { x: number; y: number } {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const dx = from.x - cx;
  const dy = from.y - cy;

  if (dx === 0 && dy === 0) return { x: cx, y: bounds.y }; // degenerate

  const halfW = bounds.width / 2;
  const halfH = bounds.height / 2;
  const sx = halfW / Math.abs(dx);
  const sy = halfH / Math.abs(dy);
  const s = Math.min(sx, sy);

  return { x: Math.round(cx + dx * s), y: Math.round(cy + dy * s) };
}

/**
 * Create BPMNEdge elements for flows whose source or target is a boundary event.
 * Uses two waypoints: source-side boundary → target-side boundary.
 */
function createBoundaryFlowEdges(
  boundaryFlows: any[],
  allBoundsMap: Map<string, Bounds>,
  elementMap: Map<string, any>,
  moddle: BpmnModdle,
): any[] {
  const edges: any[] = [];

  for (const flow of boundaryFlows) {
    const srcId: string = flow.sourceRef?.id;
    const tgtId: string = flow.targetRef?.id;
    const srcBounds = allBoundsMap.get(srcId);
    const tgtBounds = allBoundsMap.get(tgtId);
    if (!srcBounds || !tgtBounds) continue;

    const srcCenter = { x: srcBounds.x + srcBounds.width / 2, y: srcBounds.y + srcBounds.height / 2 };
    const tgtCenter = { x: tgtBounds.x + tgtBounds.width / 2, y: tgtBounds.y + tgtBounds.height / 2 };

    const wp0 = boundaryPoint(tgtCenter, srcBounds);
    const wp1 = boundaryPoint(srcCenter, tgtBounds);

    const element = elementMap.get(flow.id);
    if (!element) continue;

    edges.push(
      (moddle as any).create('bpmndi:BPMNEdge', {
        id: `${flow.id}_di`,
        bpmnElement: element,
        waypoint: [
          (moddle as any).create('dc:Point', wp0),
          (moddle as any).create('dc:Point', wp1),
        ],
      }),
    );
  }

  return edges;
}

// ─── element map ─────────────────────────────────────────────────────────────

function buildElementMap(elements: any[], map = new Map<string, any>()): Map<string, any> {
  for (const el of elements) {
    if (el.id) map.set(el.id as string, el);
    if (el.flowElements) buildElementMap(el.flowElements, map);
    if (el.participants) buildElementMap(el.participants, map);
    if (el.lanes) buildElementMap(el.lanes, map);
  }
  return map;
}

// ─── public API ──────────────────────────────────────────────────────────────

export async function layoutBpmn(bpmnXml: string): Promise<string> {
  const moddle = new BpmnModdle();
  const elk = new ELK();

  const { rootElement } = (await (moddle as any).fromXML(bpmnXml)) as { rootElement: any };
  const definitions = rootElement;

  const processes: any[] = (definitions.rootElements as any[]).filter(
    (e: any) => e.$type === 'bpmn:Process',
  );

  const elementMap = buildElementMap(definitions.rootElements as any[]);

  if (!definitions.diagrams?.length) {
    const mainProcess = processes[0];
    const plane = (moddle as any).create('bpmndi:BPMNPlane', {
      id: 'plane1',
      bpmnElement: mainProcess,
    });
    definitions.diagrams = [
      (moddle as any).create('bpmndi:BPMNDiagram', { id: 'diagram1', plane }),
    ];
  }

  const plane = definitions.diagrams[0].plane;
  plane.planeElement = [];

  // Shared bounds map populated as we place shapes
  const boundsMap = new Map<string, Bounds>();

  // Collect all boundary events and boundary-touching flows across processes
  const allBoundaryEvents: any[] = [];
  const allBoundaryFlows: any[] = [];

  for (const process of processes) {
    const boundaryEvents = collectBoundaryEvents(process.flowElements ?? []);
    allBoundaryEvents.push(...boundaryEvents);

    const boundaryIds = new Set(boundaryEvents.map((be: any) => be.id as string));
    const boundaryFlows = collectBoundaryFlows(process.flowElements ?? [], boundaryIds);
    allBoundaryFlows.push(...boundaryFlows);

    const elkGraph = buildElkGraph(process);
    const laidOut = await elk.layout(elkGraph);
    const { shapes, edges } = collectShapesAndEdges(laidOut, moddle, elementMap, boundsMap);
    plane.planeElement.push(...shapes, ...edges);
  }

  // Position boundary events on their host activity boundary
  const { shapes: beShapes, newBounds: beBoundsMap } = positionBoundaryEvents(
    allBoundaryEvents,
    boundsMap,
    moddle,
  );
  plane.planeElement.push(...beShapes);

  // Merge boundary event bounds into the shared map for edge routing below
  for (const [id, b] of beBoundsMap) boundsMap.set(id, b);

  // Create edges for flows involving boundary events
  const beEdges = createBoundaryFlowEdges(allBoundaryFlows, boundsMap, elementMap, moddle);
  plane.planeElement.push(...beEdges);

  const { xml } = await (moddle as any).toXML(definitions, { format: true });
  return xml as string;
}
