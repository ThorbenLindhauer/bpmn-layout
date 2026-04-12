import BpmnModdle from 'bpmn-moddle';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs';
import { type Bounds, GATEWAY_TYPES } from './bpmn-types.js';
import { POOL_LABEL_WIDTH, POOL_PADDING, PARTICIPANT_GAP, sizeOf } from './bpmn-sizing.js';
import { buildElkGraph, assignGatewayPortsFromLayout } from './elk-graph-builder.js';
import { buildElementMap } from './bpmn-utils.js';
import { collectShapesAndEdges } from './di-builder.js';
import { snapConnectionEndpoints, rebuildGatewayEdgePaths } from './gateway-post-processor.js';

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
