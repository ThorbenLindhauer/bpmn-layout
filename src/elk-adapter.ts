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

// ─── ELK graph building ───────────────────────────────────────────────────────

/** Types we treat as ELK edges (not nodes). */
const EDGE_TYPES = new Set([
  'bpmn:SequenceFlow',
  'bpmn:MessageFlow',
]);

/** Types we silently ignore (data objects, annotations, etc.). */
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

const ELK_LAYOUT_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.layered.spacing.nodeNodeBetweenLayers': '80',
  'elk.spacing.nodeNode': '30',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.unnecessaryBendpoints': 'true',
};

function buildElkChildren(process: any): { children: ElkNode[]; edges: ElkExtendedEdge[] } {
  const flowElements: any[] = process.flowElements ?? [];
  const flowNodes = flowElements.filter(isFlowNode);
  const sequenceFlows = flowElements.filter((e: any) => EDGE_TYPES.has(e.$type));
  const nodeIdSet = new Set(flowNodes.map((n: any) => n.id as string));

  const children: ElkNode[] = flowNodes.map((node: any) => {
    const size = sizeOf(node);
    const elkNode: ElkNode = { id: node.id as string, width: size.width, height: size.height };

    // Expand subprocesses recursively
    if ((node.flowElements as any[] | undefined)?.length) {
      const sub = buildElkChildren(node);
      elkNode.children = sub.children;
      elkNode.edges = sub.edges;
      elkNode.layoutOptions = ELK_LAYOUT_OPTIONS;
    }

    return elkNode;
  });

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
  return {
    id: process.id as string,
    layoutOptions: ELK_LAYOUT_OPTIONS,
    children,
    edges,
  };
}

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

function collectShapesAndEdges(
  elkNode: ElkNode,
  moddle: BpmnModdle,
  elementMap: Map<string, any>,
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

    shapes.push(
      (moddle as any).create('bpmndi:BPMNShape', {
        id: `${child.id}_di`,
        bpmnElement: element,
        bounds: (moddle as any).create('dc:Bounds', {
          x: absX,
          y: absY,
          width: child.width ?? sizeOf(element).width,
          height: child.height ?? sizeOf(element).height,
        }),
      }),
    );

    // Recurse into subprocesses
    if (child.children?.length) {
      const sub = collectShapesAndEdges(child, moddle, elementMap, absX, absY);
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

/** Recursively populate a map of id → moddle object. */
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

  // Collect all processes to lay out
  const processes: any[] = (definitions.rootElements as any[]).filter(
    (e: any) => e.$type === 'bpmn:Process',
  );

  // Build a flat lookup for all flow elements
  const elementMap = buildElementMap(definitions.rootElements as any[]);

  // Find or create diagram + plane
  if (!definitions.diagrams?.length) {
    const mainProcess = processes[0];
    const plane = (moddle as any).create('bpmndi:BPMNPlane', {
      id: 'plane1',
      bpmnElement: mainProcess,
    });
    const diagram = (moddle as any).create('bpmndi:BPMNDiagram', {
      id: 'diagram1',
      plane,
    });
    definitions.diagrams = [diagram];
  }

  const plane = definitions.diagrams[0].plane;
  plane.planeElement = [];

  // Layout each process independently
  for (const process of processes) {
    const elkGraph = buildElkGraph(process);
    const laidOut = await elk.layout(elkGraph);
    const { shapes, edges } = collectShapesAndEdges(laidOut, moddle, elementMap);
    plane.planeElement.push(...shapes, ...edges);
  }

  const { xml } = await (moddle as any).toXML(definitions, { format: true });
  return xml as string;
}
