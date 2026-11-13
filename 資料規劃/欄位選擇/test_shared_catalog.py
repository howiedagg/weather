import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('shared_catalog', ROOT / '中央氣象署/shared_catalog.py')
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)


class SharedCatalogueTest(unittest.TestCase):
    def setUp(self):
        self.catalog = shared.load_catalog()
        self.selection = json.loads((ROOT / '欄位選擇/選擇結果.json').read_text(encoding='utf-8'))

    def test_existing_choices_and_all_notes_survive(self):
        self.selection['globalNote'] = '整體備註\n第二行'
        self.selection['sections']['now']['note'] = '保持目前資訊'
        self.selection['sections']['now']['notes']['rain'] = '雨量 | 有值\n只在有雨時'
        self.selection['sections']['now']['notes']['fahrenheit'] = '未選的欄位也要保留備註'
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / '中央氣象署').mkdir()
            (root / '欄位選擇').mkdir()
            shared.sync_documents(self.selection, self.catalog, root, save_selection=True)
            restored = json.loads((root / '欄位選擇/選擇結果.json').read_text(encoding='utf-8'))
            self.assertEqual(restored['sections'], self.selection['sections'])
            self.assertEqual(restored['globalNote'], self.selection['globalNote'])
            plan = (root / '欄位選擇/畫面資料規劃.md').read_text(encoding='utf-8')
            for fragment in ('雨量 \\| 有值<br>只在有雨時', '未選的欄位也要保留備註', '官方原始值', '官方更新', '我們的取得方式', '核對狀態'):
                self.assertIn(fragment, plan)

    def test_one_source_change_updates_ui_and_both_outputs(self):
        self.catalog['fields']['gt.temp']['officialMeaning'] = '共用說明測試'
        self.catalog['sources']['gt']['plannedCheck'] = '共用取得頻率測試'
        ui = shared.resolve_sections(self.catalog)
        field = next(f for f in ui[0]['fields'] if f['id'] == 'temp')
        self.assertEqual(field['meaning'], '共用說明測試')
        self.assertEqual(field['sourceInfo'][0]['plannedCheck'], '共用取得頻率測試')
        for text in (shared.render_reference(self.catalog, 'gt'), shared.render_plan(self.selection, self.catalog)):
            self.assertIn('共用說明測試', text)
            self.assertIn('共用取得頻率測試', text)

    def test_stable_ids_and_raw_values(self):
        sections = shared.resolve_sections(self.catalog)
        self.assertEqual([len(s['fields']) for s in sections], [49, 17, 25])
        for section in sections:
            self.assertEqual(len({f['id'] for f in section['fields']}), len(section['fields']))
            for f in section['fields']:
                self.assertTrue(f['rawField'])
                self.assertTrue(f['verification'])
                self.assertTrue(f['sourceInfo'][0]['officialUpdate'])
                self.assertTrue(f['sourceInfo'][0]['plannedCheck'])
        code = next(f for f in sections[1]['fields'] if f['id'] == 'code')
        self.assertEqual(code['rawSamples'][0]['raw']['WeatherCode'], '04')
        self.assertIn('完整天氣代碼', code['verification'])

    def test_official_code_tables_keep_all_aliases_and_uncertainties(self):
        weather = shared.resolve_lookup(self.catalog, 'weather')
        self.assertEqual(len(weather['rows']), 41)
        self.assertEqual(sum(len(text.split('；')) for _, text in weather['rows']), 353)
        self.assertNotIn('40', dict(weather['rows']))
        self.assertIn('短暫雨', dict(weather['rows'])['08'])
        self.assertEqual(dict(weather['rows'])['04'], '多雲')
        wind = dict(shared.resolve_lookup(self.catalog, 'wind')['rows'])
        self.assertTrue(set(map(str, range(18))).issubset(wind))
        self.assertIn('沒有提供確切風級', wind['>= 6'])
        comfort = dict(shared.resolve_lookup(self.catalog, 'comfort')['rows'])
        self.assertEqual(comfort['0～9'], '非常寒冷')
        self.assertIn('矛盾', comfort['10'])
        issues = self.catalog['verificationAudit']['items']
        self.assertEqual(next(x for x in issues if x['id'] == 'comfort-boundary')['status'], 'unresolved')
        for item in issues:
            self.assertTrue(item['referenceIds'])
            for key in item['referenceIds']:
                self.assertTrue(self.catalog['references'][key]['url'].startswith('https://'))
            for key in item['fieldRefs']:
                self.assertIn(key, self.catalog['fields'])

    def test_geographic_crosswalk_is_complete_and_not_a_padding_formula(self):
        lookup = shared.resolve_lookup(self.catalog, 'townCodes')
        rows = lookup['locations']
        self.assertEqual(len(rows), 368)
        self.assertEqual(len({row['gtId'] for row in rows}), 368)
        self.assertEqual(len({row['forecastGeocode'] for row in rows}), 368)
        taipei = next(row for row in rows if row['county'] == '臺北市' and row['name'] == '中正區')
        self.assertEqual((taipei['gtId'], taipei['forecastGeocode']), ('6300500', '63000050'))
        self.assertEqual(len(lookup['rows']), 368)
        field = self.catalog['fields']['meta.geo']
        self.assertEqual(field['samples'][0]['raw']['Latitude'], taipei['latitude'])
        for key in ['meta.location','meta.geo','meta.time','meta.version']:
            for sample in self.catalog['fields'][key]['samples']:
                self.assertTrue(sample['time'].startswith('2026-11-12'))
        sections = shared.resolve_sections(self.catalog)
        wind = next(f for f in sections[2]['fields'] if f['id'] == 'wind')
        self.assertIn('最大風速', wind['meaning'])
        self.assertTrue(wind['officialDetails'])

    def test_document_refresh_does_not_replace_user_selection_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / '中央氣象署').mkdir()
            (root / '欄位選擇').mkdir()
            self.selection['sections']['now']['notes']['rain'] = '保留原本備註\n第二行'
            target = root / '欄位選擇/選擇結果.json'
            original = json.dumps(self.selection, ensure_ascii=False, indent=4).encode('utf-8')
            target.write_bytes(original)
            shared.sync_documents(self.selection, self.catalog, root)
            self.assertEqual(target.read_bytes(), original)
            audit = (root / '中央氣象署/官方意思核對紀錄.md').read_text(encoding='utf-8')
            self.assertIn('353 組中文描述', audit)
            self.assertIn('指數恰為 10', audit)

    def test_bad_choice_does_not_discard_notes(self):
        self.selection['sections']['now']['notes']['removed'] = '保留這段備註'
        with self.assertRaises(ValueError):
            shared.validate_selection(self.selection, self.catalog)

    def test_relative_coverage_preserves_different_intervals_and_missing(self):
        sections = shared.resolve_sections(self.catalog)
        hourly = {f['id']: f for f in sections[1]['fields']}
        temp = hourly['temp']['coverage'][0]['segments']
        self.assertEqual([(s['stepHours'], s['startHour'], s['endHour']) for s in temp], [(1, 0, 36), (3, 36, 93)])
        self.assertEqual(hourly['pop']['coverage'][0]['segments'][0]['endHour'], 96)
        weekly = {f['id']: f for f in sections[2]['fields']}
        night, daily = weekly['avgTemp']['coverage']
        self.assertEqual([(s['stepHours'], s['startHour'], s['endHour']) for s in night['segments']], [(6, 0, 6), (12, 6, 162)])
        self.assertEqual([(s['stepHours'], s['startHour'], s['endHour']) for s in daily['segments']], [(12, 0, 12), (24, 12, 156)])
        self.assertFalse(weekly['pop12']['coverage'][0]['segments'][-1]['valid'])
        self.assertEqual(weekly['pop12']['coverage'][0]['segments'][-1]['startHour'], 66)
        self.assertEqual(weekly['pop24']['coverage'][0]['segments'][-1]['startHour'], 60)
        uv = weekly['uv']['coverage'][0]['segments']
        self.assertEqual(uv[-1]['kind'], 'daytime')
        self.assertIn('夜間沒有資料', uv[-1]['note'])
        self.assertEqual(shared.relative_range(temp[0]), '前 36 小時')
        self.assertEqual(shared.relative_range(temp[1]), '第 36～93 小時')

    def test_failed_multi_file_save_restores_previous_outputs(self):
        with tempfile.TemporaryDirectory() as folder:
            paths = [Path(folder) / 'a.json', Path(folder) / 'b.md']
            for path in paths:
                path.write_text('原本的內容', encoding='utf-8')
            replace = shared.os.replace
            calls = 0

            def fail_second(source, target):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError('模擬寫入失敗')
                return replace(source, target)

            with patch.object(shared.os, 'replace', side_effect=fail_second):
                with self.assertRaises(OSError):
                    shared.write_transaction({p: '新的內容' for p in paths})
            for path in paths:
                self.assertEqual(path.read_text(encoding='utf-8'), '原本的內容')
            self.assertFalse(list(Path(folder).glob('*.tmp')))


if __name__ == '__main__':
    unittest.main()
