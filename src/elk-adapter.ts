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
 * Build an ELK node for a BPMN process/subprocess.
 *
 * Boundary events are modelled as zero-size ELK **ports** on their host
 * activity with side=SOUTH.  This keeps them in the topology so ELK can
 * route their outgoing/incoming flows without crossings, while still
 * producing a host-boundary connection point.
 */
function buildElkChildren(
  process: any,
  isExpandedMap: Map<string, boolean> = new Map(),
): { children: ElkNode[]; edges: ElkExtendedEdge[] } {
  const flowElements: any[] = process.flowElements ?? [];

  // Separate boundary events from regular layout nodes
  const boundaryEvents = flowElements.filter((e: any) => e.$type === 'bpmn:BoundaryEvent');
  const regularFlowNodes = flowElements.filter(
    (e: any) => isFlowNode(e) && e.$type !== 'bpmn:BoundaryEvent',
  );
  const allFlows = flowElements.filter((e: any) => EDGE_TYPES.has(e.$type));

  const regularNodeIds = new Set(regularFlowNodes.map((n: any) => n.id as string));
  const boundaryEventIds = new Set(boundaryEvents.map((be: any) => be.id as string));
  // Both regular nodes and boundary-event ports can be edge endpoints
  const connectableIds = new Set([...regularNodeIds, ...boundaryEventIds]);

  // Group boundary events by their host node id
  const beByHost = new Map<string, any[]>();
  for (const be of boundaryEvents) {
    const hostId: string | undefined = be.attachedToRef?.id;
    if (!hostId) continue;
    if (!beByHost.has(hostId)) beByHost.set(hostId, []);
    beByHost.get(hostId)!.push(be);
  }

  const children: ElkNode[] = regularFlowNodes.map((node: any) => {
    const size = sizeOf(node);
    const bEvents = beByHost.get(node.id as string) ?? [];

    const elkNode: ElkNode = {
      id: node.id as string,
      width: size.width,
      height: size.height,
    };

    // Model boundary events as zero-size SOUTH ports so ELK knows about
    // their connections when computing node layers and edge routes.
    if (bEvents.length > 0) {
      elkNode.layoutOptions = { 'elk.portConstraints': 'FIXED_SIDE' };
      elkNode.ports = bEvents.map((be: any) => ({
        id: be.id as string,
        width: 0,
        height: 0,
        layoutOptions: { 'elk.port.side': 'SOUTH' },
      }));
    }

    // Recurse into subprocesses, respecting isExpanded from original DI
    const expandedOverride = isExpandedMap.get(node.id as string);
    if (expandedOverride === false) {
      // Collapsed subprocess: use compact size so ELK routes flows correctly,
      // and skip child recursion since internal elements aren't visible.
      elkNode.width = DEFAULT_SIZE.width;
      elkNode.height = DEFAULT_SIZE.height;
    } else if ((node.flowElements as any[] | undefined)?.length) {
      const sub = buildElkChildren(node, isExpandedMap);
      elkNode.children = sub.children;
      elkNode.edges = sub.edges;
      elkNode.layoutOptions = { ...elkNode.layoutOptions, ...ELK_LAYOUT_OPTIONS };
    }

    return elkNode;
  });

  // Include all flows where both endpoints are regular nodes OR boundary-event ports
  const edges: ElkExtendedEdge[] = allFlows
    .filter((sf: any) => connectableIds.has(sf.sourceRef?.id) && connectableIds.has(sf.targetRef?.id))
    .map((sf: any) => ({
      id: sf.id as string,
      sources: [sf.sourceRef.id as string],
      targets: [sf.targetRef.id as string],
    }));

  return { children, edges };
}

