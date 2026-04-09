import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';
import { layout } from '../src/index.js';

// ─── element refs ─────────────────────────────────────────────────────────────

const fileInput = document.getElementById('file-input') as HTMLInputElement;
const fileLabel = document.getElementById('file-label') as HTMLLabelElement;
const layoutBtn = document.getElementById('layout-btn') as HTMLButtonElement;
const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLSpanElement;

// ─── bpmn-js viewer ───────────────────────────────────────────────────────────

const viewer = new NavigatedViewer({ container: '#canvas' });

// ─── state ────────────────────────────────────────────────────────────────────

let currentXml: string | null = null;
let laidOutXml: string | null = null;

// ─── helpers ─────────────────────────────────────────────────────────────────

function setStatus(msg: string, isError = false) {
  status.textContent = msg;
  status.className = isError ? 'error' : '';
}

async function renderXml(xml: string) {
  try {
    await viewer.importXML(xml);
    const canvas = (viewer as any).get('canvas');
    canvas.zoom('fit-viewport');
  } catch (err: any) {
    setStatus(`Render error: ${err.message}`, true);
  }
}

// ─── file selection ───────────────────────────────────────────────────────────

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  fileLabel.textContent = `\u{1F4C4} ${file.name}`;
  laidOutXml = null;
  saveBtn.disabled = true;
  setStatus('File loaded — click "Apply Layout"');

  const reader = new FileReader();
  reader.onload = async (e) => {
    currentXml = e.target?.result as string;
    layoutBtn.disabled = false;
    // Preview the original diagram
    await renderXml(currentXml);
  };
  reader.readAsText(file);
});

// ─── layout ───────────────────────────────────────────────────────────────────

layoutBtn.addEventListener('click', async () => {
  if (!currentXml) return;

  layoutBtn.disabled = true;
  setStatus('Computing layout…');

  try {
    laidOutXml = await layout(currentXml);
    await renderXml(laidOutXml);
    saveBtn.disabled = false;
    setStatus('Layout applied.');
  } catch (err: any) {
    setStatus(`Layout error: ${err.message}`, true);
  } finally {
    layoutBtn.disabled = false;
  }
});

// ─── save ─────────────────────────────────────────────────────────────────────

saveBtn.addEventListener('click', () => {
  if (!laidOutXml) return;

  const blob = new Blob([laidOutXml], { type: 'application/xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'diagram-layout.bpmn';
  a.click();
  URL.revokeObjectURL(url);
});
