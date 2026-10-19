# fox-voice-editor

Linux側で録音して日本語の文字起こし結果だけをFirefox拡張へ返します。認識結果をブロックとして蓄積し、タッチで組み立てます。現行仕様は `fox-voice-editor_仕様書_v0.1.3.md` を参照してください。

## 前提

- FirefoxはNative Messagingに対応するLinux版を使う。
- `arecord`と`ffmpeg`が利用できる。
- このリポジトリと`whisper.cpp`が同じ親ディレクトリにある。
- `whisper.cpp/build/bin/whisper-cli`と`whisper.cpp/models/ggml-base.bin`が存在する。

## 起動

1. `python3 scripts/install_host.py`でユーザー単位のNative Host定義を登録する。定義は現在のリポジトリ内のHostを参照するため、試作中はリポジトリを移動しない。
2. Firefoxの`about:debugging`から`extension/manifest.json`を一時読み込みする。
3. ツールバーボタンで専用タブを開く。既存の専用タブがあれば、そのタブを前面に出す。

以前の録音・文字起こしだけの試作画面で表示した結果は保存されていません。新しい拡張を`about:debugging`で再読み込みし、編集タブも再読み込みしてから使ってください。新しい画面で作ったブロックと履歴は`browser.storage.local`へ保存します。

## 編集

- 編集と履歴は横並びの2ペイン。狭い画面では縦に並ぶ。
- 「録音開始」で末尾にブロックを作る。録音中は同じボタンが「録音停止」に切り替わる。
- ブロックは横に並び、幅が足りなくなると折り返す。ドラッグで順序を変え、短くタップすると操作メニューを開く。
- ブロックの「前へ挿入」「後ろへ挿入」は、履歴で語句を選択中ならその語句を挿入し、未選択なら指定位置への録音を開始する。履歴の同じ語句を再タップすると選択解除できる。
- ブロックの「再録音」は認識成功時だけ置換する。失敗・キャンセル時は元の文字列を保持する。録音中・認識中は編集操作を止める。
- 履歴の「…」からピン留め・履歴削除を行う。初期状態には助詞などの定型句を含む。
- 履歴は暫定500件。古い通常履歴から自動削除し、ピン留め項目は保持する。履歴削除は既存ブロックへ影響しない。
- プレビューとコピーはブロックを区切りなしで連結した同じ文字列を使う。

録音は最大30秒で自動停止します。結果には、停止ボタンから結果表示までの時間、Hostが停止指示を受けてから結果を送るまでの時間、whisper.cppが報告するモデル読み込み時間を分けて表示します。`whisper-cli`は録音ごとに新規起動するため、Host処理時間には毎回のモデル読み込みが含まれます。録音・変換・文字起こしには一時ファイルを使い、終了・キャンセル・接続断時に削除します。

## 通信

`connectNative("fox_voice_editor")`で持続接続します。Firefoxから送る固定アクションは`start_recording`、`stop_recording`、`cancel_recording`、`get_status`です。Native Hostは録音ごとに`recordingId`を発行し、結果・エラーにも同じIDを付けます。ブロックIDや挿入位置はHostへ送信しません。音声データはFirefoxを経由しません。

この試作の拡張IDは`fox-voice-editor@foxbook.example`です。正式なIDは後で決めます。

## ローカル検証

```bash
node tests/test_model.mjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
```