function buildElkGraph(process: any, isExpandedMap: Map<string, boolean> = new Map()): ElkNode {
  const { children, edges } = buildElkChildren(process, isExpandedMap);
  return { id: process.id as string, layoutOptions: ELK_LAYOUT_OPTIONS, children, edges };
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

/**
 * Walk ELK output nodes/edges and create BPMNShape/BPMNEdge DI elements.
 * Also processes ports (boundary events) nested inside each child node.
 */
function collectShapesAndEdges(
  elkNode: ElkNode,
  moddle: BpmnModdle,
  elementMap: Map<string, any>,
  boundsMap: Map<string, Bounds>,
  offsetX = 0,
  offsetY = 0,
  existingShapes: Map<string, any> = new Map(),
  existingEdges: Map<string, any> = new Map(),
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

    const newBounds = (moddle as any).create('dc:Bounds', { x: absX, y: absY, width: w, height: h });
    const existingShape = existingShapes.get(child.id);
    if (existingShape) {
      existingShape.bounds = newBounds;
      shapes.push(existingShape);
    } else {
      shapes.push(
        (moddle as any).create('bpmndi:BPMNShape', {
          id: `${child.id}_di`,
          bpmnElement: element,
          bounds: newBounds,
        }),
      );
    }

    // ── boundary events modelled as ELK ports ────────────────────────────
    for (const port of child.ports ?? []) {
      const portElement = elementMap.get(port.id);
      if (!portElement) continue;

      // The port is zero-size and sits at the host boundary.
      // portX / portY are relative to child; the port's (x,y) IS the
      // centre of the rendered boundary-event shape.
      const portCX = absX + (port.x ?? 0);
      const portCY = absY + (port.y ?? 0);
      const size = sizeOf(portElement);

      const beBounds: Bounds = {
        x: portCX - size.width / 2,
        y: portCY - size.height / 2,
        width: size.width,
        height: size.height,
      };

      boundsMap.set(port.id as string, beBounds);

      const existingPortShape = existingShapes.get(port.id as string);
      if (existingPortShape) {
        existingPortShape.bounds = (moddle as any).create('dc:Bounds', beBounds);
        shapes.push(existingPortShape);
      } else {
        shapes.push(
          (moddle as any).create('bpmndi:BPMNShape', {
            id: `${port.id}_di`,
            bpmnElement: portElement,
            bounds: (moddle as any).create('dc:Bounds', beBounds),
          }),
        );
      }
    }

    // Recurse into subprocesses
    if (child.children?.length) {
      const sub = collectShapesAndEdges(child, moddle, elementMap, boundsMap, absX, absY, existingShapes, existingEdges);
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

    const existingEdge = existingEdges.get(edge.id);
    if (existingEdge) {
      existingEdge.waypoint = waypoints;
      edges.push(existingEdge);
    } else {
      edges.push(
        (moddle as any).create('bpmndi:BPMNEdge', {
          id: `${edge.id}_di`,
          bpmnElement: element,
          waypoint: waypoints,
        }),
      );
    }
  }

  return { shapes, edges };
}

// ─── visual boundary geometry ─────────────────────────────────────────────────

/** BPMN element types that render as a diamond (rhombus) rather than a rectangle. */
const GATEWAY_TYPES = new Set([
  'bpmn:ExclusiveGateway', 'bpmn:ParallelGateway', 'bpmn:InclusiveGateway',
  'bpmn:EventBasedGateway', 'bpmn:ComplexGateway',
]);

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

/** True when a, b, c all share the same x **or** the same y coordinate. */
function collinear(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): boolean {
  return (
    (Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5) ||
    (Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5)
  );
}

/**
 * Snap a gateway source/target endpoint to the correct cardinal diamond vertex
 * and insert an orthogonal elbow waypoint if the vertex doesn't share an axis
 * with the adjacent bend point.
 *
 * ELK routes edges to the *bounding-box* face of gateways and may spread
 * multiple connections across the face at different offsets from the centre.
 * Simply moving the endpoint to the diamond surface while leaving the rest of
 * the path unchanged creates a diagonal first (or last) segment.
 *
 * The fix: choose the cardinal vertex (right/left/top/bottom tip of the
 * diamond) whose side the adjacent waypoint is approaching from, then insert
 * an elbow point so the path stays fully rectilinear.
 *
 * The entry/exit side is determined by comparing the adjacent waypoint to the
 * gateway **centre** — not to the original ELK endpoint — so that a prior
 * elbow insertion for the opposite end does not confuse the direction.
 */
function snapGatewayEndpoint(
  wps: any[],
  isSource: boolean,
  bounds: Bounds,
  moddle: any,
): void {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const halfW = bounds.width / 2;
  const halfH = bounds.height / 2;

  const epIdx = isSource ? 0 : wps.length - 1;
  const adjIdx = isSource ? 1 : wps.length - 2;
  const adj = wps[adjIdx];

  // Use adj's offset from the gateway centre to choose which diamond vertex
  // the edge connects to.  This is robust even when a prior elbow insertion
  // for the other endpoint changes the last/first segment direction.
  const horizontal = Math.abs(adj.x - cx) > Math.abs(adj.y - cy);

  const vertex = horizontal
    ? { x: Math.round(adj.x > cx ? cx + halfW : cx - halfW), y: Math.round(cy) }
    : { x: Math.round(cx), y: Math.round(adj.y > cy ? cy + halfH : cy - halfH) };

  wps[epIdx] = (moddle as any).create('dc:Point', vertex);

  // Insert an elbow between vertex and adj when they don't already share the
  // appropriate axis-aligned coordinate.
  const needsElbow = horizontal
    ? Math.abs(vertex.y - adj.y) > 0.5
    : Math.abs(vertex.x - adj.x) > 0.5;

  if (!needsElbow) return;

  // For H exits/entries the elbow sits at (adj.x, vertex.y): go horizontal
  // along the diamond axis first, then turn vertically toward adj.y.
  // For V exits/entries: (vertex.x, adj.y).
  const elbow = horizontal
    ? { x: Math.round(adj.x), y: vertex.y }
    : { x: vertex.x, y: Math.round(adj.y) };
  const elbowPt = (moddle as any).create('dc:Point', elbow);

  if (isSource) {
    wps.splice(1, 0, elbowPt);
    // adj is now at index 2.  Remove it if it became collinear with its
    // new neighbours (elbow at 1, next bend at 3) — this happens when ELK
    // placed the first bend directly above/below the elbow (same x or y),
    // which would produce a redundant U-turn jog.
    if (wps.length > 3 && collinear(wps[1], wps[2], wps[3])) {
      wps.splice(2, 1);
    }
  } else {
    wps.splice(wps.length - 1, 0, elbowPt);
    // adj is now at index n-3; remove if collinear with prev (n-4) and elbow (n-2).
    const n = wps.length;
    if (n > 3 && collinear(wps[n - 4], wps[n - 3], wps[n - 2])) {
      wps.splice(n - 3, 1);
    }
  }
}

/**
 * Post-process all BPMNEdge waypoints:
 *
 *  - Gateways: snap to the cardinal diamond vertex and insert an elbow so
 *    all segments remain axis-aligned.
 *  - Boundary events (source only): the ELK port is zero-size; snap the first
 *    waypoint from the port centre to the rendered 36×36 shape boundary.
 *  - All other shapes: ELK's orthogonal routing already places waypoints
 *    correctly on the rectangle boundary — leave them as-is.
 */
function snapConnectionEndpoints(
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
    const tgtId: string | undefined = el.bpmnElement.targetRef?.id;

    if (srcId) {
      const src = elementMap.get(srcId);
      const srcBounds = boundsMap.get(srcId);
      if (src && srcBounds) {
        if (GATEWAY_TYPES.has(src.$type as string)) {
          snapGatewayEndpoint(wps, true, srcBounds, moddle);
        } else if (src.$type === 'bpmn:BoundaryEvent') {
          // Move first waypoint from zero-size port centre to shape perimeter.
          const snapped = rectangleBoundaryPoint({ x: wps[1].x, y: wps[1].y }, srcBounds);
          wps[0] = (moddle as any).create('dc:Point', snapped);
        }
      }
    }

    if (tgtId) {
      const tgt = elementMap.get(tgtId);
      const tgtBounds = boundsMap.get(tgtId);
      if (tgt && tgtBounds && GATEWAY_TYPES.has(tgt.$type as string)) {
        snapGatewayEndpoint(wps, false, tgtBounds, moddle);
      }
    }
  }
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

  // Build maps of existing DI elements before replacing planeElement.
  // collectShapesAndEdges will update existing objects in-place (preserving
  // isExpanded and any other DI attributes) rather than creating new ones.
  const existingShapes = new Map<string, any>();
  const existingEdges = new Map<string, any>();
  const isExpandedMap = new Map<string, boolean>();

  for (const el of (plane.planeElement as any[]) ?? []) {
    if (el.$type === 'bpmndi:BPMNShape') {
      existingShapes.set(el.bpmnElement.id as string, el);
      if (typeof el.isExpanded === 'boolean') {
        isExpandedMap.set(el.bpmnElement.id as string, el.isExpanded);
      }
    } else if (el.$type === 'bpmndi:BPMNEdge') {
      existingEdges.set(el.bpmnElement.id as string, el);
    }
  }

  const boundsMap = new Map<string, Bounds>();
  const allShapes: any[] = [];
  const allEdges: any[] = [];

  for (const process of processes) {
    const elkGraph = buildElkGraph(process, isExpandedMap);
    const laidOut = await elk.layout(elkGraph);
    const { shapes, edges } = collectShapesAndEdges(
      laidOut, moddle, elementMap, boundsMap, 0, 0, existingShapes, existingEdges,
    );
    allShapes.push(...shapes);
    allEdges.push(...edges);
  }

  // Replace planeElement: stale DI is excluded (only ELK-laid-out elements kept),
  // but existing objects carry their original non-layout attributes unchanged.
  plane.planeElement = [...allShapes, ...allEdges];

  // Snap edge endpoints to the visual boundary of source/target shapes.
  // Gateways use diamond geometry; all other shapes use rectangle geometry.
  snapConnectionEndpoints(plane, boundsMap, elementMap, moddle);

  const { xml } = await (moddle as any).toXML(definitions, { format: true });
  return xml as string;
}
