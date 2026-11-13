"""One catalogue for the selection UI, reference documents and saved plans."""
from pathlib import Path
from copy import deepcopy
import hashlib
import json
import os
import tempfile
import threading

DIRECTORY = Path(__file__).resolve().parent
CATALOG_PATH = DIRECTORY / '資料目錄.json'
# Both sibling folders live inside 資料規劃; resolve from this file, never cwd.
WORKSPACE = DIRECTORY.parent
WRITE_LOCK = threading.RLock()


def load_catalog(path=None):
    catalog = json.loads(Path(path or CATALOG_PATH).read_text(encoding='utf-8-sig'))
    if catalog.get('schemaVersion') != 1:
        raise ValueError('共用資料目錄版本不支援')
    for key in ('sources', 'fields', 'references', 'lookups', 'documentation'):
        if not isinstance(catalog.get(key), dict):
            raise ValueError('共用資料目錄缺少 ' + key)
    section_ids = set()
    for section in catalog['sections']:
        if section['id'] in section_ids:
            raise ValueError('區塊重複')
        section_ids.add(section['id'])
        ids = set()
        for group in section['groups']:
            for binding in group['bindings']:
                if binding['id'] in ids:
                    raise ValueError('區塊內欄位識別碼重複')
                ids.add(binding['id'])
                definition = catalog['fields'][binding['field']]
                for source_id in binding['sourceIds']:
                    catalog['sources'][source_id]
                for reference_id in definition['referenceIds']:
                    catalog['references'][reference_id]
                for lookup_id in definition['lookupIds']:
                    catalog['lookups'][lookup_id]
    catalog['revision'] = hashlib.sha256(json.dumps(catalog, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]
    return catalog


def example(field, samples):
    if not samples:
        return '尚無原始數值；需持續收集後產生' if field['kind'] == 'record' else '未取得原始樣本'
    values = list(samples[0]['raw'].values())
    value = ' / '.join(str(v) for v in values)
    unit = field['unit']
    if unit in ('°C', '°F', '%', 'mm', 'm/s'):
        value += ' ' + unit
    return value


def resolve_lookup(catalog, lookup_id):
    lookup = deepcopy(catalog['lookups'][lookup_id])
    lookup['id'] = lookup_id
    if 'locations' in lookup:
        lookup['rows'] = [[row['forecastGeocode'], f"{row['county']}{row['name']}；官網／GT ID：{row['gtId']}"] for row in lookup['locations']]
    lookup['references'] = [catalog['references'][ref] for ref in lookup['referenceIds']]
    return lookup


def resolve_sections(catalog):
    result = []
    for section in catalog['sections']:
        rendered = {key: section[key] for key in ('id', 'name', 'subtitle', 'caption')}
        rendered['groups'] = []
        for group in section['groups']:
            fields = []
            for binding in group['bindings']:
                definition = catalog['fields'][binding['field']]
                samples = [s for s in definition['samples'] if s['sourceId'] in binding['sourceIds'] and s.get('context', 'future') == binding['context']]
                sources = [dict(id=sid, **catalog['sources'][sid]) for sid in binding['sourceIds']]
                fields.append({
                    'id': binding['id'], 'fieldRef': binding['field'], 'name': binding['name'],
                    'home': binding['home'], 'detail': binding['detail'],
                    'example': example(definition, samples), 'meaning': definition['officialMeaning'],
                    'officialDetails': deepcopy(definition.get('officialDetails', [])),
                    'meaningCheckedAt': definition.get('meaningCheckedAt'),
                    'rawField': definition['rawField'], 'unit': definition['unit'], 'rawSamples': deepcopy(samples),
                    'source': '／'.join(s['name'] for s in sources), 'sourceInfo': sources,
                    'interval': definition['interval'], 'verification': definition['verification'],
                    'coverage': [dict(sourceId=sid, sourceName=catalog['sources'][sid]['name'], segments=deepcopy(definition.get('coverageToday' if binding['context'] == 'today' else 'coverage', {}).get(sid, definition.get('coverage', {}).get(sid, [])))) for sid in binding['sourceIds']],
                    'references': [catalog['references'][ref] for ref in definition['referenceIds']],
                    'lookups': [resolve_lookup(catalog, ref) for ref in definition['lookupIds']],
                    'auditItems': [deepcopy(item) for item in catalog.get('verificationAudit', {}).get('items', []) if binding['field'] in item['fieldRefs']],
                })
            rendered['groups'].append([group['name'], fields])
        rendered['fields'] = [field for _, fields in rendered['groups'] for field in fields]
        rendered['relativeTimeNote'] = catalog.get('relativeTimeNote', '')
        result.append(rendered)
    return result


def validate_selection(data, catalog):
    if not isinstance(data, dict) or data.get('v') != 1 or isinstance(data.get('v'), bool):
        raise ValueError('選擇資料版本不正確')
    allowed = {section['id']: {f['id'] for f in section['fields']} for section in resolve_sections(catalog)}
    if not isinstance(data.get('sections'), dict) or set(data['sections']) != set(allowed):
        raise ValueError('需要包含三個完整區塊')
    clean = {'v': 1, 'globalNote': checked_text(data.get('globalNote', ''), 4000), 'sections': {}}
    for sid, ids in allowed.items():
        source = data['sections'][sid]
        if not isinstance(source, dict):
            raise ValueError('區塊格式不正確')
        target = {'note': checked_text(source.get('note', ''), 2000), 'notes': {}}
        for key in ('home', 'detail'):
            values = source.get(key)
            if not isinstance(values, list) or any(not isinstance(v, str) or v not in ids for v in values):
                raise ValueError('有欄位不存在；請先保留原選擇，核對共用資料目錄')
            target[key] = list(dict.fromkeys(values))
        if not isinstance(source.get('notes', {}), dict):
            raise ValueError('備註格式不正確')
        for fid, note in source.get('notes', {}).items():
            if fid not in ids:
                raise ValueError('備註所屬欄位不存在；不會自動刪除備註')
            target['notes'][fid] = checked_text(note, 1000)
        clean['sections'][sid] = target
    return clean


def checked_text(value, limit):
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError('備註長度或格式不正確')
    return value


def cell(value):
    return str(value).replace('|', '\\|').replace('\r\n', '\n').replace('\n', '<br>')


def json_text(value):
    return json.dumps(value, ensure_ascii=False)


def relative_range(segment):
    if 'startHour' not in segment:
        return segment.get('note', '依原始資料')
    start, end = segment['startHour'], segment['endHour']
    if start == end:
        return f'起點後第 {start:g} 小時'
    return f'前 {end:g} 小時' if start == 0 else f'第 {start:g}～{end:g} 小時'


def field_markdown(field):
    lines = [f"### {field['name']}", '',
             f"- 共用欄位：`{field['fieldRef']}`；原始欄位：`{field['rawField']}`。",
             f"- 單位：{field['unit']}。", f"- 官方意思／白話說明：{field['meaning']}",
             f"- 資料間隔與有效範圍：{field['interval']}", f"- 核對狀態：{field['verification']}"]
    if field.get('meaningCheckedAt'):
        lines.append(f"- 官方意思核對日期：{field['meaningCheckedAt']}。")
    lines.extend('- 意義補充：' + detail for detail in field.get('officialDetails', []))
    for item in field.get('auditItems', []):
        if item['remaining']:
            lines.append('- 仍待確認：' + item['remaining'])
    if field.get('coverage'):
        if any('startHour' in segment for coverage in field['coverage'] for segment in coverage['segments']):
            lines.extend(['', '相對範圍以這版產品預報起點為 0 小時；不是從此刻倒數。'])
        lines.extend(['', '| 來源 | 相對範圍 | 資料間隔 | 說明 |', '| --- | --- | --- | --- |'])
        for coverage in field['coverage']:
            for segment in coverage['segments']:
                lines.append('| ' + ' | '.join(map(cell, [coverage['sourceName'], relative_range(segment), segment['label'], segment.get('note', '') or ('時間點資料' if segment['kind'] == 'point' else '時段資料')])) + ' |')
    for source in field['sourceInfo']:
        lines.extend([f"- 來源：{source['name']}。", f"  - 官方更新：{source['officialUpdate']}",
                      f"  - 我們的取得方式：{source['plannedCheck']}（規劃，尚非已啟用收集服務）。",
                      f"  - 來源有效範圍：{source['validRange']}"])
    lines.extend(['', '| 地點 | 樣本時間／起訖 | 官方原始值 |', '| --- | --- | --- |'])
    for sample in field['rawSamples']:
        stamp = sample['time'] + (' ～ ' + sample['end'] if sample.get('end') else '')
        lines.append(f"| {cell(sample['location'])} | {cell(stamp)} | {cell(json_text(sample['raw']))} |")
    if not field['rawSamples']:
        lines.append('| — | — | 尚無原始樣本／需自行紀錄，沒有官方直接值 |')
    for lookup in field['lookups']:
        lines.extend(['', f"**{lookup['title']}：{lookup['status']}**", '', '| 原始值／範圍 | 意思 |', '| --- | --- |'])
        lines.extend(f'| {cell(code)} | {cell(meaning)} |' for code, meaning in lookup['rows'])
        lines.extend(['', lookup['note']])
        lines.extend(f"- [{ref['title']}]({ref['url']})" for ref in lookup['references'])
    lines.extend(['', '官方依據：' + '、'.join(f"[{ref['title']}]({ref['url']})" + ('（' + ref['locator'] + '）' if ref.get('locator') else '') for ref in field['references']), ''])
    return '\n'.join(lines)


def render_reference(catalog, kind):
    doc = catalog['documentation'][kind]
    source_ids = set(doc['sourceIds'])
    lines = [f"# {doc['title']}", '',
             f"更新日期：{catalog['updatedAt']}；共用資料版本：`{catalog['revision']}`。時間皆為 Asia/Taipei。", '',
             '> 本文件由「資料目錄.json」產生。欄位、原始值、時間規則與官方意思請修改共用目錄，再於確認頁按「更新資料說明」或儲存選擇；也可在專案根目錄執行 `python "資料規劃/中央氣象署/shared_catalog.py"`。維護方式見 [維護方式](../維護方式.md)。', '',
             f"樣本取得時間：{catalog['snapshot']['capturedAt']}。{catalog['snapshot']['notice']}", '', '## 核對範圍與限制', '']
    lines.extend('- ' + note for note in doc['notes'])
    lines.extend(['', '## 來源、間隔與更新方式', '', '| 來源 | 資料間隔 | 官方更新 | 我們預計多久檢查 | 本版有效範圍 | 授權碼 |', '| --- | --- | --- | --- | --- | --- |'])
    for sid in doc['sourceIds']:
        source = catalog['sources'][sid]
        values = [source['name'], source['interval'], source['officialUpdate'], source['plannedCheck'], source['validRange'], '需要' if source['apiKeyRequired'] else '不需要']
        lines.append('| ' + ' | '.join(map(cell, values)) + ' |')
    lines.extend(['', '資料間隔、官方發布頻率、我們的檢查頻率是三件事；尚待查明的規則保留「待確認」。', '',
                  '官方意思的查核結果、尚未解決的規格矛盾與完整地區代碼對照，見 [官方意思核對紀錄](./官方意思核對紀錄.md)。', '', '## 原始欄位、樣本與意思', ''])
    # Resolve every binding, then emit each source/context variant only once.
    emitted = set()
    for section in resolve_sections(catalog):
        for field in section['fields']:
            matching_sources = {s['id'] for s in field['sourceInfo']} & source_ids
            if not matching_sources:
                continue
            sample_signature = json_text(field['rawSamples'])
            key = (field['fieldRef'], tuple(sorted(matching_sources)), sample_signature)
            if key in emitted:
                continue
            emitted.add(key)
            lines.append(field_markdown(field))
    if kind == 'gt':
        lines.extend(['## 過去 24 小時原始表格樣本', '', '| 地點 | 資料時間 | 整理自官方 HTML 的顯示值 |', '| --- | --- | --- |'])
        for sample in catalog['historySamples']:
            lines.append(f"| {cell(sample['location'])} | {cell(sample['time'])} | {cell(json_text(sample['raw']))} |")
        lines.extend(['', '這是表格顯示文字，不是 JSON API 欄位；資料時間為整點。', ''])
    lines.extend(['## 官方來源', ''])
    ref_ids = dict.fromkeys(r for sid in doc['sourceIds'] for r in catalog['sources'][sid]['referenceIds'])
    lines.extend(f"- [{catalog['references'][r]['title']}]({catalog['references'][r]['url']})" for r in ref_ids)
    other = '未來整包.md' if kind == 'gt' else '鄉鎮市GT.md'
    lines.extend(['', f'另一份資料說明：[ {other} ](./{other})。', '使用與保存規劃另見 [預計使用資料與紀錄方式](../預計使用資料與紀錄方式.md)。', ''])
    return '\n'.join(lines)


def render_audit(catalog):
    audit = catalog.get('verificationAudit', {})
    items = audit.get('items', [])
    statuses = {'confirmed': '已確認', 'partial': '部分確認', 'unresolved': '仍有矛盾'}
    lines = ['# 官方意思核對紀錄', '', f"核對日期：{audit.get('checkedAt', '尚未核對')}；共用資料版本：`{catalog['revision']}`。", '',
             '> 由「資料目錄.json」產生；已確認與仍待確認分開記錄。更新此文件不會改動勾選與備註。操作說明見 [維護方式](../維護方式.md)。', '',
             audit.get('scope', ''), '', '## 核對重點', '', '| 項目 | 狀態 | 結果 | 仍待確認 |', '| --- | --- | --- | --- |']
    for item in items:
        lines.append('| ' + ' | '.join(map(cell, [item['title'], statuses[item['status']], item['finding'], item['remaining'] or '此項已釐清'])) + ' |')
    lines.extend(['', '## 各項依據與處理方式', ''])
    for item in items:
        lines.extend([f"### {item['title']}（{statuses[item['status']]}）", '', '- 原先未確認：' + item['before'],
                      '- 本次查到：' + item['finding'], '- 使用方式：' + item['handling']])
        if item['remaining']:
            lines.append('- 尚未解決：' + item['remaining'])
        lines.extend(['', '相關共用欄位：' + '、'.join('`' + key + '`' for key in item['fieldRefs']), ''])
        for key in item['referenceIds']:
            ref = catalog['references'][key]
            lines.append(f"- [{ref['title']}]({ref['url']})" + ('：' + ref['locator'] if ref.get('locator') else ''))
        lines.append('')
    lines.extend(['## 完整天氣代碼與風級表在哪裡', '',
                  '天氣代碼、舒適度、蒲福風級、紫外線與缺值規則都存於共用目錄的 `lookups`。完整代碼表可在 [未來整包](./未來整包.md) 對應欄位，或選擇頁的「完整原始樣本與代號對照」查看。', '',
                  '## 368 鄉鎮地點代碼對照', '',
                  '下表由官方選單與已下載整包，按「縣市＋鄉鎮名稱」逐一匹配。保存對照，不把代碼差異推成通用補零公式；座標為官方預報代表點。', '',
                  '| 縣市 | 鄉鎮 | 官網／GT ID | 預報 Geocode | 緯度 | 經度 |', '| --- | --- | --- | --- | --- | --- |'])
    for row in catalog.get('lookups', {}).get('townCodes', {}).get('locations', []):
        lines.append('| ' + ' | '.join(map(cell, [row['county'], row['name'], '`'+row['gtId']+'`', '`'+row['forecastGeocode']+'`', row['latitude'], row['longitude']])) + ' |')
    lines.extend(['', '## 本次查閱版本', '', '雜湊只用來辨識本次查閱的檔案；不是官方修訂序號。PDF 頁數是檔案頁次，與紙面印刷頁碼可能不同。', '',
                  '| 官方來源 | 核對日期 | 查閱位置 | SHA-256（有保存來源檔者） |', '| --- | --- | --- | --- |'])
    for ref in catalog['references'].values():
        if ref.get('checkedAt'):
            lines.append('| ' + ' | '.join(map(cell, [f"[{ref['title']}]({ref['url']})", ref['checkedAt'], ref.get('locator', ''), ref.get('sha256', '—')])) + ' |')
    return '\n'.join(lines) + '\n'


def render_plan(selection, catalog):
    saved_at = selection.get('savedAt', '尚未手動儲存；由現有選擇產生')
    lines = ['# 畫面資料規劃', '', f'選擇儲存時間：{saved_at}', f"共用資料版本：`{catalog['revision']}`；更新日期：{catalog['updatedAt']}。", '',
             '> 本文件依「選擇結果.json」與「../中央氣象署/資料目錄.json」產生。請在選擇網頁修改勾選與備註；本文件為輸出，不作為另一份欄位來源。操作說明見 [維護方式](../維護方式.md)。', '',
             catalog['snapshot']['notice'], '', '官方意思查核與待確認事項：[官方意思核對紀錄](../中央氣象署/官方意思核對紀錄.md)。', '', '## 整體備註', '', selection['globalNote'] or '無', '']
    for section in resolve_sections(catalog):
        choices = selection['sections'][section['id']]
        lines.extend([f"## {section['name']}", '', section['subtitle'], '', section['caption'], '', '區塊備註：', '', choices['note'] or '無', '', '| 項目 | 主畫面 | 詳細頁 | 備註 |', '| --- | --- | --- | --- |'])
        included = []
        for field in section['fields']:
            fid = field['id']
            if fid in choices['home'] or fid in choices['detail'] or choices['notes'].get(fid, ''):
                included.append(field)
                lines.append(f"| {cell(field['name'])} | {'✓' if fid in choices['home'] else '—'} | {'✓' if fid in choices['detail'] else '—'} | {cell(choices['notes'].get(fid, '') or '無')} |")
        if not included:
            lines.append('| 尚未選擇 | — | — | 無 |')
        lines.extend(['', '### 已選項目與有備註項目的資料依據', ''])
        for field in included:
            lines.append(field_markdown(field).replace('### ', '#### ', 1))
        # Include all stored field notes verbatim, even notes on unselected fields.
        notes = [(fid, note) for fid, note in choices['notes'].items() if note]
        if notes:
            lines.extend(['### 逐項備註原文', ''])
            for fid, note in notes:
                name = next(f['name'] for f in section['fields'] if f['id'] == fid)
                lines.extend([f'**{name}**', '', note, ''])
    return '\n'.join(lines)


def write_transaction(outputs):
    """Stage every file before replacements; restore prior bytes on a failed commit."""
    with WRITE_LOCK:
        staged, originals, replaced = {}, {}, []
        try:
            for target, content in outputs.items():
                target = Path(target)
                originals[target] = target.read_bytes() if target.exists() else None
                fd, name = tempfile.mkstemp(prefix='.' + target.name + '-', suffix='.tmp', dir=target.parent)
                with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
                staged[target] = Path(name)
            for target, pending in staged.items():
                os.replace(pending, target)
                replaced.append(target)
        except OSError:
            for target in reversed(replaced):
                previous = originals[target]
                if previous is None:
                    target.unlink(missing_ok=True)
                else:
                    target.write_bytes(previous)
            raise
        finally:
            for pending in staged.values():
                pending.unlink(missing_ok=True)


def sync_documents(selection, catalog, workspace=None, save_selection=False):
    root = Path(workspace or WORKSPACE)
    clean = validate_selection(selection, catalog)
    if 'savedAt' in selection:
        clean['savedAt'] = checked_text(selection['savedAt'], 100)
    clean['catalogRevision'] = catalog['revision']
    outputs = {
        root / '中央氣象署/鄉鎮市GT.md': render_reference(catalog, 'gt'),
        root / '中央氣象署/未來整包.md': render_reference(catalog, 'forecast'),
        root / '欄位選擇/畫面資料規劃.md': render_plan(clean, catalog),
        root / '中央氣象署/官方意思核對紀錄.md': render_audit(catalog),
    }
    if save_selection:
        outputs[root / '欄位選擇/選擇結果.json'] = json.dumps(clean, ensure_ascii=False, indent=2) + '\n'
    write_transaction(outputs)
    return clean


if __name__ == '__main__':
    catalogue = load_catalog()
    selection_path = WORKSPACE / '欄位選擇/選擇結果.json'
    if not selection_path.exists():
        selection_path = WORKSPACE / '欄位選擇/initial-selection.json'
    selected = json.loads(selection_path.read_text(encoding='utf-8-sig'))
    sync_documents(selected, catalogue)
    print('已更新來源說明、官方意思核對紀錄與畫面資料規劃；既有勾選與備註未變更。')
