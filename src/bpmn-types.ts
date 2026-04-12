// ─── shared domain types and element classification ───────────────────────────

export type Bounds = { x: number; y: number; width: number; height: number };

export const EDGE_TYPES = new Set(['bpmn:SequenceFlow', 'bpmn:MessageFlow']);

export const IGNORED_TYPES = new Set([
  'bpmn:DataObjectReference',
  'bpmn:DataStoreReference',
  'bpmn:DataInputAssociation',
  'bpmn:DataOutputAssociation',
  'bpmn:Association',
  'bpmn:TextAnnotation',
  'bpmn:Property',
  'bpmn:DataObject',
]);

/** BPMN element types that render as a diamond (rhombus) rather than a rectangle. */
export const GATEWAY_TYPES = new Set([
  'bpmn:ExclusiveGateway', 'bpmn:ParallelGateway', 'bpmn:InclusiveGateway',
  'bpmn:EventBasedGateway', 'bpmn:ComplexGateway',
]);

export function isFlowNode(el: any): boolean {
  const t: string = el.$type;
  return !EDGE_TYPES.has(t) && !IGNORED_TYPES.has(t);
}
