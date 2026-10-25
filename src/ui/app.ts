import { MODELS } from '../providers/models';
import { configureFal } from '../providers/fal';
import { DEFAULT_PIPELINE, type PipelineEvent } from '../core/pipeline';
import { LIGHTING, type Session } from '../session';

export interface Sample { name: string; url: string; lighting: 'outdoor' | 'overcast' | 'indoor'; style: string; roofStyle?: string }

export const SAMPLES: Sample[] = [
  { name: 'Village', url: '/samples/village.glb', lighting: 'overcast', style: DEFAULT_PIPELINE.style },
  { name: 'Courtyard', url: '/samples/courtyard.glb', lighting: 'overcast', style: DEFAULT_PIPELINE.style },
  { name: 'Hall', url: '/samples/hall.glb', lighting: 'indoor',
    style: 'an abandoned industrial hall: cracked dusty concrete floor, peeling painted plaster walls, rusted steel beams, grimy window frames',
    roofStyle: 'weathered corrugated metal roofing with rust streaks' },
];

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
};

function drawThumb(canvas: HTMLCanvasElement, data: Uint8ClampedArray, size: number) {
  const tmp = h('canvas');
  tmp.width = tmp.height = size;
  tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), size, size), 0, 0);
  canvas.width = canvas.height = 256;
  canvas.getContext('2d')!.drawImage(tmp, 0, 0, 256, 256);
}

