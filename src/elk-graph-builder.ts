import type { ElkNode, ElkExtendedEdge } from 'elkjs';
import { EDGE_TYPES, GATEWAY_TYPES, isFlowNode } from './bpmn-types.js';
import { DEFAULT_SIZE, EXTERNAL_LABEL_TYPES, LANE_PADDING, estimateLabelSize, sizeOf } from './bpmn-sizing.js';

// ─── ELK layout options ───────────────────────────────────────────────────────

export const ELK_LAYOUT_OPTIONS = {
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

export function buildElkGraph(process: any, isExpandedMap: Map<string, boolean> = new Map()): ElkNode {
  const { children, edges } = buildElkChildren(process, isExpandedMap);
  return { id: process.id as string, layoutOptions: ELK_LAYOUT_OPTIONS, children, edges };
}

/**
 * Build an ELK graph for a process that contains lanes.
 *
 * Each lane becomes an ELK compound node (direction=RIGHT) so its elements
 * are laid out left-to-right inside the lane.  The root graph uses
 * direction=DOWN so the lane compounds are stacked vertically.
 *
 * Intra-lane sequence flows are edges inside the corresponding lane compound.
 * Cross-lane sequence flows are edges at the root level — ELK routes them
 * holistically, which means it can optimise element positions within each lane
 * knowing about cross-lane connections.
 */
export function buildElkGraphForLanes(
  processId: string,
  lanes: any[],
  allFlowElements: any[],
  isExpandedMap: Map<string, boolean>,
): ElkNode {
  // Build sets of node IDs per lane from flowNodeRef, then extend with any
  // boundary events whose attachedToRef host is already in the same lane set.
  // Some BPMN tools omit boundary events from flowNodeRef; this ensures they are
  // still placed as ELK ports on their host and that their outgoing cross-lane
  // flows are correctly identified and routed.
  const laneIdSets = lanes.map((lane: any) => {
    const ids = new Set<string>((lane.flowNodeRef ?? []).map((n: any) => n.id as string));
    for (const e of allFlowElements) {
      if (e.$type === 'bpmn:BoundaryEvent' && ids.has(e.attachedToRef?.id)) {
        ids.add(e.id as string);
      }
    }
    return ids;
  });

  const laneNodes: ElkNode[] = lanes.map((lane: any, i: number) => {
    const laneIds = laneIdSets[i];

    const laneFlowElements = allFlowElements.filter((e: any) => {
      if (EDGE_TYPES.has(e.$type as string)) {
        return laneIds.has(e.sourceRef?.id) && laneIds.has(e.targetRef?.id);
      }
      return laneIds.has(e.id as string);
    });

    const { children, edges } = buildElkChildren(
      { id: lane.id as string, flowElements: laneFlowElements },
      isExpandedMap,
    );

    return {
      id: lane.id as string,
      layoutOptions: {
        ...ELK_LAYOUT_OPTIONS,
        'elk.padding': `[top=${LANE_PADDING},left=${LANE_PADDING},bottom=${LANE_PADDING},right=${LANE_PADDING}]`,
      },
      children,
      edges,
    };
  });

  const crossLaneEdges: ElkExtendedEdge[] = allFlowElements
    .filter((e: any) => {
      if (!EDGE_TYPES.has(e.$type as string)) return false;
      const srcIdx = laneIdSets.findIndex((s) => s.has(e.sourceRef?.id));
      const tgtIdx = laneIdSets.findIndex((s) => s.has(e.targetRef?.id));
      return srcIdx !== -1 && tgtIdx !== -1 && srcIdx !== tgtIdx;
    })
    .map((sf: any) => {
      const edge: ElkExtendedEdge = {
        id: sf.id as string,
        sources: [sf.sourceRef.id as string],
        targets: [sf.targetRef.id as string],
      };
      const sfName = sf.name as string | undefined;
      if (sfName) {
        const lblSize = estimateLabelSize(sfName);
        (edge as any).labels = [{ id: `${sf.id as string}_label`, text: sfName, ...lblSize }];
      }
      return edge;
    });

  return {
    id: processId,
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '0',
      'elk.spacing.nodeNode': '30',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.unnecessaryBendpoints': 'true',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children: laneNodes,
    edges: crossLaneEdges,
  };
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
export function assignGatewayPortsFromLayout(
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
