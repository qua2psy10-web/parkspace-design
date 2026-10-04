import { defineConfig } from 'vite';

// GitHub Pages のサブパスでも動くよう相対パスで出力する
export default defineConfig({
  base: './',
  build: {
    // exceljs（約0.9MB）は Excel 保存時にだけ読み込む別ファイルなので警告の上限を上げる
    chunkSizeWarningLimit: 1000,
  },
});
