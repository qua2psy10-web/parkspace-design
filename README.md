# parkspace-design

地図上で範囲を指定すると、駐車場のブロック割（駐車マス・車路の配置）を自動で作成する Web アプリ。

- 仕様: [docs/20261004_駐車場ブロック割仕様書.md](docs/20261004_駐車場ブロック割仕様書.md)
- Google Maps APIキーの取り方: [docs/20261004_GoogleMapsAPIキー取得手順.md](docs/20261004_GoogleMapsAPIキー取得手順.md)

## 使い方

1. 住所で移動し、「範囲を描く」で敷地の角を順にクリック
2. 必要に応じて「障害物を追加」「出入口を追加」、大型車・バイク・自転車は「エリアを追加」
3. 車種ごとの寸法条件を確認して「自動割付を実行」
4. エリアごとに案を選び、「DXFを保存」「Excel集計表を保存」
5. 「案件を保存」で案件ファイル（.parking.json）に保存し、「案件を開く」で再開

## 開発

```sh
npm install
npm run dev     # http://localhost:5173/
npm test        # 単体テスト
npm run build   # dist/ に出力
```

`main` ブランチに入ると GitHub Actions で GitHub Pages に公開される
（リポジトリの Settings → Pages → Source を「GitHub Actions」にしておく）。

## 構成

| パス | 内容 |
|---|---|
| `src/main.ts` | 画面の組み立て |
| `src/map/` | 地図（Google / 地理院地図）、敷地の描画・編集 |
| `src/geo/` | 平面直角座標変換、図形計算 |
| `src/layout/standards.ts` | 寸法の初期値、駐車方式ごとのマス形状 |
| `src/layout/generator.ts` | 自動割付（1エリア分） |
| `src/layout/areas.ts` | 敷地をエリアに分け、接続口を決めて車種ごとに割付 |
| `src/layout/summary.ts` | マス番号・台数・区画外周延長の集計 |
| `src/project.ts` | 案件ファイルの保存・読込 |
| `src/export/dxf.ts` | DXF 出力 |
| `src/export/xlsx.ts` | Excel 集計表 |
