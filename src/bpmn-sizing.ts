// ─── element dimensions and label estimation ──────────────────────────────────

export const ELEMENT_SIZES: Record<string, { width: number; height: number }> = {
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

export const DEFAULT_SIZE = { width: 100, height: 80 };

// ─── label size estimation ────────────────────────────────────────────────────

const LABEL_CHAR_WIDTH  = 7;    // avg px per character
const LABEL_LINE_HEIGHT = 14;   // px per line
const LABEL_MAX_WIDTH   = 100;  // wrap after this many px

export function estimateLabelSize(name: string): { width: number; height: number } {
  const totalPx = name.length * LABEL_CHAR_WIDTH;
  const width   = Math.min(totalPx, LABEL_MAX_WIDTH);
  const lines   = Math.max(1, Math.ceil(totalPx / LABEL_MAX_WIDTH));
  return { width, height: lines * LABEL_LINE_HEIGHT };
}

/** Element types whose labels render OUTSIDE (below) the shape bounds. */
export const EXTERNAL_LABEL_TYPES = new Set([
  'bpmn:StartEvent', 'bpmn:EndEvent',
  'bpmn:IntermediateCatchEvent', 'bpmn:IntermediateThrowEvent', 'bpmn:BoundaryEvent',
  'bpmn:ExclusiveGateway', 'bpmn:ParallelGateway', 'bpmn:InclusiveGateway',
  'bpmn:EventBasedGateway', 'bpmn:ComplexGateway',
]);

// ─── pool layout constants ────────────────────────────────────────────────────

export const POOL_LABEL_WIDTH = 30;   // width of the pool name label column on the left
export const POOL_PADDING     = 20;   // padding inside each pool around the ELK content
export const PARTICIPANT_GAP  = 20;   // vertical gap between consecutive pools

// ─── lane layout constants ────────────────────────────────────────────────────

export const LANE_LABEL_WIDTH = 30;   // width of the lane name label column
export const LANE_PADDING     = 20;   // padding inside each lane (passed to ELK via elk.padding)
export const MIN_LANE_HEIGHT  = 150;  // minimum lane height (matches bpmn:Lane default size)

export function sizeOf(element: any) {
  return ELEMENT_SIZES[element.$type as string] ?? DEFAULT_SIZE;
}
