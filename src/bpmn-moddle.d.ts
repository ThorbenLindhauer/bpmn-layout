declare module 'bpmn-moddle' {
  export default class BpmnModdle {
    fromXML(xml: string): Promise<{ rootElement: unknown; warnings: unknown[] }>;
    toXML(element: unknown, options?: { format?: boolean }): Promise<{ xml: string }>;
    create(type: string, attrs?: Record<string, unknown>): unknown;
  }
}
