# fox-voice-editor

Linux側で録音して日本語の文字起こし結果だけをFirefox拡張へ返します。認識結果をブロックとして蓄積し、タッチで組み立てます。現行仕様は `fox-voice-editor_仕様書_v0.1.7.md` を参照してください。

## 前提

- FirefoxはNative Messagingに対応するLinux版を使う。
- `arecord`と`ffmpeg`が利用できる。
- このリポジトリと`whisper.cpp`が同じ親ディレクトリにある。
- `whisper.cpp/build/bin/whisper-cli`と`whisper.cpp/models/ggml-base.bin`が存在する。
- B・Cの時間計測には、同じ親ディレクトリの`whisper.cpp`を`cmake --build ../whisper.cpp/build --target whisper-cli -j2`で再ビルドしたバイナリを使う。旧バイナリでも録音・認識はできるが、B・Cは「計測不可」と表示される。
- ReazonSpeechを選ぶ端末では、このリポジトリと`reazonspeech`を同じ親ディレクトリに置き、`reazonspeech/.venv/bin/python`に`sherpa-onnx`を導入する。モデルは`reazonspeech/`直下のINT8 encoder・joiner、通常版decoder、`tokens.txt`を使う。拡張から実行ファイルやモデルのパスは指定できない。

## 起動

1. `python3 scripts/install_host.py`でユーザー単位のNative Host定義を登録する。定義は現在のリポジトリ内のHostを参照するため、試作中はリポジトリを移動しない。
2. Firefoxの`about:debugging`から`extension/manifest.json`を一時読み込みする。
3. ツールバーボタンで専用タブを開く。既存の専用タブがあれば、そのタブを前面に出す。

接続時にマイクを確認し、成功するまで録音ボタンを無効にします。初期状態ではマイクブースト補正は無効なので、ミキサーの読み書きは行わず録音できます。

編集画面でWhisper baseとReazonSpeech K2 INT8を選択できます。未設定時はWhisperです。ReazonSpeechを選ぶと編集セッション中にWorkerを一度初期化し、録音ごとに再利用します。マイクとモデルの両方が準備できるまで録音できません。準備失敗時は再試行またはWhisperへの切替ができます。選択は`browser.storage.local`に保存されます。

Surface Pro 4で補正を使う場合は、**Surface上で**次を実行して端末ローカルの設定を有効にしてください。

```bash
mkdir -p "$HOME/.config/fox-voice-editor"
printf '{"boost_fix": true}\n' > "$HOME/.config/fox-voice-editor/microphone.json"
```

対象はコード内で `PCH` の `Internal Mic Boost` を整数値 `0` に固定しています。設定ファイルがない場合は無効で、画面には「マイク補正は無効」と表示されます。設定後は編集画面の「マイクを再確認」を押し、画面に「ブースト値を0へ補正」が出たら `amixer -c PCH sget 'Internal Mic Boost'` で左右の値が0になったことを確認してください。再確認で変化しない場合は、画面の状態表示と `cat "$HOME/.config/fox-voice-editor/microphone.json"` の結果を確認します。WirePlumber再起動後などにノイズを感じた場合も同じボタンで再確認してください。録音開始のたびには自動確認しません。

以前の録音・文字起こしだけの試作画面で表示した結果は保存されていません。新しい拡張を`about:debugging`で再読み込みし、編集タブも再読み込みしてから使ってください。新しい画面で作ったブロックと履歴は`browser.storage.local`へ保存します。

## 編集

- 編集と履歴は横並びの2ペイン。狭い画面では縦に並ぶ。
- 「録音開始」で末尾にブロックを作る。録音中は同じボタンが「録音停止」に切り替わる。ブロックメニューから録音は開始しない。
- ブロックは横に並び、幅が足りなくなると折り返す。ドラッグで順序を変える。短くタップすると選択に追加し、別のブロックも続けて選べる。選択中のブロックを再タップすると、その1件を解除する。
- ブロックメニューの「削除」は選択中の全ブロックに一括で適用する。複数選択時は「選択解除（すべて）」も表示する。履歴と左のブロックをそれぞれちょうど1件選択している時だけ「前へ挿入」「後ろへ挿入」を表示し、選択した履歴語句を対象ブロックの前後に追加する。
- 録音中・認識中は編集操作を止める。認識失敗・キャンセル時は既存ブロックを変更しない。
- 履歴も語句をブロックとして横に並べ、画面端で折り返す。ピン留め語句を先に並べ、最後のピン留め語句の後で改行して通常履歴を並べる。
- 履歴ブロックをタップすると選択に追加し、続けて別の語句をタップすると複数選択できる。選択中の語句を再タップすると解除する。操作メニューは共有の1つで、選択中の全件をまとめてピン留め／解除、または履歴から削除する。ピン留め・解除を実行した後は選択も解除する。複数選択時は「選択解除（すべて）」を表示する。ピン留め済みと未指定が混在する場合は全件をピン留めする。語句ごとの「…」ボタンは設けない。初期状態には助詞などの定型句を含む。
- 履歴は暫定500件。古い通常履歴から自動削除し、ピン留め項目は保持する。履歴削除は既存ブロックへ影響しない。
- プレビューとコピーはブロックを区切りなしで連結した同じ文字列を使う。

録音は最大30秒で自動停止します。WhisperではA「録音停止〜音声変換完了」、B「whisper-cli起動〜モデル読み込み完了」、C「モデル読み込み完了〜認識終了」、停止ボタンから結果表示までの総時間、使用モデル名を表示します。B・CはCLIの単調時計マーカーから算出します。Whisperは多言語`ggml-base.bin`・`-l ja`で、録音ごとにCLIを新規起動します。ReazonSpeechではモデル準備時間を録音前に表示し、録音ごとのA・推論時間・停止から結果表示までの総時間を表示します。録音・変換・文字起こしには一時ファイルを使い、終了・キャンセル・接続断時に削除します。

## 通信

`connectNative("fox_voice_editor")`で持続接続します。Firefoxから送る固定アクションは`prepare_microphone`、`prepare_engine`、`start_recording`、`stop_recording`、`cancel_recording`、`get_status`です。`prepare_engine`の引数は`whisper`／`reazonspeech_k2`だけです。Native Hostは接続ごとにマイク確認とエンジン準備の状態を保持し、それらが成功するまで録音開始を拒否します。録音ごとに`recordingId`を発行し、結果にはエンジン名と世代番号も付けます。ブロックIDや挿入位置はHostへ送信しません。音声データはFirefoxを経由しません。

この試作の拡張IDは`fox-voice-editor@foxbook.example`です。正式なIDは後で決めます。

## ローカル検証

```bash
node tests/test_model.mjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
python3 tests/check_reazon_worker.py
```
