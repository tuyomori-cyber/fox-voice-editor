# fox-voice-editor

Linux側で録音して日本語の文字起こし結果だけをFirefox拡張へ返します。認識結果をブロックとして蓄積し、タッチで組み立てます。現行仕様は[仕様書 v0.3](specification/fox-voice-editor仕様書v0.3.md)を参照してください。旧世代の仕様・連携検討記録は[old/specification/](old/specification/)に保管しています。

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

文書ブロックは`browser.storage.local`へ保存します。履歴と定型はNative Hostが`~/.local/share/fox-voice-editor/library-v1.json`へ保存する正本で、Firefoxの`browser.storage.local`には画面用キャッシュも置きます。Temporary Add-onを削除・再読み込みしても、同じLinuxユーザーとNative Hostを使う限り履歴・定型は復元されます。初回は既存キャッシュを正本へ移行します。

## 編集

- 編集と履歴は横並びの2ペイン。デスクトップの2ペイン表示では左右を独立してスクロールし、右ペインは「履歴／定型／記号」タブを残したまま、その下の内容だけをスクロールする。狭い画面では縦に並ぶ。
- 「録音開始」で末尾にブロックを作る。録音中は同じボタンが「録音停止」に切り替わる。ブロックメニューから録音は開始しない。
- ブロックは横に並び、幅が足りなくなると折り返す。通常時は短くタップして選択に追加し、別のブロックも続けて選べる。選択中のブロックを再タップすると、その1件を解除する。
- 「並べ替え・追加」を押すと、文書ブロックはドラッグで順序変更でき、右ペインの履歴・定型カードはブロック枠へドラッグしてその位置に新規ブロックとして追加できる。このモード中は文書・履歴・定型のタップ選択を無効化する。記号は並べ替え・追加モードの対象外で、記号タブのカードをタップすると常に文書ブロックの末尾へ追加する。記号は日本語JISキーボードで使う句読点、括弧、全角・半角の演算子／記号、通貨記号を用意し、履歴・定型には保存しない。
- ブロック枠の下にある手入力欄へフォーカスすると、設定済みのFX-OSKを欄の下へ表示し、キー入力を欄へ反映する。「追加」で入力内容を末尾の新規ブロックとして追加し、プレビューとコピーへ自動反映する。「定型へ追加」は文書を変更せず定型へ登録する。どちらも入力内容を履歴へ自動登録する。
- ブロックメニューの「削除」は選択中の全ブロックに一括で適用する。複数選択時は「選択解除（すべて）」も表示する。履歴と左のブロックをそれぞれちょうど1件選択している時だけ「前へ挿入」「後ろへ挿入」を表示し、選択した履歴語句を対象ブロックの前後に追加する。
- 録音中・認識中は編集操作を止める。認識失敗・キャンセル時は既存ブロックを変更しない。
- 接続・マイク補正・認識エンジン・計測値は「内部状態」でだけ表示する。通常画面には表示せず、認識エンジン選択の右にある同ボタンでポップアップを開いて確認する。
- 定型・履歴の正本を読み込むまで、録音と編集は開始しない。読み込み・保存に失敗した場合は、画面のエラー表示を確認する。
- 履歴も語句をブロックとして横に並べ、画面端で折り返す。履歴ブロックをタップすると選択に追加し、続けて別の語句をタップすると複数選択できる。選択中の語句を再タップすると解除する。操作メニューは共有の1つで、選択中の全件を履歴から削除できる。複数選択時は「選択解除（すべて）」を表示する。語句ごとの「…」ボタンは設けない。
- 履歴・定型は各500件まで保持し、上限を超えた時は古い項目から自動削除する。通常操作での新規・再利用項目は最後尾へ置く。履歴・定型の削除は既存文書ブロックへ影響しない。
- タブ行の右端には「日本語順／ABC順」「昇順／降順」と「Sort」を置く。履歴・定型を表示中にSortを押した時だけ、選んだブラウザ標準の照合順で表示中の項目を並べ替えて保存する。記号タブではこれらを無効化する。漢字は読み仮名を保持しないため、厳密な五十音順ではない。
- プレビューとコピーはブロックを区切りなしで連結した同じ文字列を使う。右ペインは「履歴」「定型」「記号」を切り替えられ、定型は履歴と同じカード形式で表示する。
- 定型タブでは通常モードで定型を複数選択し、共有メニューから選択中の定型だけを削除できる。削除は履歴と既存文書ブロックに影響しない。全件削除は設けない。旧データのピン留め履歴は、更新時に定型へ移行する。

録音は最大30秒で自動停止します。WhisperではA「録音停止〜音声変換完了」、B「whisper-cli起動〜モデル読み込み完了」、C「モデル読み込み完了〜認識終了」、停止ボタンから結果表示までの総時間、使用モデル名を表示します。B・CはCLIの単調時計マーカーから算出します。Whisperは多言語`ggml-base.bin`・`-l ja`で、録音ごとにCLIを新規起動します。ReazonSpeechではモデル準備時間を録音前に表示し、録音ごとのA・推論時間・停止から結果表示までの総時間を表示します。録音・変換・文字起こしには一時ファイルを使い、終了・キャンセル・接続断時に削除します。

## 通信

`connectNative("fox_voice_editor")`で持続接続します。Firefoxから送る固定アクションは`prepare_microphone`、`prepare_engine`、`start_recording`、`stop_recording`、`cancel_recording`、`get_status`、`load_library`、`save_library`です。`prepare_engine`の引数は`whisper`／`reazonspeech_k2`だけです。`save_library`は履歴・定型だけを固定パスへ保存します。Native Hostは接続ごとにマイク確認とエンジン準備の状態を保持し、それらが成功するまで録音開始を拒否します。録音ごとに`recordingId`を発行し、結果にはエンジン名と世代番号も付けます。ブロックIDや挿入位置はHostへ送信しません。音声データはFirefoxを経由しません。

この試作の拡張IDは`fox-voice-editor@foxbook.example`です。正式なIDは後で決めます。

## ローカル検証

```bash
node tests/test_model.mjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
python3 tests/check_reazon_worker.py
```

## Focodexへ貼り付け

プレビュー横の「Focodexへ貼り付け」で、コピーと同じ文章をFocodexの指示文欄へ渡せます。両拡張は同じFirefoxプロファイルに読み込んでください。既定の送信先は`focodex@foxbook.example`です。「拡張連携設定」ではFocodexの送信先IDとFX-OSKの拡張IDをまとめて変更・保存できます。FX-OSKの既定値は`fx-osk-touch@tuyomori-cyber.github.io`です。

Focodexは文章を最大3件のFIFO受信バッファへ保存し、入力欄を自動変更しません。ユーザーがバッファ項目の「指示文へ」を押して反映します。受信だけではCodexを実行しません。

応答を受け取れなかった場合は、「同じ文章を再送」で同じID・本文を明示再送できます。自動再送と状態照会はありません。更新後は両拡張と既存の操作タブを手動で再読み込みしてください。実装条件は[現行仕様](specification/fox-voice-editor仕様書v0.3.md)と[`IF-VE-FD-001`／`002`](../foxbook/docs/interfaces/fox-voice-editor--focodex.md)を参照してください。Firefox実配送・Split View・Surfaceタッチの確認は未実施です。

```bash
node tests/test_focodex_send.mjs
```
