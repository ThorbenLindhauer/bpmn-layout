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

// ─── label size estimation ────────────────────────────────────────────────────

const LABEL_CHAR_WIDTH  = 7;    // avg px per character
const LABEL_LINE_HEIGHT = 14;   // px per line
const LABEL_MAX_WIDTH   = 100;  // wrap after this many px

function estimateLabelSize(name: string): { width: number; height: number } {
  const totalPx = name.length * LABEL_CHAR_WIDTH;
  const width   = Math.min(totalPx, LABEL_MAX_WIDTH);
  const lines   = Math.max(1, Math.ceil(totalPx / LABEL_MAX_WIDTH));
  return { width, height: lines * LABEL_LINE_HEIGHT };
}

/** Element types whose labels render OUTSIDE (below) the shape bounds. */
const EXTERNAL_LABEL_TYPES = new Set([
  'bpmn:StartEvent', 'bpmn:EndEvent',
  'bpmn:IntermediateCatchEvent', 'bpmn:IntermediateThrowEvent', 'bpmn:BoundaryEvent',
  'bpmn:ExclusiveGateway', 'bpmn:ParallelGateway', 'bpmn:InclusiveGateway',
  'bpmn:EventBasedGateway', 'bpmn:ComplexGateway',
]);

// ─── pool layout constants ────────────────────────────────────────────────────

