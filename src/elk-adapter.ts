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
  'elk.layered.nodePlacement.favorStraightEdges': 'true',
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
    const isGateway = GATEWAY_TYPES.has(node.$type as string);

    const elkNode: ElkNode = {
      id: node.id as string,
      width: size.width,
      height: size.height,
    };

    if (isGateway) {
      // Model the gateway with 4 fixed-position ports at the diamond cardinal vertices.
      // portConstraints=FIXED_POS tells ELK these positions are exact and immovable.
      // Edges that name only the node ID (not a port ID) are auto-assigned by ELK's
      // PortAssignmentProcessor to the best-fitting port (EAST for rightward flows,
      // NORTH/SOUTH for flows to elements above/below, WEST for backward/loop flows).
      // Synthetic IDs use double-underscore so they never clash with real BPMN IDs
      // and are safely skipped in collectShapesAndEdges (not present in elementMap).
      const { width: w, height: h } = size;
      elkNode.layoutOptions = { 'elk.portConstraints': 'FIXED_POS' };
      elkNode.ports = [
        { id: `${node.id as string}__N`, width: 0, height: 0, x: w / 2, y: 0,   layoutOptions: { 'elk.port.side': 'NORTH' } },
        { id: `${node.id as string}__S`, width: 0, height: 0, x: w / 2, y: h,   layoutOptions: { 'elk.port.side': 'SOUTH' } },
        { id: `${node.id as string}__E`, width: 0, height: 0, x: w,     y: h/2, layoutOptions: { 'elk.port.side': 'EAST'  } },
        { id: `${node.id as string}__W`, width: 0, height: 0, x: 0,     y: h/2, layoutOptions: { 'elk.port.side': 'WEST'  } },
      ];
      // Gateways cannot host boundary events per the BPMN spec (BoundaryEvent.attachedToRef
      // must be an Activity subtype). Guard is defensive only.
      if (bEvents.length > 0) {
        elkNode.ports.push(...bEvents.map((be: any) => ({
          id: be.id as string,
          width: 0,
          height: 0,
          layoutOptions: { 'elk.port.side': 'SOUTH' },
        })));
      }
    } else if (bEvents.length > 0) {
      // Non-gateway node with boundary events: use FIXED_SIDE (unchanged behaviour).
      elkNode.layoutOptions = { 'elk.portConstraints': 'FIXED_SIDE' };
      elkNode.ports = bEvents.map((be: any) => ({
        id: be.id as string,
        width: 0,
        height: 0,
        layoutOptions: { 'elk.port.side': 'SOUTH' },
      }));
    }

    // Recurse into subprocesses
    if ((node.flowElements as any[] | undefined)?.length) {
      const sub = buildElkChildren(node);
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

function buildElkGraph(process: any): ElkNode {
  const { children, edges } = buildElkChildren(process);
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

      shapes.push(
        (moddle as any).create('bpmndi:BPMNShape', {
          id: `${port.id}_di`,
          bpmnElement: portElement,
          bounds: (moddle as any).create('dc:Bounds', beBounds),
        }),
      );
    }

    // Recurse into subprocesses
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

// ─── two-pass gateway port assignment ────────────────────────────────────────

/**
 * Build a map from node ID to absolute layout bounds from an ELK result tree.
 */
function buildElkPositionMap(
  node: ElkNode,
  map = new Map<string, { x: number; y: number; width: number; height: number }>(),
  offsetX = 0,
  offsetY = 0,
): Map<string, { x: number; y: number; width: number; height: number }> {
  for (const child of node.children ?? []) {
    const x = offsetX + (child.x ?? 0);
    const y = offsetY + (child.y ?? 0);
    map.set(child.id, { x, y, width: child.width ?? 0, height: child.height ?? 0 });
    if (child.children?.length) buildElkPositionMap(child, map, x, y);
  }
  return map;
}

/**
 * Patch edge sources/targets in the ELK input graph to use explicit cardinal
 * port IDs for gateway endpoints, based on the relative centre-to-centre
 * direction observed in the Pass-1 layout result.
 *
 * Port selection for a gateway SOURCE:
 *   – target is above (dy < −¼ gateway height)  → __N
 *   – target is below (dy > +¼ gateway height)  → __S
 *   – target is to the right or same level       → __E
 *   – target is to the left (back-edge/loop)     → __W
 *
 * Port selection for a gateway TARGET is symmetric: choose the port on the
 * face the edge arrives from.
 *
 * The ¼-height threshold avoids changing near-horizontal edges to N/S while
 * correctly routing genuinely upward/downward branches.
 */
function assignGatewayPortsFromLayout(
  elkGraph: ElkNode,
  layoutResult: ElkNode,
  gatewayIds: Set<string>,
): void {
  const posMap = buildElkPositionMap(layoutResult);

  function patch(node: ElkNode): void {
    for (const edge of (node.edges ?? []) as ElkExtendedEdge[]) {
      const rawSrc = edge.sources[0] ?? '';
      const rawTgt = edge.targets[0] ?? '';
      // Skip edges that already carry explicit port IDs (boundary-event ports).
      if (rawSrc.includes('__') || rawTgt.includes('__')) continue;

      const isSrcGw = gatewayIds.has(rawSrc);
      const isTgtGw = gatewayIds.has(rawTgt);
      if (!isSrcGw && !isTgtGw) continue;

      const srcPos = posMap.get(rawSrc);
      const tgtPos = posMap.get(rawTgt);
      if (!srcPos || !tgtPos) continue;

      const srcCx = srcPos.x + srcPos.width / 2;
      const srcCy = srcPos.y + srcPos.height / 2;
      const tgtCx = tgtPos.x + tgtPos.width / 2;
      const tgtCy = tgtPos.y + tgtPos.height / 2;

      if (isSrcGw) {
        const dx = tgtCx - srcCx;
        const dy = tgtCy - srcCy;
        const thr = srcPos.height / 4;
        let port: string;
        if (dy < -thr) port = `${rawSrc}__N`;
        else if (dy > thr) port = `${rawSrc}__S`;
        else port = dx >= 0 ? `${rawSrc}__E` : `${rawSrc}__W`;
        edge.sources = [port];
      }

      if (isTgtGw) {
        // Approach direction: from source toward target.
        const dx = srcCx - tgtCx;  // positive ⇒ source is to the right of target
        const dy = srcCy - tgtCy;  // positive ⇒ source is below target
        const thr = tgtPos.height / 4;
        let port: string;
        if (dy < -thr) port = `${rawTgt}__N`;  // source above → enters from top
        else if (dy > thr) port = `${rawTgt}__S`;  // source below → enters from bottom
        else port = dx >= 0 ? `${rawTgt}__E` : `${rawTgt}__W`;
        edge.targets = [port];
      }
    }
    for (const child of node.children ?? []) {
      if (child.children?.length) patch(child);
    }
  }

  patch(elkGraph);
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

  const boundsMap = new Map<string, Bounds>();

  for (const process of processes) {
    const elkGraph = buildElkGraph(process);

    // Two-pass layout for processes that contain gateways:
    //
    // Pass 1 — let ELK auto-assign ports and establish rough node positions.
    // Pass 2 — re-assign each gateway edge to the cardinal port (N/S/E/W) that
    //           faces the connected node, then re-run ELK so it plans routes
    //           from/to the exact diamond vertices.
    //
    // We clone the input for Pass 1 so ELK's internal mutations (if any) do not
    // affect the graph we modify for Pass 2.
    const gatewayIds = new Set<string>(
      ((process.flowElements as any[]) ?? [])
        .filter((e: any) => GATEWAY_TYPES.has(e.$type as string))
        .map((e: any) => e.id as string),
    );

    if (gatewayIds.size > 0) {
      const pass1 = await elk.layout(JSON.parse(JSON.stringify(elkGraph)) as ElkNode);
      assignGatewayPortsFromLayout(elkGraph, pass1, gatewayIds);
    }

    const laidOut = await elk.layout(elkGraph);
    const { shapes, edges } = collectShapesAndEdges(laidOut, moddle, elementMap, boundsMap);
    plane.planeElement.push(...shapes, ...edges);
  }

  // Snap edge endpoints to the visual boundary of source/target shapes.
  // Gateways use diamond geometry; all other shapes use rectangle geometry.
  snapConnectionEndpoints(plane, boundsMap, elementMap, moddle);

  const { xml } = await (moddle as any).toXML(definitions, { format: true });
  return xml as string;
}
