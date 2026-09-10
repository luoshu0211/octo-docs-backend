// Types for the native code adapter; the host retains its pinned Bento model.
export type CodeElement = { id: string; type: 'code'; content: string; grammarName?: string;
  morphId?: string; fontSize: number; fontFamily?: string; color: string;
  align: 'left'|'center'|'right'; valign: 'top'|'middle'|'bottom'; lineHeight: number;
  [key: string]: unknown }
export type Slide = {elements: CodeElement[]; [key: string]: unknown}
export type BentoDoc = {slides: Slide[]; theme: {fontFamily: string}; [key: string]: unknown}