const POOL_LABEL_WIDTH = 30;   // width of the pool name label column on the left
const POOL_PADDING     = 20;   // padding inside each pool around the ELK content
const PARTICIPANT_GAP  = 20;   // vertical gap between consecutive pools

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

    // For events and gateways with names, add an ELK label so the layout engine
    // reserves space below the shape and prevents other elements from overlapping
    // the rendered label area.
    const nodeName = node.name as string | undefined;
    if (nodeName && EXTERNAL_LABEL_TYPES.has(node.$type as string)) {
      const lblSize = estimateLabelSize(nodeName);
      elkNode.labels = [{ id: `${node.id as string}_label`, text: nodeName, ...lblSize }];
      elkNode.layoutOptions = {
        ...elkNode.layoutOptions,
        'elk.nodeLabels.placement': '[OUTSIDE, V_BOTTOM, H_CENTER]',
      };
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
    .map((sf: any) => {
      const elkEdge: ElkExtendedEdge = {
        id: sf.id as string,
        sources: [sf.sourceRef.id as string],
        targets: [sf.targetRef.id as string],
      };
      const sfName = sf.name as string | undefined;
      if (sfName) {
        const lblSize = estimateLabelSize(sfName);
        (elkEdge as any).labels = [{ id: `${sf.id as string}_label`, text: sfName, ...lblSize }];
      }
      return elkEdge;
    });

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

    // If ELK computed a label position (for events / gateways with external labels),
    // use it directly. Otherwise fall back to delta-translating any existing offset.
    const elkLabel = child.labels?.[0];
    let elkLabelBounds: Bounds | undefined;
    if (elkLabel) {
      elkLabelBounds = {
        x: absX + (elkLabel.x ?? 0),
        y: absY + (elkLabel.y ?? 0),
        width: elkLabel.width ?? 0,
        height: elkLabel.height ?? 0,
      };
    }

    const existingShape = existingShapes.get(child.id);
    if (existingShape) {
      const dx = absX - (existingShape.bounds?.x ?? absX);
      const dy = absY - (existingShape.bounds?.y ?? absY);
      existingShape.bounds = newBounds;
      if (elkLabelBounds) {
        // Use ELK-computed absolute position for the label.
        const lblBounds = (moddle as any).create('dc:Bounds', elkLabelBounds);
        if (existingShape.label) {
          existingShape.label.bounds = lblBounds;
        } else {
          existingShape.label = (moddle as any).create('bpmndi:BPMNLabel', { bounds: lblBounds });
        }
      } else if (existingShape.label?.bounds) {
        // Translate existing label (e.g. task internal label) by the same delta as the shape.
        const lb = existingShape.label.bounds;
        existingShape.label.bounds = (moddle as any).create('dc:Bounds', {
          x: lb.x + dx, y: lb.y + dy, width: lb.width, height: lb.height,
        });
      }
      shapes.push(existingShape);
    } else {
      const newShape = (moddle as any).create('bpmndi:BPMNShape', {
        id: `${child.id}_di`,
        bpmnElement: element,
        bounds: newBounds,
      });
      if (elkLabelBounds) {
        newShape.label = (moddle as any).create('bpmndi:BPMNLabel', {
          bounds: (moddle as any).create('dc:Bounds', elkLabelBounds),
        });
      }
      shapes.push(newShape);
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
        const dpx = beBounds.x - (existingPortShape.bounds?.x ?? beBounds.x);
        const dpy = beBounds.y - (existingPortShape.bounds?.y ?? beBounds.y);
        existingPortShape.bounds = (moddle as any).create('dc:Bounds', beBounds);
        if (existingPortShape.label?.bounds) {
          const lb = existingPortShape.label.bounds;
          existingPortShape.label.bounds = (moddle as any).create('dc:Bounds', {
            x: lb.x + dpx, y: lb.y + dpy, width: lb.width, height: lb.height,
          });
        }
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
    // Extract ELK-computed label position for named sequence flows.
    const elkEdgeLabel = (edge as any).labels?.[0];
    let edgeLabelBounds: Bounds | undefined;
    if (elkEdgeLabel) {
      edgeLabelBounds = {
        x: offsetX + (elkEdgeLabel.x ?? 0),
        y: offsetY + (elkEdgeLabel.y ?? 0),
        width: elkEdgeLabel.width ?? 0,
        height: elkEdgeLabel.height ?? 0,
      };
    }

    if (existingEdge) {
      existingEdge.waypoint = waypoints;
      if (edgeLabelBounds) {
        // Use ELK-computed position for the label along the new route.
        const lblBounds = (moddle as any).create('dc:Bounds', edgeLabelBounds);
        if (existingEdge.label) {
          existingEdge.label.bounds = lblBounds;
        } else {
          existingEdge.label = (moddle as any).create('bpmndi:BPMNLabel', { bounds: lblBounds });
        }
      } else if (existingEdge.label?.bounds) {
        // Unnamed edge: path re-routed, clear stale absolute position.
        existingEdge.label.bounds = undefined;
      }
      edges.push(existingEdge);
    } else {
      const newEdge = (moddle as any).create('bpmndi:BPMNEdge', {
        id: `${edge.id}_di`,
        bpmnElement: element,
        waypoint: waypoints,
      });
      if (edgeLabelBounds) {
        newEdge.label = (moddle as any).create('bpmndi:BPMNLabel', {
          bounds: (moddle as any).create('dc:Bounds', edgeLabelBounds),
        });
      }
      edges.push(newEdge);
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
function rebuildGatewayEdgePaths(
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
 * Patch edge sources/targets in the ELK input graph to use explicit EAST or
 * WEST port IDs for gateway endpoints, based on the relative x-direction
 * observed in the Pass-1 layout result.
 *
 * NORTH/SOUTH routing for genuinely upward/downward connections is handled
 * separately in `rebuildGatewayEdgePaths` after ELK has produced final layout
 * coordinates.  Keeping only E/W here avoids ELK's "north-south dummy node"
 * processing, which can add extra segments in a direction-RIGHT layout and
 * also causes `favorStraightEdges` to shift gateways off the main flow axis.
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
      const tgtCx = tgtPos.x + tgtPos.width / 2;

      if (isSrcGw) {
        edge.sources = [tgtCx >= srcCx ? `${rawSrc}__E` : `${rawSrc}__W`];
      }

      if (isTgtGw) {
        // Approach direction: positive dx ⇒ source is to the right of target.
        const dx = srcCx - tgtCx;
        edge.targets = [dx >= 0 ? `${rawTgt}__E` : `${rawTgt}__W`];
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

  const collaboration: any | undefined = (definitions.rootElements as any[]).find(
    (e: any) => e.$type === 'bpmn:Collaboration',
  );

  const elementMap = buildElementMap(definitions.rootElements as any[]);

  if (!definitions.diagrams?.length) {
    const planeTarget = collaboration ?? processes[0];
    const plane = (moddle as any).create('bpmndi:BPMNPlane', {
      id: 'plane1',
      bpmnElement: planeTarget,
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

  if (collaboration) {
    // ── Pool (collaboration) layout ───────────────────────────────────────────
    // Each participant is laid out independently with ELK (direction RIGHT),
    // then stacked vertically. Message flows are intentionally excluded: routing
    // them without crossings requires ELK's compound-graph support and is
    // deferred to a follow-up implementation.
    let currentY = 0;

    for (const participant of (collaboration.participants as any[]) ?? []) {
      const process: any | undefined = participant.processRef;

      if (!process) {
        // Empty pool — emit a minimal placeholder shape.
        const emptyBounds = { x: 0, y: currentY, width: POOL_LABEL_WIDTH + POOL_PADDING * 2, height: POOL_PADDING * 2 };
        boundsMap.set(participant.id as string, emptyBounds);
        const existingShape = existingShapes.get(participant.id as string);
        if (existingShape) {
          existingShape.bounds = (moddle as any).create('dc:Bounds', emptyBounds);
          allShapes.push(existingShape);
        } else {
          allShapes.push(
            (moddle as any).create('bpmndi:BPMNShape', {
              id: `${participant.id as string}_di`,
              bpmnElement: participant,
              bounds: (moddle as any).create('dc:Bounds', emptyBounds),
              isHorizontal: true,
            }),
          );
        }
        currentY += emptyBounds.height + PARTICIPANT_GAP;
        continue;
      }

      const elkGraph = buildElkGraph(process, isExpandedMap);

      // Two-pass gateway layout (same logic as the non-pool path below).
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

      // Compute content bounding box from ELK output.
      // Include any external label height below nodes (e.g. event / gateway labels).
      let contentWidth = 0;
      let contentHeight = 0;
      for (const child of laidOut.children ?? []) {
        contentWidth  = Math.max(contentWidth,  (child.x ?? 0) + (child.width  ?? 0));
        const lblH = (child.labels?.[0]?.height ?? 0);
        contentHeight = Math.max(contentHeight, (child.y ?? 0) + (child.height ?? 0) + lblH);
      }

      const participantWidth  = POOL_LABEL_WIDTH + POOL_PADDING + contentWidth  + POOL_PADDING;
      const participantHeight =                    POOL_PADDING + contentHeight + POOL_PADDING;
      const participantBounds = { x: 0, y: currentY, width: participantWidth, height: participantHeight };
      boundsMap.set(participant.id as string, participantBounds);

      // Emit BPMNShape for the participant (pool).
      const existingParticipantShape = existingShapes.get(participant.id as string);
      if (existingParticipantShape) {
        existingParticipantShape.bounds = (moddle as any).create('dc:Bounds', participantBounds);
        allShapes.push(existingParticipantShape);
      } else {
        allShapes.push(
          (moddle as any).create('bpmndi:BPMNShape', {
            id: `${participant.id as string}_di`,
            bpmnElement: participant,
            bounds: (moddle as any).create('dc:Bounds', participantBounds),
            isHorizontal: true,
          }),
        );
      }

      // Collect process shapes/edges, offset into the pool interior.
      const offsetX = POOL_LABEL_WIDTH + POOL_PADDING;
      const offsetY = currentY + POOL_PADDING;
      const { shapes, edges } = collectShapesAndEdges(
        laidOut, moddle, elementMap, boundsMap, offsetX, offsetY, existingShapes, existingEdges,
      );
      allShapes.push(...shapes);
      allEdges.push(...edges);

      currentY += participantHeight + PARTICIPANT_GAP;
    }
  } else {
    // ── Plain process layout (no collaboration) ───────────────────────────────
    for (const process of processes) {
      const elkGraph = buildElkGraph(process, isExpandedMap);

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
      const { shapes, edges } = collectShapesAndEdges(
        laidOut, moddle, elementMap, boundsMap, 0, 0, existingShapes, existingEdges,
      );
      allShapes.push(...shapes);
      allEdges.push(...edges);
    }
  }

  // Replace planeElement: stale DI is excluded (only ELK-laid-out elements kept),
  // but existing objects carry their original non-layout attributes unchanged.
  plane.planeElement = [...allShapes, ...allEdges];

  // Snap edge endpoints to the visual boundary of source/target shapes.
  // Gateways use diamond geometry; all other shapes use rectangle geometry.
  snapConnectionEndpoints(plane, boundsMap, elementMap, moddle);

  // For gateway edges connecting to elements strictly above/below the gateway,
  // replace ELK's multi-segment EAST-exit path with a clean 1-bend L-shape from
  // the correct NORTH or SOUTH diamond tip.
  rebuildGatewayEdgePaths(plane, boundsMap, elementMap, moddle);

  const { xml } = await (moddle as any).toXML(definitions, { format: true });
  return xml as string;
}
