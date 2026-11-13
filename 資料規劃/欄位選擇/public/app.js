(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const storageKey = 'weather-flow-field-selection-v1';
  const sections = [];
  let state, active = 'now', selectedField = 'temp', query = '', selectedOnly = false, revision = 0, dirty = false;
  const current = () => sections.find(s => s.id === active);

  function status(text, error = false) { $('#save-status').textContent = text; $('#save-status').classList.toggle('error', error); }
  function clean(input, source = sections) {
    if (!input || input.v !== 1 || !input.sections) throw new Error('選擇資料格式不正確');
    const result = {v:1, globalNote:typeof input.globalNote === 'string' ? input.globalNote : '', sections:{}};
    for (const section of source) {
      const p = input.sections[section.id] || {}, ids = new Set(section.fields.map(f => f.id));
      const choices = key => {
        if (!Array.isArray(p[key]) || p[key].some(id => !ids.has(id))) throw new Error('已選欄位不在資料目錄內，原選擇仍保留，請先核對');
        return [...new Set(p[key])];
      };
      result.sections[section.id] = {home:choices('home'), detail:choices('detail'), note:typeof p.note === 'string' ? p.note : '', notes:{}};
      for (const [id, note] of Object.entries(p.notes || {})) {
        if (!ids.has(id)) throw new Error('有備註的欄位不在資料目錄內，原備註仍保留');
        if (typeof note === 'string') result.sections[section.id].notes[id] = note;
      }
    }
    return result;
  }

  function changed() {
    revision++; dirty = true;
    try { localStorage.setItem(storageKey, JSON.stringify({selection:state, modifiedAt:new Date().toISOString()})); status('變更已暫存，尚未儲存'); }
    catch { status('請儲存，瀏覽器暫存無法使用', true); }
    renderCounts();
    const row = document.querySelector(`[data-row="${selectedField}"] .note-dot`);
    if (row) row.hidden = !state.sections[active].notes[selectedField];
  }

  function renderTabs() {
    $('#section-tabs').innerHTML = sections.map(s => `<button type="button" class="section-tab" data-section="${s.id}" aria-pressed="${s.id === active}">${esc(s.name)}<span class="tab-count">${s.fields.length}</span></button>`).join('');
  }
  function renderCounts() {
    const p = state.sections[active];
    $('.column-head').innerHTML = `<span>資料／原始值 <small>點名稱看說明</small></span><span>主畫面 ${p.home.length}</span><span>詳細頁 ${p.detail.length}</span>`;
  }
  function fieldMatches(f) {
    const p = state.sections[active];
    return (!query || [f.name,f.rawField,f.example,f.meaning,f.source].join(' ').toLowerCase().includes(query.toLowerCase())) && (!selectedOnly || p.home.includes(f.id) || p.detail.includes(f.id));
  }
  function lookupMeaning(field, raw) {
    for (const lookup of field.lookups) {
      let row = lookup.rows.find(r => r[0] === String(raw));
      if (!row && !Number.isNaN(Number(raw))) row = lookup.rows.find(r => {
        const match = r[0].match(/^(\d+)～(\d+)$/);
        return match && Number(raw) >= Number(match[1]) && Number(raw) <= Number(match[2]);
      });
      if (row) {
        const brief = row[1].replace(/^本版同筆描述為/, '').split(/[，；]/)[0];
        return lookup.id === 'weather' && row[1].includes('；') ? brief+'等多種描述' : brief;
      }
    }
    return '';
  }
  function rawSummary(f) {
    const pairs = Object.entries(f.rawSamples[0]?.raw || {});
    if (!pairs.length) return f.sourceInfo.some(s => s.id === 'record') ? '需自行紀錄，尚未產生' : '尚無原始樣本';
    const [key,value] = pairs[0], meaning = lookupMeaning(f,value);
    const unit = ['°C','°F','%','mm','m/s'].includes(f.unit) ? ` ${f.unit}` : '';
    return `${key} ${JSON.stringify(value)}${unit}${meaning ? ' → '+meaning : ''}${pairs.length > 1 ? ' …' : ''}`;
  }
  function rowHTML(f) {
    const p = state.sections[active];
    const check = key => `<label class="choice"><input type="checkbox" data-choice="${key}" data-id="${f.id}" aria-label="${esc(f.name)}：${key === 'home' ? '主畫面' : '詳細頁'}" ${p[key].includes(f.id) ? 'checked' : ''}></label>`;
    return `<div class="field-row ${selectedField === f.id ? 'is-active' : ''}" data-row="${f.id}"><button class="field-open" type="button" data-open="${f.id}" aria-label="查看${esc(f.name)}的資料說明"><span class="field-name">${esc(f.name)}${f.home ? '<span class="recommend">建議主畫面</span>' : ''}<i class="note-dot" aria-label="有備註" ${p.notes[f.id] ? '' : 'hidden'}></i></span><span class="raw-line">${esc(rawSummary(f))}</span></button>${check('home')}${check('detail')}</div>`;
  }
  function renderGroups(reset = false) {
    const opened = new Set(reset ? [] : [...document.querySelectorAll('.group[open]')].map(el => el.dataset.group));
    let count = 0;
    $('#groups').innerHTML = current().groups.map(([name,fields],i) => {
      const matches = fields.filter(fieldMatches); count += matches.length;
      return matches.length ? `<details class="group" data-group="${i}" ${i === 0 || query || selectedOnly || opened.has(String(i)) ? 'open' : ''}><summary>${esc(name)} <span class="group-count">${matches.length}</span></summary>${matches.map(rowHTML).join('')}</details>` : '';
    }).join('');
    $('#field-count').textContent = `${count} 項`;
    $('#no-results').hidden = count !== 0;
    renderCounts();
  }

  function relativeRange(segment) {
    if (segment.startHour == null) return segment.note || '依原始資料';
    const a = segment.startHour, b = segment.endHour;
    if (a === b) return `起點後第 ${a} 小時`;
    return a === 0 ? `前 ${b} 小時` : `第 ${a}～${b} 小時`;
  }
  function coverageHTML(coverage) {
    return (coverage || []).map(source => `<div class="range-source">${esc(source.sourceName)}</div>${source.segments.map(s => `<div class="range-row"><span class="range-label ${s.valid ? '' : 'missing'}">${esc(s.label)}</span><div><div class="range-value">${esc(relativeRange(s))}</div>${s.note && s.startHour != null ? `<div class="range-note">${esc(s.note)}</div>` : ''}${s.kind === 'point' ? '<div class="range-note">最後時間為最後一筆資料點</div>' : ''}</div></div>`).join('')}`).join('');
  }
  function refsHTML(refs) { return refs.map(r => (/^https:\/\//.test(r.url) ? `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title)} ↗</a>` : esc(r.title))+(r.locator ? `<div>${esc(r.locator)}</div>` : '')).join('<br>'); }
  function extraHTML(f) {
    const samples = f.rawSamples.map(s => `<div class="sample-record"><span>${esc(s.location)} · ${esc(s.time)}${s.end ? ' ～ '+esc(s.end) : ''}</span><code>${esc(JSON.stringify(s.raw))}</code></div>`).join('');
    const tables = f.lookups.map(t => `<div class="lookup"><h4>${esc(t.title)}</h4><p>${esc(t.status)}</p><table><tbody>${t.rows.map(r => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td></tr>`).join('')}</tbody></table><p>${esc(t.note)}</p><div class="reference-links">${refsHTML(t.references)}</div></div>`).join('');
    const updates = f.sourceInfo.map(s => `<h4>${esc(s.name)}</h4><dl class="update-grid"><dt>官方更新</dt><dd>${esc(s.officialUpdate)}</dd><dt>我們去抓</dt><dd>${esc(s.plannedCheck)}（規劃）</dd></dl>`).join('');
    const meaningDetails = (f.officialDetails || []).map(text=>`<p>${esc(text)}</p>`).join('');
    const pending = [...new Set((f.auditItems || []).map(item=>item.remaining).filter(Boolean))].map(text=>`<p>仍待確認：${esc(text)}</p>`).join('');
    return `<details class="detail-extra"><summary>更新方式與官方依據</summary><div class="detail-extra-body">${meaningDetails}${updates}<p>核對狀態：${esc(f.verification)}</p>${f.meaningCheckedAt ? `<p>官方意思核對：${esc(f.meaningCheckedAt)}</p>` : ''}${pending}<div class="reference-links">${refsHTML(f.references)}</div></div></details><details class="detail-extra"><summary>完整原始樣本與代號對照</summary><div class="detail-extra-body"><p>原始欄位：${esc(f.rawField)} · 單位：${esc(f.unit)}</p>${samples || '<p>尚無原始樣本，需自行收集的資料不補示意值。</p>'}${tables}</div></details>`;
  }
  function renderInspector() {
    const f = current().fields.find(f => f.id === selectedField) || current().fields[0];
    selectedField = f.id;
    const hasRelativeRange = f.coverage.some(source => source.segments.some(segment => segment.startHour != null));
    const briefExample = f.example.length > 60 ? f.example.slice(0,60)+'…' : f.example;
    $('#field-detail').innerHTML = `<div class="detail-top"><h3>${esc(f.name)}</h3><div class="detail-value ${f.example.length > 25 ? 'long-value' : ''}">${esc(briefExample)}</div><p class="detail-meaning">${esc(f.meaning)}</p><p class="detail-source">${esc(f.source)} · ${f.rawSamples.length ? '原始樣本' : '尚無原始樣本'}</p></div><section class="detail-block"><h4>資料間隔與相對範圍</h4>${coverageHTML(f.coverage)}${hasRelativeRange ? '<p class="anchor-note">以這版預報的起點為 0 小時，並非從此刻倒數。各產品可以重疊。</p>' : ''}</section>${extraHTML(f)}<label class="section-note field-note"><span>這筆資料的備註</span><textarea id="field-note" rows="3" maxlength="1000" aria-label="${esc(f.name)}的備註" placeholder="例如：只在有雨時顯示">${esc(state.sections[active].notes[f.id] || '')}</textarea></label>`;
    for (const row of document.querySelectorAll('[data-row]')) row.classList.toggle('is-active',row.dataset.row === selectedField);
  }
  function renderCoverage() {
    const groups = new Map();
    for (const f of current().fields) {
      const key = JSON.stringify(f.coverage);
      if (!groups.has(key)) groups.set(key,{fields:[],coverage:f.coverage});
      groups.get(key).fields.push(f.name);
    }
    $('#coverage-title').textContent = current().name+'：時間間隔';
    $('#coverage-content').innerHTML = [...groups.values()].map(g => `<section class="coverage-group"><h3>${esc(g.fields.join('、'))}</h3>${coverageHTML(g.coverage)}</section>`).join('');
  }
  function selectionText() {
    return sections.map(s => { const p=state.sections[s.id];const names=ids=>ids.map(id=>s.fields.find(f=>f.id===id)?.name).join('、')||'未選擇';return `【${s.name}】\n主畫面：${names(p.home)}\n詳細頁：${names(p.detail)}\n區塊備註：${p.note || '無'}\n`+Object.entries(p.notes).filter(([,note])=>note.trim()).map(([id,note])=>`・${s.fields.find(f=>f.id===id)?.name}：${note}`).join('\n'); }).join('\n\n')+'\n\n整體備註：'+(state.globalNote||'無');
  }
  async function save() {
    const submitted=JSON.parse(JSON.stringify(state)),atRevision=revision;
    $('#save').disabled=$('#save-review').disabled=true;status('儲存中…');
    try { const response=await fetch('/api/selection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(submitted)});const result=await response.json();if(!response.ok)throw new Error(result.error||'儲存失敗');if(revision===atRevision){dirty=false;try{localStorage.removeItem(storageKey);}catch{}status('選擇與規劃文件已儲存');}else status('已儲存，還有新的變更'); }
    catch(error){status(error.message||'儲存服務無法連接',true);}finally{$('#save').disabled=$('#save-review').disabled=false;}
  }
  document.addEventListener('click',event=>{
    const tab=event.target.closest('[data-section]'),field=event.target.closest('[data-open]'),close=event.target.closest('[data-close]');
    if(close){close.closest('dialog').close();return;}
    if(!state)return;
    if(tab){active=tab.dataset.section;selectedField=current().fields[0].id;query='';selectedOnly=false;$('#search').value='';$('#selected-only').checked=false;$('#section-note').value=state.sections[active].note;renderTabs();renderGroups(true);renderInspector();}
    if(field){selectedField=field.dataset.open;renderInspector();}
  });
  $('#groups').addEventListener('change',event=>{const el=event.target;if(!el.dataset.choice)return;const p=state.sections[active],key=el.dataset.choice,id=el.dataset.id;p[key]=el.checked?[...new Set([...p[key],id])]:p[key].filter(v=>v!==id);changed();if(selectedOnly)renderGroups();});
  $('#field-detail').addEventListener('input',event=>{if(event.target.id==='field-note'){state.sections[active].notes[selectedField]=event.target.value;changed();}});
  $('#section-note').addEventListener('input',event=>{if(state){state.sections[active].note=event.target.value;changed();}});
  $('#global-note').addEventListener('input',event=>{if(state){state.globalNote=event.target.value;changed();}});
  $('#search').addEventListener('input',event=>{query=event.target.value.trim();renderGroups();});
  $('#selected-only').addEventListener('change',event=>{selectedOnly=event.target.checked;renderGroups();});
  $('#coverage-toggle').addEventListener('click',()=>{if(state){renderCoverage();$('#coverage-dialog').showModal();}});
  $('#tools').addEventListener('click',()=>$('#tools-dialog').showModal());
  $('#review').addEventListener('click',()=>{if(state){$('#review-text').value=selectionText();$('#copy-status').textContent='';$('#review-dialog').showModal();}});
  $('#save').addEventListener('click',save);$('#save-review').addEventListener('click',save);
  $('#copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('#review-text').value);$('#copy-status').textContent='已複製';}catch{$('#review-text').focus();$('#review-text').select();$('#copy-status').textContent='已選取，可手動複製';}});
  $('#refresh-catalog').addEventListener('click',async()=>{const button=$('#refresh-catalog');button.disabled=true;try{const r=await fetch('/api/catalog'),catalog=await r.json();if(!r.ok)throw new Error(catalog.error||'讀取失敗');const retained=clean(state,catalog.sections);const sync=await fetch('/api/sync-documents',{method:'POST'}),result=await sync.json();if(!sync.ok)throw new Error(result.error||'更新失敗');sections.splice(0,sections.length,...catalog.sections);state=retained;renderGroups();renderInspector();status(dirty?'資料說明已更新；選擇尚未儲存':'資料說明已更新，勾選備註保留');$('#catalog-version').textContent='資料版本 '+catalog.revision;}catch(error){status(error.message,true);}finally{button.disabled=false;}});
  async function start(){try{const [r,s]=await Promise.all([fetch('/api/catalog'),fetch('/api/selection')]);const catalog=await r.json(),saved=await s.json();if(!r.ok||!s.ok)throw new Error(catalog.error||saved.error||'載入失敗');sections.push(...catalog.sections);state=clean(saved.selection);let restored=false;try{const draft=JSON.parse(localStorage.getItem(storageKey)||'null');if(draft&&(!saved.savedAt||Date.parse(draft.modifiedAt)>Date.parse(saved.savedAt))){state=clean(draft.selection);restored=true;}}catch{}$('#global-note').value=state.globalNote;$('#section-note').value=state.sections[active].note;$('#catalog-version').textContent='資料版本 '+catalog.revision;renderTabs();renderGroups();renderInspector();dirty=restored;status(restored?'已還原未儲存的變更':'已保留原有勾選與備註');$('#save').disabled=false;}catch(error){status(error.message,true);}}
  start();
})();
