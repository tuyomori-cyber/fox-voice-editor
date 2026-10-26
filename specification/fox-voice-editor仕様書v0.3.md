# fox-voice-editor 仕様書 v0.3

- 文書バージョン：0.3
- 作成日：2026-10-26
- 状態：現行実装ベース
- 対象：Firefox拡張、Native Messaging Host、Whisper／ReazonSpeech、Focodex、FX-OSK

## 1. 目的と境界

fox-voice-editorは、ローカル音声認識の結果、手入力、履歴、定型、固定記号を文章ブロックとしてタッチ操作で編集するFirefox拡張である。録音・変換・認識はLinux側のNative Hostが行い、Firefoxは固定制御要求と状態・認識テキストだけを交換する。音声データ、任意コマンド、任意パスは拡張から渡さない。

主対象はSurface Pro 4 / Fedora / Cage / Firefox、開発・検証環境はXubuntu / Firefoxである。認識結果を自動校正・要約せず、Focodex連携だけでCodex実行や入力欄変更を行わない。

## 2. 構成と固定通信

| 要素 | 責務 |
| --- | --- |
| `extension/` | 編集画面、状態保存、Focodex・FX-OSK連携。試作IDは`fox-voice-editor@foxbook.example`。 |
| `native_host/fox_voice_editor.py` | 録音、WAV変換、Whisper実行、ReazonSpeech Worker管理、ライブラリ正本の原子的保存。 |
| `native_host/reazon_worker.py` | K2 INT8モデルを接続中に一度初期化し、連続認識で再利用する。 |
| `scripts/install_host.py` | 現在のリポジトリを指すユーザー単位Native Host定義を登録する。 |

Host名は`fox_voice_editor`。許可する要求は`prepare_microphone`、`prepare_engine`、`start_recording`、`stop_recording`、`cancel_recording`、`get_status`、`load_library`、`save_library`だけである。`prepare_engine`は`whisper`または`reazonspeech_k2`だけを受け付ける。

## 3. 録音と認識

- 録音は最大30秒。マイク準備と選択エンジン準備が完了するまで開始しない。
- Whisperは`../whisper.cpp/build/bin/whisper-cli`、`../whisper.cpp/models/ggml-base.bin`、`-l ja`を用い、録音ごとにCLIを起動する。
- ReazonSpeechは`../reazonspeech/.venv/bin/python`とINT8 encoder・通常decoder・joiner・`tokens.txt`を固定位置から読む。Workerは同一Native Host接続内で再利用する。
- 成功結果は`recordingId`、エンジン、世代番号を照合して末尾ブロックと履歴へ追加する。失敗・キャンセル・空文字列は文書と履歴を変更しない。
- Surface固有のマイク補正は`~/.config/fox-voice-editor/microphone.json`の`{"boost_fix": true}`を明示した場合だけ、固定対象`PCH` / `Internal Mic Boost`を0にする。

## 4. 編集と保存

通常モードでは文書・履歴・定型を複数選択できる。文書・履歴・定型はいずれも一括削除を行える。並べ替え・追加モードでは、文書をドラッグ並べ替えし、履歴・定型を新しい文書ブロックとしてドラッグ追加する。固定記号はこのモードの対象外で、記号タブのカードをタップすると常に末尾の新規文書ブロックとして追加する。履歴からのドラッグは複製であり、履歴自体の並び・使用回数・内容を変えない。

手入力は末尾ブロックへ追加するか定型へ追加でき、いずれも履歴へ登録する。プレビューとコピーは文書ブロックを区切りなしで連結する。文書と画面設定は`browser.storage.local`、履歴・定型の正本は`~/.local/share/fox-voice-editor/library-v1.json`（schema version 2、原子的保存、所有者限定権限）である。履歴・定型は各最大500件で、古い項目から削除する。旧schema version 1のピン留め履歴は読み込み時に定型へ移行する。

タブ行右端には`日本語順`／`ABC順`、`昇順`／`降順`、`Sort`を置く。履歴・定型を表示中に`Sort`を押した時だけ、Firefoxの`Intl.Collator`による選択中の照合順で対象コレクションを並べ替え、保存する。記号タブではこれらを無効化する。通常の追加・再利用では自動整列せず最後尾へ追加する。読み仮名は保持しないため、漢字の並びは厳密な五十音順ではない。

## 5. 横断連携

- Focodex：空白でない最大20,000文字のプレビューを、設定済み拡張ID（既定`focodex@foxbook.example`）へ送る。受信バッファ投入だけを依頼し、同一ID・同一本文の明示再送は重複させない。正本は[`IF-VE-FD-001`／`002`](../../foxbook/docs/interfaces/fox-voice-editor--focodex.md)。
- FX-OSK：手入力欄のフォーカス時に設定済みFX-OSK（既定`fx-osk-touch@tuyomori-cyber.github.io`）から埋め込みURLを取得する。1文字とBackspace、Delete、左右矢印、Enterだけを受け入れる。閉鎖または欄外フォーカスではiframeを破棄する。正本は[`IF-VE-OSK-001`](../../foxbook/docs/interfaces/fox-voice-editor--firefox-on-screen-keyboard.md)。
- Split View：`pagehide`ではNative Hostを明示切断せず、bfcacheからの`pageshow`時に切断済みなら再接続する。正本は[`IF-SV-001`](../../foxbook/docs/interfaces/split-view-operation.md)。

## 6. 検証と未完了

2026-10-26に、モデル12件、Focodex送信契約、FX-OSK bridge 2件、Native Host 11件、ReazonSpeech Workerの初期化・3連続認識・終了処理を確認した。Firefox実画面でのOSK表示／入力／閉鎖、Focodex実配送、Split View、左右独立スクロール、Surfaceでの連続録音・Worker回収・CPU／メモリ・認識品質は未完了である。詳細は[TODO](../TODO.md)とFoxbookの検証マトリクスで管理する。

## 7. 履歴文書

v0.1〜v0.2.1の世代別仕様と旧Focodex連携記録は[old/specification/](../old/specification/)に保管する。これらは判断経緯であり、現行仕様ではない。
