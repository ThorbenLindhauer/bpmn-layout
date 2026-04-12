import BpmnModdle from 'bpmn-moddle';
import type { ElkNode, ElkExtendedEdge } from 'elkjs';
import { type Bounds } from './bpmn-types.js';
import { sizeOf } from './bpmn-sizing.js';

// ─── DI building ─────────────────────────────────────────────────────────────

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
export function collectShapesAndEdges(
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
