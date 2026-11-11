# 氣序 · Weather Flow

無框架、無建置步驟的全前端天氣時間軸。`dist/` 可部署至任何靜態網站空間。

目前是可操作的第一版範本，預設使用合成示範資料；官方資料讀取程式已寫入，但尚未使用有效授權碼完成實際連線驗證。「氣序」及現有外觀是暫行方案。

程式碼與專案文件：[howiedagg/weather](https://github.com/howiedagg/weather)。

## 專案文件

從 [文件總覽](docs/README.md) 開始閱讀。文件分開記錄使用者需求、已實作功能、驗證範圍、設計提案，以及待確認與待驗證事項。

| 文件 | 內容 |
| --- | --- |
| [需求](docs/01-需求.md) | 使用者已提出的需求及尚未決定的細節。 |
| [畫面與操作](docs/02-畫面與操作.md) | 視覺、縮放、平移、手機與動畫方案。 |
| [氣象資料](docs/03-氣象資料.md) | 資料來源、歷史體感、全前端限制及待驗證部分。 |
| [第一版範本](docs/04-第一版範本.md) | 截圖、私人預覽、已完成項目及程式對照。 |
| [討論與決策](docs/05-討論與決策.md) | 對話結論、暫行方案與決定依據。 |
| [後續工作](docs/06-後續工作.md) | 待使用者確認與待實際驗證的集中清單。 |

## 預覽

GitHub Pages 入口：[howiedagg.github.io/weather](https://howiedagg.github.io/weather/)，已於 2026-11-11 成功上線。首頁與四個前端資源均回傳 HTTP 200，內容與本機一致；[首次成功部署](https://github.com/howiedagg/weather/actions/runs/42990462296)。最新狀態見 [Actions](https://github.com/howiedagg/weather/actions/workflows/pages.yml)。

在專案目錄執行 `python -m http.server 4173 --directory dist`，開啟 `http://localhost:4173`。

## 自動部署到 GitHub Pages

1. 在 [Settings → Pages](https://github.com/howiedagg/weather/settings/pages) 的「Build and deployment → Source」選擇 **GitHub Actions**（首次設定一次）。
2. 修改前端後推送到 `main`；變更 `dist/**`、`core.test.mjs` 或部署流程本身時，會自動執行語法檢查、核心測試並部署。
3. 只修改 `docs/`、README 等文件不會觸發部署。需要手動發布時，在 [Actions](https://github.com/howiedagg/weather/actions/workflows/pages.yml) 選擇 **Run workflow**，分支使用 `main`。
4. 手機使用同一個 Pages 網址，部署成功後重新整理即可看到新版。只在電腦上改檔案、不推送，線上網站不會更新。

流程只發布 `dist/`，不把文件、測試或部署設定當作網站內容。網站公開、不需要 ChatGPT 登入，電腦也不必保持開機。官方授權碼仍由使用者在分頁內自行輸入，不寫入 GitHub 或部署設定。GitHub Pages 不會代為持續收集氣象資料。

流程檔：[.github/workflows/pages.yml](.github/workflows/pages.yml)。首次部署若因 Pages 尚未啟用而失敗，完成來源設定後，可在該次執行選擇 **Re-run failed jobs**。

## 操作

- 圖表滾輪、雙指手勢或縮放滑桿：連續切換 1 小時至 7 天的顯示範圍。
- 左右拖曳：查看過去 7 天至未來 7 天；上下兩張圖同步。
- 下方兩週總覽：拖曳選取區移動，拖曳兩側調整範圍。
- 快速定位：過去一週、今天、3 天、一週、現在。
- 鍵盤：圖表取得焦點後，左右方向鍵平移，`+` / `-` 縮放，`Home` 回到現在。

## 資料

初始為合成示範資料，畫面會標示「示範資料／非即時氣象」。設定內可輸入中央氣象署授權碼，直接從瀏覽器存取觀測、三天／一週預報與最近 30 天歷史資料。授權碼只存在當前分頁的記憶體，未存入檔案或瀏覽器永久儲存；只傳送至中央氣象署官方端點。實際官方連線仍需使用有效授權碼驗證；歷史檔案的瀏覽器跨網站讀取與測站涵蓋可能限制可用時段。缺少官方資料時保留空白，不會混入示範資料。

歷史體感依 `AT = T + 0.33 e - 0.70 wind - 4.00` 估算，`e = RH/100 * 6.105 * exp(17.27*T/(237.7+T))`，明確標示估算。長期預報使用原始高低範圍，陰影顯示範圍，中線表示範圍中點；沒有新增預報精度。歷史與即時資料依測站，預報依對應鄉鎮，來源見資料說明。

只儲存地點偏好及已取得的官方觀測快取。關閉網頁不會繼續收集；連線時每 30 分鐘更新一次。所有日期以 Asia/Taipei 顯示。沒有自己的後端、資料庫、分析追蹤或第三方圖表依賴。Google Fonts 無法使用時會回退至裝置字型。

## 驗證

`node --test core.test.mjs`

涵蓋連續縮放與邊界、氣象署新舊預報格式、歷史／即時觀測解析、缺值與體感估算、預報區間和缺少歷史時的處理。