export function mountUi(session: Session, panel: HTMLElement) {
  const sample = h('select');
  for (const s of SAMPLES) sample.append(h('option', { value: s.url }, s.name));
  const drop = h('div', { class: 'drop' }, 'Drop a .glb blockout here (needs UVs)');
  const file = h('input', { type: 'file', accept: '.glb,.gltf' });
  file.style.display = 'none';
  const style = h('textarea', { placeholder: 'Materials, not objects: anything named here gets painted onto walls' });
  style.value = SAMPLES[0].style;
  const roofStyle = h('input', { type: 'text', placeholder: 'Roof material' });
  roofStyle.value = SAMPLES[0].roofStyle ?? DEFAULT_PIPELINE.roofStyle;
  const segLight = h('div', { class: 'seg' });
  const lightBtns = Object.keys(LIGHTING).map((k) => {
    const b = h('button', {}, k[0].toUpperCase() + k.slice(1));
    b.onclick = () => setLighting(k);
    segLight.append(b);
    return [k, b] as const;
  });
  const az = h('input', { type: 'range', min: '0', max: '360', value: '140' });
  const el = h('input', { type: 'range', min: '5', max: '85', value: '48' });
  const firstSel = h('select');
  const fillSel = h('select');
  for (const m of Object.values(MODELS)) {
    firstSel.append(h('option', { value: m.key }, `${m.label} · $${m.price}`));
    fillSel.append(h('option', { value: m.key }, `${m.label} · $${m.price}`));
  }
  firstSel.value = DEFAULT_PIPELINE.firstModel;
  fillSel.value = DEFAULT_PIPELINE.fillModel;
  const budget = h('input', { type: 'range', min: '6', max: '80', value: '36' });
  const budgetLab = h('span', { class: 'lab' }, 'Max views · 36');
  budget.oninput = () => (budgetLab.textContent = `Max views · ${budget.value}`);
  const aerialBox = h('input', { type: 'checkbox', checked: '' });
  const atlasSel = h('select');
  for (const [v, l] of [['4096', '4K texture'], ['8192', '8K texture']]) atlasSel.append(h('option', { value: v }, l));
  atlasSel.value = '8192';
  const planBtn = h('button', {}, 'Plan cameras');
  const runBtn = h('button', { class: 'primary' }, 'Texture level');
  const stopBtn = h('button', {}, 'Stop');
  const stat = (label: string) => { const b = h('b', {}, '–'); return [h('div', { class: 'stat' }, b, h('i', {}, label)), b] as const; };
  const [sViews, vViews] = stat('views');
  const [sCov, vCov] = stat('surface');
  const [sCost, vCost] = stat('cost');
  const [sTime, vTime] = stat('time');
  const thumbSees = h('canvas');
  const thumbPaints = h('canvas');
  const segMode = h('div', { class: 'seg' });
  const clayBtn = h('button', { class: 'on' }, 'Clay');
  const texBtn = h('button', {}, 'Textured');
  const litBtn = h('button', {}, 'Lit');
  segMode.append(clayBtn, texBtn, litBtn);
  const camsBox = h('input', { type: 'checkbox', checked: '' });
  const glbBtn = h('button', {}, 'Download .glb');
  const texDl = h('button', {}, 'Download texture');
  const key = h('input', { type: 'password', placeholder: 'fal key (optional)' });
  key.value = localStorage.getItem('trompe.falKey') ?? '';
  const log = h('div', { class: 'log' });
  const say = (msg: string) => { log.textContent = `${msg}\n${log.textContent}`.slice(0, 6000); };

  panel.append(
    h('div', {}, h('h1', {}, 'trompe', h('span', {}, '.')), h('div', { class: 'sub' }, 'Texture a whole level from a blockout.')),
    h('section', {}, h('label', {}, 'Level'), sample, drop, file),
    h('section', {}, h('label', {}, 'Look'), style, h('div', { class: 'lab' }, 'Roofs'), roofStyle),
    h('section', {}, h('label', {}, 'Light'), segLight, h('div', { class: 'row' }, h('span', { class: 'lab' }, 'Sun'), az, el)),
    h('section', {}, h('label', {}, 'Models'), h('div', { class: 'lab' }, 'First view'), firstSel, h('div', { class: 'lab' }, 'Fills'), fillSel),
    h('section', {}, budgetLab, budget, h('label', { class: 'row note' }, aerialBox, 'Also paint roofs and outer walls (roof and aerial cameras)'),
      atlasSel, h('div', { class: 'row' }, planBtn, stopBtn), runBtn),
    h('section', {}, h('div', { class: 'stats' }, sViews, sCov, sCost, sTime),
      h('div', { class: 'thumbs' }, thumbSees, thumbPaints), h('div', { class: 'row note' }, h('span', {}, 'Model sees'), h('span', {}, 'Model paints'))),
    h('section', {}, h('label', {}, 'Display'), segMode, h('label', { class: 'row note' }, camsBox, 'Show cameras')),
    h('section', {}, h('label', {}, 'Export'), h('div', { class: 'row' }, glbBtn, texDl)),
    h('section', {}, h('label', {}, 'fal'), key, h('div', { class: 'note' }, 'Empty: uses FAL_KEY from the dev server. A key here is stored in this browser and sent straight to fal.')),
    log,
  );

  const lightingKey = () => lightBtns.find(([, b]) => b.classList.contains('on'))?.[0] ?? 'outdoor';
  function setLighting(k: string) {
    for (const [name, b] of lightBtns) b.classList.toggle('on', name === k);
    const base = LIGHTING[k];
    az.value = String(base.sunAzimuth);
    el.value = String(base.sunElevation);
    session.setLighting(base);
  }
  // In the lit display the sliders move the display sun (shadows follow live); otherwise the light the models paint in.
  const applySun = () => {
    const v = session.viewer;
    if (v?.mode === 'lit') {
      v.displayLighting = { ...LIGHTING.outdoor, sunAzimuth: +az.value, sunElevation: +el.value };
      v.syncLighting();
    } else session.setLighting({ ...LIGHTING[lightingKey()], sunAzimuth: +az.value, sunElevation: +el.value });
  };
  az.oninput = applySun;
  el.oninput = applySun;

  const setMode = (m: 'clay' | 'textured' | 'lit') => {
    session.viewer?.setMode(m);
    clayBtn.classList.toggle('on', m === 'clay');
    texBtn.classList.toggle('on', m === 'textured');
    litBtn.classList.toggle('on', m === 'lit');
  };
  clayBtn.onclick = () => setMode('clay');
  texBtn.onclick = () => setMode('textured');
  litBtn.onclick = () => setMode('lit');
  camsBox.onchange = () => { if (session.viewer) { session.viewer.overlay.visible = camsBox.checked; session.viewer.dirty = true; } };

  async function load(src: string | ArrayBuffer, name: string, lighting: string) {
    say(`loading ${name}…`);
    const info = await session.load(src, name, LIGHTING[lighting], +atlasSel.value);
    setLighting(lighting);
    setMode('clay');
    say(`${name}: ${info.triangles.toLocaleString()} triangles, ${info.area.toLocaleString()} m² of surface`);
  }
  atlasSel.onchange = () => sample.onchange?.(new Event('change'));
  sample.onchange = () => {
    const s = SAMPLES.find((x) => x.url === sample.value)!;
    style.value = s.style;
    roofStyle.value = s.roofStyle ?? DEFAULT_PIPELINE.roofStyle;
    void load(s.url, s.name, s.lighting).catch((e) => say(String(e)));
  };
  drop.onclick = () => file.click();
  const loadFile = async (f: File) => load(await f.arrayBuffer(), f.name.replace(/\.\w+$/, ''), lightingKey());
  file.onchange = () => { if (file.files?.[0]) void loadFile(file.files[0]).catch((e) => say(String(e))); };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f) void loadFile(f).catch((err) => say(String(err)));
  };

  const planOpts = () => ({ maxViews: +budget.value, aerial: aerialBox.checked ? 8 : 0, roofs: aerialBox.checked ? 24 : 0, holes: 12 });
  planBtn.onclick = () => {
    try {
      const p = session.makePlan(planOpts());
      vViews.textContent = String(p.views.length);
      say(`planned ${p.views.length} views from ${p.points.length} spots, ${p.waves.length} waves, ` +
        `${Math.round(100 * p.predicted[p.predicted.length - 1])}% of reachable surface`);
    } catch (e) { say(String(e)); }
  };
  runBtn.onclick = async () => {
    key.value ? localStorage.setItem('trompe.falKey', key.value) : localStorage.removeItem('trompe.falKey');
    configureFal(key.value || undefined);
    runBtn.disabled = planBtn.disabled = true;
    const S = session.engine?.size ?? 1024;
    let n = 0;
    const onEvent = (e: PipelineEvent) => {
      if (e.type === 'planned') { vViews.textContent = `0/${e.plan.views.length}`; say(`painting ${e.plan.views.length} views in ${e.plan.waves.length} waves`); }
      if (e.type === 'view-start') drawThumb(thumbSees, e.state, S);
      if (e.type === 'view-done') {
        drawThumb(thumbPaints, e.view.gen, S);
        vViews.textContent = `${++n}/${session.plan?.views.length ?? '?'}`;
        vCov.textContent = `${Math.round(100 * e.view.predicted)}%`;
        vCost.textContent = `$${e.cost.toFixed(2)}`;
        vTime.textContent = `${Math.round(e.elapsed)}s`;
        say(`view ${e.view.index} · ${e.view.model} · ${e.view.seconds.toFixed(1)}s`);
      }
      if (e.type === 'error') say(`view ${e.index} failed: ${e.message}`);
      if (e.type === 'done') say(`done: ${e.record.views.length} views, $${e.record.cost.toFixed(2)}, ${Math.round(e.record.seconds)}s`);
    };
    try {
      await session.run({ style: style.value, roofStyle: roofStyle.value, firstModel: firstSel.value, fillModel: fillSel.value,
        plan: planOpts() }, onEvent);
      setMode('textured');
    } catch (e) {
      say(String(e));
    } finally {
      runBtn.disabled = planBtn.disabled = false;
    }
  };
  stopBtn.onclick = () => session.stop();
  const download = (blob: Blob, name: string) => {
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  glbBtn.onclick = async () => {
    if (!session.engine) return;
    download(new Blob([await session.exportGlb()], { type: 'model/gltf-binary' }), `${session.level!.name}_textured.glb`);
  };
  texDl.onclick = async () => {
    if (!session.engine) return;
    const { data, size } = session.engine.atlas.readBytes();
    const c = h('canvas');
    c.width = c.height = size;
    c.getContext('2d')!.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, size, size), 0, 0);
    c.toBlob((b) => b && download(b, `${session.level!.name}_texture.png`), 'image/png');
  };

  setLighting(SAMPLES[0].lighting);
  void load(SAMPLES[0].url, SAMPLES[0].name, SAMPLES[0].lighting).catch((e) => say(String(e)));
}
